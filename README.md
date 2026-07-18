# HS Global Courier

Monorepo de la app de courier/casillero (Miami → Colombia).

- `apps/web` — sitio público en Astro + portal privado como isla-app React.
- `apps/api` — API en Node (Hono) con Postgres/Drizzle.
- `packages/shared` — dominio compartido (tipos y reglas) entre web y API.

La documentación de diseño por módulos vive en [`docs/`](./docs/).

---

## 1. Requisitos previos

| Herramienta | Versión | Notas |
|---|---|---|
| Node.js | 22 o superior | El proyecto usa `--env-file`, nativo desde Node 20. Probado en 24.x. |
| pnpm | 11.1.1 | Fijado en `packageManager`. **Solo pnpm**: nunca `npm` ni `yarn`. |
| PostgreSQL | 14 o superior | Debe correr en local. No hay Docker en el repo. |
| Git | cualquiera reciente | |

Si no tienes pnpm, la vía recomendada es Corepack, que respeta la versión fijada en el repo:

```bash
corepack enable
corepack prepare pnpm@11.1.1 --activate
```

Verifica que todo esté en su sitio:

```bash
node --version    # v22+
pnpm --version    # 11.1.1
psql --version    # 14+
```

## 2. Clonar e instalar

Desde la raíz del repo, una sola instalación cubre los tres paquetes del workspace:

```bash
pnpm install
```

Eso instala los tres paquetes del workspace y enlaza `@courier/shared` en web y API. `@courier/shared` se consume como TypeScript fuente, sin build previo: no hay que compilarlo.

## 3. Base de datos

La API espera una base Postgres llamada `courier`. Con la configuración por defecto del `.env.example` (usuario `postgres`, contraseña `postgres`, puerto 5432):

```bash
createdb -U postgres courier
```

Si `createdb` no está en el PATH (típico en Windows), sirve igual desde psql:

```bash
psql -U postgres -c "CREATE DATABASE courier;"
```

Puedes usar otro usuario, contraseña o nombre de base: solo tiene que coincidir con el `DATABASE_URL` del paso siguiente.

## 4. Variables de entorno

Solo la API necesita `.env`. Cópialo desde el ejemplo versionado:

```bash
cp apps/api/.env.example apps/api/.env
```

En Windows con PowerShell:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
```

Los valores por defecto ya funcionan en local; ajusta `DATABASE_URL` si tu Postgres usa otras credenciales.

| Variable | Valor por defecto | Para qué sirve |
|---|---|---|
| `NODE_ENV` | `development` | Entorno de ejecución. |
| `PORT` | `3001` | Puerto de la API. |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/courier` | Conexión a Postgres. |
| `WEB_ORIGIN` | `http://localhost:4321` | Origen permitido para CORS (el dev server de Astro). |
| `SESSION_COOKIE_NAME` | `hs_session` | Nombre de la cookie httpOnly de sesión. |
| `SESSION_TTL_HOURS` | `168` | Duración de la sesión (7 días). |
| `EMAIL_CODE_TTL_MINUTES` | `15` | Vigencia del código de verificación por email. |
| `EMAIL_CODE_MAX_ATTEMPTS` | `5` | Intentos permitidos para ese código. |
| `INVITE_TTL_HOURS` | `72` | Vigencia del token de invitación de staff. |

**La web no necesita `.env` en local.** `PUBLIC_API_BASE` cae por defecto a `http://localhost:3001` (ver `apps/web/src/portal/lib/api.ts`), que es justo donde corre la API. Solo defínela si mueves la API de puerto o la apuntas a un entorno remoto.

## 5. Migraciones y datos iniciales

Aplica el esquema a la base recién creada:

```bash
pnpm --filter @courier/api db:migrate
```

Luego siembra el administrador inicial y las tarifas de cliente de ejemplo:

```bash
pnpm --filter @courier/api db:seed
```

El seed es idempotente: si el admin ya existe, no toca nada. Crea `admin@hsglobal.ltd` y, si no defines `SEED_ADMIN_PASSWORD`, **genera una contraseña robusta y la imprime una sola vez en consola**. Cópiala en ese momento; para volver a fijarla hay que forzar el reseteo:

```bash
pnpm --filter @courier/api db:seed -- --force
```

Variables opcionales del seed: `SEED_ADMIN_EMAIL`, `SEED_ADMIN_NAME`, `SEED_ADMIN_PASSWORD`.

## 6. Levantar el proyecto

Desde la raíz, un solo comando levanta **web y API en paralelo**:

```bash
pnpm dev
```

Con ambos arriba: el sitio público está en http://localhost:4321, el portal en http://localhost:4321/app y la API en http://localhost:3001.

Si solo necesitas uno de los dos, lánzalo individual:

```bash
pnpm dev:web   # solo la web en http://localhost:4321
pnpm dev:api   # solo la API en http://localhost:3001
```

Para el sitio público estático basta con la web; si vas a tocar el portal privado (`/app`), necesitas además la API corriendo.

**Al detener:** `Ctrl+C` sobre `pnpm dev` detiene la API, pero el dev server de Astro queda corriendo en segundo plano (Astro lo gestiona como un proceso independiente). Para detenerlo:

```bash
pnpm --filter @courier/web astro dev stop
```

Si vuelves a correr `pnpm dev` con ese server ya arriba, Astro lo reutiliza en vez de levantar otro.

## 7. Comandos útiles

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Levanta web y API en paralelo. |
| `pnpm dev:web` / `pnpm dev:api` | Levanta solo la web o solo la API. |
| `pnpm build` | Build de producción de la web. |
| `pnpm --filter @courier/web preview` | Sirve el build ya generado. |
| `pnpm --filter @courier/api dev` | API en modo watch. |
| `pnpm --filter @courier/api start` | API sin watch. |
| `pnpm --filter @courier/api typecheck` | Chequeo de tipos de la API. |
| `pnpm --filter @courier/shared typecheck` | Chequeo de tipos del dominio compartido. |
| `pnpm --filter @courier/api db:generate` | Genera una migración a partir de cambios en los `*.schema.ts`. |
| `pnpm --filter @courier/api db:migrate` | Aplica las migraciones pendientes. |
| `pnpm --filter @courier/api db:push` | Empuja el esquema sin migración (solo para prototipar). |
| `pnpm --filter @courier/api db:seed` | Siembra admin y tarifas. |

No hay linter, formateador ni suite de tests configurados en el repo por ahora: la verificación disponible es `typecheck` y el `build`.

Añadir una dependencia siempre va dirigido a un paquete concreto:

```bash
pnpm --filter @courier/web add <paquete>
```

## 8. Problemas frecuentes

**La API arranca pero falla al consultar.** Casi siempre es `DATABASE_URL`: revisa que Postgres esté corriendo, que la base `courier` exista y que usuario/contraseña coincidan.

**El portal carga pero las peticiones fallan con error de CORS.** La API solo acepta el origen de `WEB_ORIGIN` (`http://localhost:4321`). Si Astro arrancó en otro puerto porque el 4321 estaba ocupado, actualiza `WEB_ORIGIN` en `apps/api/.env` y reinicia la API.

**Perdiste la contraseña del admin.** Vuelve a sembrar con `-- --force`, que la restablece e imprime una nueva.

**Instalaste con npm por error.** Borra `node_modules` y `package-lock.json`, y reinstala con `pnpm install`. El lockfile válido del repo es `pnpm-lock.yaml`.
