#!/usr/bin/env bash
#
# Despliegue desde una maquina, sin pasar por GitHub Actions.
#
# Hace lo MISMO que `.github/workflows/deploy-aws.yml`, y a proposito: es el
# camino del primer despliegue (cuando todavia no hay secreto configurado en
# GitHub) y la salida de emergencia el dia que el pipeline no esté disponible.
# Si cambia uno, cambia el otro.
#
# Los dos stacks se despliegan antes con `cdk deploy`; esto empieza donde
# terminan ellos.
#
# Uso:
#   bash infra/scripts/deploy-local.sh all     # API y sitio (lo normal)
#   bash infra/scripts/deploy-local.sh api     # solo la API
#   bash infra/scripts/deploy-local.sh web     # solo el sitio
#   bash infra/scripts/deploy-local.sh seed    # primer administrador (una vez)
#
# Requisitos: aws cli autenticada, docker con buildx, pnpm.
set -euo pipefail

REGION="us-east-1"
BASE_STACK="courier-prod-base"
APP_STACK="courier-prod-app"
INSTANCE_TAG="courier-api"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Una consulta por salida: pedir varias a la vez las devuelve en el orden de la
# plantilla, no en el del filtro, y se cruzan los valores.
output() {
  aws cloudformation describe-stacks --stack-name "$1" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text 2>/dev/null
}

require_session() {
  aws sts get-caller-identity --output text >/dev/null 2>&1 \
    || fail "Sesion de AWS expirada. Ejecuta 'aws login' y repite."
}

