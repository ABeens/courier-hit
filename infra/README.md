# Infraestructura (AWS CDK)

Infraestructura de HS Global Services como código. La decisión de qué servicio
hace qué y por qué está en [`docs/12-despliegue-aws.md`](../docs/12-despliegue-aws.md);
aquí está **cómo se opera**.

## Qué se despliega

Dos stacks, un entorno (producción):

| Stack | Contiene | Se puede recrear |
|-------|----------|:----------------:|
| `courier-prod-base` | VPC, RDS PostgreSQL, bucket de adjuntos, ECR, **Elastic IP** | ❌ tiene estado |
| `courier-prod-app` | Instancia EC2 de la API, CloudFront, bucket del sitio, Parameter Store, rol de despliegue | ✅ |

El modelo de cómputo es la **opción C** de docs/12 §4: una instancia EC2
`t4g.small` con Elastic IP propia. Esa IP es la que da la IP de salida fija que
exige Helga y, a la vez, el origen de CloudFront. **Vive en el stack base con
`RETAIN`**: la instancia se puede reemplazar cuantas veces haga falta sin que el
proveedor tenga que actualizar su lista blanca.

No hay NAT Gateway (32 USD/mes que aquí no compran nada) ni balanceador: la
instancia está en subred pública y solo acepta tráfico HTTP desde el rango de
CloudFront.

```
navegador ──HTTPS──> CloudFront ──┬── /*      ──> S3 (sitio, privado con OAC)
                                  └── /api/*  ──> EC2 :80 ──> RDS (subred aislada)
                                                    │
                                                    └── S3 adjuntos · SES · Helga (IP fija)
```

## Requisitos

- Sesión de AWS activa: `aws login` (la CLI ya está configurada en el equipo).
- `pnpm install` en la raíz del repo.
- Docker, solo para construir la imagen a mano; el pipeline la construye solo.

## Primer despliegue

### 1. Preparar la cuenta (una sola vez)

```bash
cd infra
pnpm exec cdk bootstrap
```

### 2. Stack base

```bash
pnpm exec cdk deploy courier-prod-base
```

Tarda unos 15 minutos (la mayor parte es RDS). Al terminar imprime la
**`ApiElasticIp`**: es el dato que hay que enviarle a Helga para su lista blanca
(docs/12 §7.3).

### 3. Cargar las credenciales

CloudFormation no sabe crear parámetros cifrados, así que los secretos se cargan
una vez con la CLI. Los **no secretos los crea el CDK** y no hay que tocarlos
(están en `lib/app-stack.ts`; cambiarlos en la consola no sirve de nada, el
siguiente despliegue los devuelve a lo que dice el código).

```bash
put() { aws ssm put-parameter --name "/courier/prod/$1" --type SecureString --value "$2" --overwrite; }

# Helga (docs/13). Solo hacen falta al poner HELGA_MODE=on.
put HELGA_BASE_URL      'https://lmexpress.helgasys.com'
put HELGA_CLIENT_ID     '11'
put HELGA_CLIENT_SECRET '...'
put HELGA_USERNAME      'servicioalcliente@hsglobal-services.com'
put HELGA_PASSWORD      '...'
put HELGA_ORIGIN        'https://lmexpress.helgasys.com'
put HELGA_APP_ID        '...'

# Onvo Pay. Solo con ONVO_MODE=on.
put ONVO_BASE_URL       'https://api.onvopay.com/v1'
put ONVO_PUBLIC_KEY     '...'
put ONVO_SECRET_KEY     '...'
put ONVO_WEBHOOK_SECRET '...'

# La tasa de cambio de referencia (HACIENDA_*) NO aparece aquí: la API de
# Hacienda es pública y anónima, así que no tiene ninguna credencial que cargar.
```

La contraseña de PostgreSQL **no está en esta lista a propósito**: la genera AWS,
vive en Secrets Manager y el script de arranque arma el `DATABASE_URL` con ella.
Nadie la escribe ni la ve.

### 4. Stack de aplicación

```bash
pnpm exec cdk deploy courier-prod-app
```

Si la cuenta **ya tiene** un proveedor OIDC de GitHub (solo puede haber uno):

```bash
pnpm exec cdk deploy courier-prod-app -c githubOidcProviderArn=arn:aws:iam::<cuenta>:oidc-provider/token.actions.githubusercontent.com
```

