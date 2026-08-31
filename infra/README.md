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

## El entorno desplegado

| Dato | Valor |
|------|-------|
| Cuenta | `632914961265` |
| Región | `us-east-1` |
| **IP fija de salida** | **`54.88.91.248`** |
| Stacks | `courier-prod-base`, `courier-prod-app` |
| Configuración | Parameter Store, bajo `/courier/prod/` |

La cuenta y la región están **fijadas en `lib/config.ts`**, no se deducen de la
sesión activa: así un perfil equivocado no puede desplegar en el sitio
equivocado, y una sesión caducada da un error de credenciales en vez del confuso
"Unable to resolve AWS account to use".

La IP fija es la que va en la lista blanca de Helga. Tiene política de retención,
así que sobrevive a que se destruya y recree la instancia; solo cambiaría si se
borra el stack base a conciencia.

## Requisitos

- Sesión de AWS activa: `aws login` (la CLI ya está configurada en el equipo).
- **En Windows, los scripts `.sh` se corren desde Git Bash.** El `bash` que
  resuelve `cmd` es el lanzador de WSL y falla con
  `execvpe(/bin/bash) failed: No such file or directory` si no hay ninguna
  distribución instalada. O se abre Git Bash, o se invoca por su ruta:
  ```
  "C:\Program Files\Git\bin\bash.exe" infra/scripts/deploy-local.sh all
  ```
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

### 3. Stack de aplicación

```bash
pnpm exec cdk deploy courier-prod-app
```

Unos 10 minutos, casi todo CloudFront. Si la cuenta **ya tiene** un proveedor
OIDC de GitHub (solo puede haber uno):

```bash
pnpm exec cdk deploy courier-prod-app -c githubOidcProviderArn=arn:aws:iam::<cuenta>:oidc-provider/token.actions.githubusercontent.com
```

Imprime `SiteUrl`, `GithubDeployRoleArn`, `WebBucketName` y `DistributionId`.

La instancia arranca **sin imagen**, porque ECR todavía está vacío. Es lo
esperado: el software entra en el paso siguiente.

### 4. Desplegar el software

```bash
bash infra/scripts/deploy-local.sh all
```

Construye la imagen arm64, la publica en ECR, le dice a la instancia que se
despliegue (que es donde **se crean las tablas**, con las migraciones), compila
el sitio y lo sube. Unos 10 minutos.

Aquí no hace falta GitHub. Conectarlo es un paso de puesta en marcha, no de
despliegue: sirve para que los despliegues **siguientes** sean automáticos.

### 5. Sembrar el primer administrador

No puede autoregistrarse (eso es solo para clientes) ni recibir invitación
(todavía no hay correo saliente), así que se siembra una vez:

```bash
bash infra/scripts/deploy-local.sh seed
```

Imprime la contraseña generada **una sola vez**. También crea las tarifas de
cliente por defecto si la tabla está vacía. Es idempotente: repetirlo no rompe
nada.

### 6. Comprobar que está en pie

```bash
SITE=$(aws cloudformation describe-stacks --stack-name courier-prod-app \
  --query "Stacks[0].Outputs[?OutputKey=='SiteUrl'].OutputValue" --output text)

curl -s "$SITE/api/health"    # {"ok":true}
curl -sI "$SITE" | head -1    # HTTP/2 200
```

Si `/api/health` no responde, el problema está en la instancia y se ve en los
logs (`aws logs tail /courier/prod/api --since 15m`). Si responde pero el sitio
no carga, el problema es el sync a S3 o la invalidación de CloudFront.

Con esto el sistema está en pie **en modo básico**: se cobra por depósito
bancario, los correos se escriben en el log en vez de enviarse y no hay contacto
con Miami. Encender cada cosa es la sección siguiente.

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

## Puesta en marcha

El despliegue deja el sistema funcionando pero **con las integraciones
apagadas**, a propósito: cada una depende de un trámite con un tercero y ninguna
debe encenderse antes de que su trámite esté cerrado. Esta sección es el orden
en que se encienden y qué hace falta para cada una.

Ninguna bloquea a las demás salvo donde se dice.

### El mecanismo, una vez

Todas se encienden igual: se cambia un parámetro y se reinicia. La configuración
**se lee al arrancar**, así que sin reinicio no pasa nada.