# Id de la instancia por ETIQUETA, no fijo: se reemplaza cada vez que cambia su
# script de arranque y el id deja de ser el mismo.
find_instance() {
  local id
  id=$(aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=${INSTANCE_TAG}" \
              "Name=instance-state-name,Values=running" \
    --query "Reservations[].Instances[].InstanceId" --output text)
  [ -n "$id" ] && [ "$id" != "None" ] || fail "No hay ninguna instancia '${INSTANCE_TAG}' en marcha."
  printf '%s' "$id"
}

# Manda un comando a la instancia y espera de verdad a que termine. El waiter de
# la CLI se rinde a los 100 segundos y aqui hay una descarga de imagen y unas
# migraciones por delante.
run_on_instance() {
  local instance="$1" command="$2" label="$3"
  local id status="Pending"

  # MSYS_NO_PATHCONV: en Git Bash (Windows), todo argumento que empieza por "/"
  # se traduce a ruta de Windows ANTES de salir. El comando que va aqui dentro es
  # para LINUX, en la instancia, asi que `/opt/courier/deploy.sh` llegaba
  # convertido en `C:/Program Files/Git/opt/...` y el servidor respondia
  # "C:/Program: No such file or directory". Las dos variables lo desactivan solo
  # para esta llamada y no existen fuera de Windows, asi que no molestan.
  id=$(MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' \
    aws ssm send-command --region "$REGION" \
    --instance-ids "$instance" \
    --document-name AWS-RunShellScript \
    --comment "$label" \
    --parameters commands="$command" \
    --timeout-seconds 900 \
    --query "Command.CommandId" --output text)

  echo "Comando $id en $instance, esperando..."
  for _ in $(seq 1 120); do
    status=$(aws ssm get-command-invocation --region "$REGION" \
      --command-id "$id" --instance-id "$instance" \
      --query Status --output text 2>/dev/null || echo Pending)
    case "$status" in Success|Failed|Cancelled|TimedOut) break ;; esac
    sleep 10
  done

  aws ssm get-command-invocation --region "$REGION" \
    --command-id "$id" --instance-id "$instance" \
    --query StandardOutputContent --output text

  if [ "$status" != "Success" ]; then
    aws ssm get-command-invocation --region "$REGION" \
      --command-id "$id" --instance-id "$instance" \
      --query StandardErrorContent --output text >&2
    fail "El comando termino en estado $status"
  fi
}

deploy_api() {
  local repository tag instance
  repository=$(output "$BASE_STACK" EcrRepositoryUri)
  [ -n "$repository" ] || fail "No encuentro el repositorio de imagenes. ¿Esta desplegado $BASE_STACK?"

  # El commit es la etiqueta, igual que en el pipeline: la version desplegada se
  # puede rastrear hasta el codigo exacto que la produjo.
  tag=$(git -C "$REPO_ROOT" rev-parse HEAD)

  say "Publicando ${repository}:${tag:0:7}"
  aws ecr get-login-password --region "$REGION" \
    | docker login --username AWS --password-stdin "${repository%%/*}"

  # arm64 porque la instancia es Graviton. El bundle se compila en la
  # arquitectura nativa y solo se emula la etapa final (ver apps/api/Dockerfile).
  docker buildx build \
    --platform linux/arm64 \
    -f "$REPO_ROOT/apps/api/Dockerfile" \
    -t "${repository}:${tag}" \
    -t "${repository}:latest" \
    --push \
    "$REPO_ROOT"

  say "Desplegando en la instancia"
  instance=$(find_instance)
  # El script vive en la maquina: aqui solo se le dice que version quiere.
  # Aplica migraciones con la imagen nueva y reinicia el servicio.
  run_on_instance "$instance" "/opt/courier/deploy.sh ${tag}" "deploy local ${tag:0:7}"
}

deploy_web() {
  local bucket distribution
  bucket=$(output "$APP_STACK" WebBucketName)
  distribution=$(output "$APP_STACK" DistributionId)
  [ -n "$bucket" ] || fail "No encuentro el bucket del sitio. ¿Esta desplegado $APP_STACK?"

  say "Compilando el sitio"
  # Sin PUBLIC_API_BASE: en produccion la base es relativa, mismo host que la API.
  (cd "$REPO_ROOT" && pnpm --filter @courier/web build)

  say "Subiendo a s3://${bucket}"
  # Los assets llevan hash en el nombre, son inmutables y se cachean un año. El
  # HTML apunta a ellos y no se cachea nunca. En ESTE ORDEN, para que nadie
  # reciba una pagina que pida un archivo que todavia no existe.
  aws s3 sync "$REPO_ROOT/apps/web/dist" "s3://${bucket}" --delete \
    --exclude "*.html" \
    --cache-control "public, max-age=31536000, immutable"
  aws s3 sync "$REPO_ROOT/apps/web/dist" "s3://${bucket}" --delete \
    --exclude "*" --include "*.html" \
    --cache-control "no-cache"

  say "Invalidando CloudFront"
  aws cloudfront create-invalidation --distribution-id "$distribution" --paths "/*" >/dev/null
}

# El primer administrador no puede autoregistrarse (eso es solo para clientes) ni
# recibir invitacion (todavia no hay correo saliente). Se siembra una vez; el
# script es idempotente, asi que repetirlo no rompe nada.
seed_admin() {
  local instance
  instance=$(find_instance)
  say "Sembrando el primer administrador"
  echo "OJO: la contrasena se imprime UNA sola vez. Guardala."
  # SIN COMILLAS NI COMAS, y no es por gusto: `--parameters commands=...` usa la
  # sintaxis abreviada de la CLI, que parte el valor por comas y se atraganta con
  # las comillas ("Expected: ',', received: '\"'"). De ahi que la imagen se lea
  # cargando el fichero de entorno en vez de con un sed entrecomillado, y que
  # $IMAGE vaya desnudo (una URI de ECR no lleva espacios).
  run_on_instance "$instance" \
    '. /opt/courier/image.env && docker run --rm --env-file /opt/courier/api.env $IMAGE node dist/seed.js' \
    "seed admin"
}

require_session

case "${1:-all}" in
  api)  deploy_api ;;
  web)  deploy_web ;;
  seed) seed_admin ;;
  all)  deploy_api; deploy_web ;;
  *)    fail "Uso: $0 [all|api|web|seed]" ;;
esac

say "Listo"
[ "${1:-all}" = "seed" ] || echo "Sitio: $(output "$APP_STACK" SiteUrl)"