Imprime `GithubDeployRoleArn` y `SiteUrl`.

### 5. Conectar GitHub

En el repositorio → Settings → Secrets and variables → Actions, crear:

| Secreto | Valor |
|---------|-------|
| `AWS_DEPLOY_ROLE_ARN` | la salida `GithubDeployRoleArn` |

A partir de ahí, cada push a `master` despliega
(`.github/workflows/deploy-aws.yml`). El primer despliegue del stack de
aplicación deja la instancia **sin imagen** (ECR está vacío): es normal, el
pipeline la publica y arranca el servicio.

### 6. Sembrar el primer administrador

No puede autoregistrarse (eso es solo para clientes) ni recibir invitación
(todavía no hay correo saliente), así que se siembra una vez:

```bash
bash infra/scripts/deploy-local.sh seed
```

Imprime la contraseña generada **una sola vez**. También crea las tarifas de
cliente por defecto si la tabla está vacía. Es idempotente: repetirlo no rompe
nada.

## Desplegar sin GitHub

`infra/scripts/deploy-local.sh` hace lo mismo que el workflow, desde una máquina.
Son dos caminos al mismo sitio y hay que mantenerlos en paralelo: si cambia uno,
cambia el otro.

```bash
bash infra/scripts/deploy-local.sh all   # API y sitio
bash infra/scripts/deploy-local.sh api   # solo la API
bash infra/scripts/deploy-local.sh web   # solo el sitio
```

Sirve para dos cosas:

- **El primer despliegue**, cuando el secreto de GitHub todavía no está puesto.
  Con esto, los pasos 5 y 7 de arriba dejan de bloquear: se despliega ya y se
  conecta GitHub después, para que los siguientes sean automáticos.
- **La salida de emergencia** el día que el pipeline no esté disponible.

Necesita `aws` autenticada, `docker` con buildx y `pnpm`. Los nombres de bucket,
repositorio y distribución los lee de las salidas de los stacks, así que no hay
nada que copiar a mano.

## Operación

**Ver los logs de la API**

```bash
aws logs tail /courier/prod/api --follow
```

**Entrar a la instancia** (sin SSH ni llaves, por Session Manager)

```bash
aws ssm start-session --target "$INSTANCE"
```

**Desplegar una versión concreta a mano**

```bash
aws ssm send-command --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters commands="/opt/courier/deploy.sh <sha>"
```

**Volver atrás:** el mismo comando con el sha anterior. Las imágenes de los 10
últimos despliegues siguen en ECR. Ojo: las migraciones **no** se deshacen; un
rollback de código sobre un esquema nuevo solo es seguro si la migración era
compatible hacia atrás.

**Cambiar una bandera de configuración** (por ejemplo encender Helga):

```bash
aws ssm put-parameter --name /courier/prod/HELGA_MODE --value on --type String --overwrite
aws ssm send-command --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters commands="/opt/courier/deploy.sh latest"
```

El reinicio es necesario: la configuración se lee al arrancar (y si falta una
credencial obligatoria, la API **no arranca** en vez de operar a medias).

## Qué queda pendiente

Nada de esto bloquea el despliegue, pero está sin cerrar:

1. **Dominio propio** (docs/12 §7.1). Mientras tanto todo vive bajo la URL de
   CloudFront. Al cerrarlo: certificado en ACM, alias en la distribución, un
   registro A a la Elastic IP y el origen de `/api/*` pasa a HTTPS.
2. **Origen en HTTP.** El tramo navegador → CloudFront va cifrado; el tramo
   CloudFront → instancia, no. Sin dominio propio no hay certificado válido que
   poner en la instancia (ACM solo emite para dominios que controlas y CloudFront
   rechaza los autofirmados). Se resuelve con el punto 1.
3. **Páginas de error del sitio.** La distribución no define `errorResponses` a
   propósito: son de toda la distribución y convertirían un 404 o un 403 legítimo
   de la API en el HTML del sitio, que el portal no sabría leer. Un 404 del sitio
   público muestra hoy el XML de S3. Se arregla al separar la API en un
   subdominio (punto 1).
4. **SES fuera del sandbox** (docs/12 §7.2) antes de poner `MAIL_ENABLED=true`.
5. **IP en la lista blanca de Helga** antes de poner `HELGA_MODE=on`.