```bash
INSTANCE=$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=courier-api" "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" --output text)

# 1. Cambiar el valor
aws ssm put-parameter --name /courier/prod/<VARIABLE> --value <VALOR> --type String --overwrite

# 2. Reiniciar con la misma imagen
aws ssm send-command --instance-ids "$INSTANCE" \
  --document-name AWS-RunShellScript \
  --parameters commands="/opt/courier/deploy.sh latest"
```

Y las credenciales (que sí son secretas) se cargan cifradas:

```bash
put() { aws ssm put-parameter --name "/courier/prod/$1" --type SecureString --value "$2" --overwrite; }
```

> **La red de seguridad:** si enciendes una integración y le falta una
> credencial obligatoria, **la API no arranca**. Es deliberado (`core/config.ts`):
> preferimos un servicio caído y evidente a uno operando a medias. Si tras un
> encendido `/api/health` deja de responder, mira los logs: el motivo estará
> escrito con el nombre de la variable que falta.

### A. Conectar GitHub (opcional, recomendado)

Para que los despliegues siguientes sean automáticos y no haya que lanzar el
script a mano.

En el repositorio → Settings → Secrets and variables → Actions:

| Secreto | Valor |
|---------|-------|
| `AWS_DEPLOY_ROLE_ARN` | la salida `GithubDeployRoleArn` del stack de aplicación |

No se guarda ninguna llave de AWS: solo el nombre del rol. GitHub y AWS se
reconocen por OIDC (ver `lib/app-stack.ts`). Desde ese momento, cada push a
`master` despliega.

Con `gh` autenticado:

```bash
ARN=$(aws cloudformation describe-stacks --stack-name courier-prod-app \
  --query "Stacks[0].Outputs[?OutputKey=='GithubDeployRoleArn'].OutputValue" --output text)
gh secret set AWS_DEPLOY_ROLE_ARN --body "$ARN"
```

### B. Correo saliente (SES)

**Es el primero que conviene arrancar**, porque el trámite es el más lento y
porque sin correo **no hay registro de clientes ni invitaciones de personal**:
son las dos puertas de entrada al sistema.

Antes de encenderlo hacen falta tres cosas:

1. **Un dominio verificado en SES**, con DKIM. Depende de zanjar el dominio (§E).
2. **Salir del sandbox.** Dentro del sandbox solo llegan correos a direcciones
   verificadas a mano. Se pide desde la consola de SES y AWS tarda días.
3. **Que `MAIL_FROM` sea de ese dominio.** Si el remitente no coincide con el
   dominio verificado, los correos van a spam.

```bash
aws ssm put-parameter --name /courier/prod/MAIL_FROM \
  --value 'HS Global Services <no-reply@EL-DOMINIO>' --type String --overwrite
aws ssm put-parameter --name /courier/prod/MAIL_ENABLED --value true --type String --overwrite
# reiniciar
```

**Comprobar:** registrar un cliente de prueba y ver que llega el código. Con
`MAIL_ENABLED=false` el correo se escribe entero en el log, así que la diferencia
se nota en `aws logs tail /courier/prod/api`.

El permiso `ses:SendEmail` ya lo tiene la instancia por su rol; no hay
credenciales de SES que cargar.

### C. Helga (el casillero de Miami)

Sin esto no hay casilleros enlazados ni prealertas, o sea que **el negocio no
opera**. Es la integración más crítica.

**La lista blanca de IP ya está confirmada** (30-ago-2026): `54.88.91.248` está
registrada con el proveedor. Queda anotado porque es el primer sospechoso el día
que todo empiece a responder 403 y los casilleros caigan en `failed`.

Cargar las credenciales y encender:

```bash
powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-enable.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File .\infra\scripts\helga-enable.ps1
```

El script carga todo, enciende `HELGA_MODE=on` y reinicia. Con `-DryRun` enseña
lo que haría y se va.

HS Global opera **varias cuentas de casillero**, cada una con su login. Van todas
en `HELGA_ACCOUNTS`, un JSON cifrado, y **la primera es la principal**: es bajo
la que hoy cuelgan todos los destinatarios. La lista vive en la tabla `$Cuentas`
del script; si abren un casillero nuevo o cambia una contraseña, se edita ahí y
se vuelve a lanzar.

Con `HELGA_MODE=on` son obligatorias `HELGA_BASE_URL`, `HELGA_CLIENT_ID`,
`HELGA_CLIENT_SECRET`, `HELGA_ORIGIN` y al menos una cuenta. Si falta alguna, la
API **no arranca**.

**Nunca poner `simulated` en producción.** El arranque lo impide, porque daría
por enlazados casilleros que Helga no conoce y por prealertados paquetes que
nadie espera en Miami.

**Comprobar:** registrar un cliente de prueba y ver que su casillero queda en
`synced`. Si queda en `failed`, el motivo está en los logs; lo más probable es la
lista blanca.

### D. El robot de tareas programadas

**Va después de Helga, no antes.** Son dos interruptores en serie: todas las
tareas del robot son de Helga, así que encenderlo con `HELGA_MODE=off` no agenda
nada y la API lo avisa por consola al arrancar.

```bash
aws ssm put-parameter --name /courier/prod/ROBOT_ENABLED --value true --type String --overwrite
# reiniciar
```

Es lo que hace avanzar los trámites solo: sincroniza estados con Miami, reintenta
enlaces y prealertas fallidas, y descubre paquetes creados directamente en Helga.
Sin él hay que empujar todo a mano.

Los intervalos tienen valores por defecto razonables. El único con una ventana
que se cierra es `ROBOT_PACKAGE_DISCOVERY_EVERY`: lo que avance entre dos
corridas no se vuelve a ver y hay que cargarlo a mano.

Dos instancias no duplicarían tareas (hay candado en base), así que esto no
limita el escalado.

### E. Onvo Pay (cobro con tarjeta)

Lo último. Sin esto el cliente paga por depósito bancario, que es un flujo
completo y no depende de terceros: **apagado no se pierde ninguna función
esencial**.

Necesita una URL pública y estable para el webhook, así que va después del
despliegue y preferiblemente después del dominio.

1. En el dashboard de Onvo (Developers), registrar la URL de callback:
   `https://EL-DOMINIO/api/payments/webhook`
2. Copiar el `webhook_secret` que dan ahí.

```bash
put ONVO_BASE_URL       'https://api.onvopay.com/v1'
put ONVO_PUBLIC_KEY     '...'
put ONVO_SECRET_KEY     '...'
put ONVO_WEBHOOK_SECRET '...'

aws ssm put-parameter --name /courier/prod/ONVO_MODE --value on --type String --overwrite
# reiniciar
```

Qué entorno se toca lo decide **el prefijo de la llave**, no el modo ni la URL:
las `onvo_test_*` no tocan la red bancaria real.

Sin `ONVO_WEBHOOK_SECRET` ningún pago con tarjeta se puede confirmar **nunca**,
porque es lo único que distingue un cobro real de un POST falso. Por eso es
obligatorio en modo `on`.

### F. El dominio

Es el que arrastra más cosas y el único que además **cierra deuda técnica**
(el tramo CloudFront → instancia sigue en HTTP mientras tanto).

**El dominio es `hsglobal-services.com`**, y el host canónico es
**`www.hsglobal-services.com`**.

> El runbook completo, con el estado actual y las trampas, está en
> [`docs/15-dominio.md`](../docs/15-dominio.md). Los comandos, en
> [`scripts/domain.ps1`](./scripts/domain.ps1).

**El DNS se queda en Squarespace.** No se mueve la zona a Route 53: tiene los MX
y el SPF del Google Workspace de la empresa, y moverla por ganar un alias en el
apex pone en riesgo el correo. La consecuencia es que los registros se ponen a
mano en el panel (el CDK no puede crearlos ni esperarlos) y que **el apex no
puede apuntar a CloudFront**, porque un apex no admite CNAME: se resuelve con el
reenvío de Squarespace hacia `www`.

El código ya está preparado: `SITE_DOMAIN` y `CERTIFICATE_ARN` en `lib/config.ts`.
Mientras `CERTIFICATE_ARN` esté vacío, la distribución se queda con su dominio de
CloudFront y todo sigue como antes; rellenarlo enciende el alias y `WEB_ORIGIN`
en un solo despliegue.

1. ✅ **Certificado en ACM**, emitido en `us-east-1` (CloudFront no acepta otro),
   con validación por DNS para el apex y para `www`.

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\infra\scripts\domain.ps1 request
   ```

   Los dos CNAME que pide van en Squarespace. **ACM da 72 horas**: pasadas, el
   certificado queda en `VALIDATION_TIMED_OUT` y no revive aunque los registros
   se pongan después. Hay que pedir uno nuevo (ya pasó una vez, con el
   certificado del 22-ago-2026).

2. ✅ **`CERTIFICATE_ARN`** en `lib/config.ts` con el ARN ya emitido. Falta
   desplegar `courier-prod-app`, que imprime `DistributionDomainName`, el destino
   del paso siguiente.

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\infra\scripts\domain.ps1 deploy
   ```
3. **DNS del sitio** en Squarespace, sin tocar los MX ni el SPF:
   - `www` → CNAME al dominio de la distribución.
   - apex → **reenvío** (Forwarding) a `https://www.hsglobal-services.com`, con
     HTTPS activado. No es un registro DNS: está en la sección de reenvío del
     dominio, no en la de registros.
4. **Registro A** `api.hsglobal-services.com` apuntando a la Elastic IP, para el
   origen de la API.
5. **Origen de `/api/*` a HTTPS** con ese nombre, en vez del HTTP actual. Ojo: el
   certificado de ACM **no se puede instalar en la instancia** (ACM no exporta la
   llave privada de un certificado público); el de la instancia sale de Let's
   Encrypt o hay que meter un balanceador delante.
6. **Verificar el dominio en SES** con DKIM y ajustar `MAIL_FROM` (§B). Son tres
   CNAME más en Squarespace. **No hay que tocar los MX**: SES aquí solo envía, el
   correo entrante sigue siendo de Google Workspace. Y **no configurar un MAIL
   FROM personalizado sobre el apex**, que sí pediría un MX propio y chocaría con
   Workspace; si hace falta, va sobre un subdominio (`mail.`).
7. **URL del webhook de Onvo** al host canónico (§E).

`WEB_ORIGIN` y el `site` de `apps/web/astro.config.mjs` ya no son pasos sueltos:
el primero lo calcula el stack a partir del certificado, y el segundo ya apunta a
`www.hsglobal-services.com`.

Y una decisión de negocio: el correo de servicio al cliente
(`servicioalcliente@hsglobal-services.com`) **es también la credencial contra
Helga**. Migrarlo implica cambiar la cuenta con el proveedor. Se puede dejar en
un dominio distinto del sitio, pero hay que decidirlo a conciencia.

### Resumen del orden

| Orden | Qué | Bloqueado por |
|:-----:|-----|---------------|
| A | Conectar GitHub | nada |
| B | Correo (SES) | dominio verificado + salir del sandbox |
| C | Helga | la IP en su lista blanca |
| D | Robot | que Helga esté en `on` |
| E | Onvo | URL pública estable + webhook registrado |
| F | Dominio | que el certificado de ACM valide |

En la práctica **F desbloquea B**, así que el dominio es lo primero que hay que
mover aunque aparezca el último.

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

## Deuda técnica conocida

Los trámites externos están en "Puesta en marcha". Esto es lo otro: decisiones
que se tomaron sabiendo que dejaban algo a medias.

1. **El tramo CloudFront → instancia va en HTTP.** El del navegador a CloudFront
   sí va cifrado, y la instancia solo acepta tráfico del rango de CloudFront,
   pero el salto intermedio viaja por internet sin cifrar. No es por descuido:
   sin dominio propio no existe certificado válido posible (ACM solo emite para
   dominios que controlas y CloudFront rechaza los autofirmados). **Se salda con
   el dominio**, y es la razón de más peso para cerrarlo pronto.

2. **El sitio no tiene páginas de error.** La distribución no define
   `errorResponses` a propósito: son de la distribución **entera**, no por
   comportamiento, así que convertirían un 404 o un 403 legítimo de la API (que
   los usa, con el contrato `{error:{code,message}}`) en el HTML del sitio, y el
   portal no sabría leer el error. Preferimos una API correcta a un 404 bonito.
   Hoy un 404 del sitio público muestra el XML de S3. Se arregla separando la API
   en un subdominio, que también depende del dominio.

3. **Una sola instancia, sin autoescalado.** Es lo que se aceptó al elegir la
   opción C (docs/12 §4.3). Un reinicio de la máquina es una caída de servicio de
   un par de minutos. El código ya está preparado para varias instancias (el
   robot usa candados en base), así que crecer es cambiar infraestructura, no
   código.

4. **Los despliegues tienen un hueco de servicio.** El script para el contenedor
   viejo antes de arrancar el nuevo. Con una sola instancia no hay forma de
   evitarlo sin un balanceador, que es justo lo que no se quiso pagar.
