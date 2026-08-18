# syntax=docker/dockerfile:1
#
# Imagen de la API (docs/12 §6.1).
#
# El CONTEXTO DE BUILD ES LA RAIZ DEL REPO, no esta carpeta: la API depende de
# `@courier/shared`, que es un paquete del workspace distribuido como TS fuente.
#
#   docker build -f apps/api/Dockerfile -t courier-api .
#
# Destino: EC2 t4g (Graviton, arm64). El bundle es JavaScript puro y se puede
# compilar en cualquier arquitectura, asi que el builder corre en la NATIVA de
# quien construye ($BUILDPLATFORM) y solo la etapa final se emula. Sin esto, un
# build arm64 desde un runner x86 emula tambien el bundler y tarda varios minutos.

# --- Etapa 1: bundle ----------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:22-slim AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /repo

# Manifiestos primero: mientras no cambien, la capa de instalacion se reutiliza.
# `apps/web` entra aunque no se compile aqui porque `--frozen-lockfile` compara
# el lockfile contra TODOS los paquetes del workspace; si le falta uno, cree que
# lo borraron y falla.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY infra/package.json infra/

RUN pnpm install --frozen-lockfile --filter @courier/api...

COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @courier/api build

# --- Etapa 2: runtime ---------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PORT=3001
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Lo unico que no viaja dentro del bundle: el binario nativo de argon2. Se
# instala en la arquitectura DESTINO, que es la que decide que prebuild baja.
COPY apps/api/docker/runtime.package.json ./package.json
RUN pnpm install --prod --no-lockfile && pnpm store prune

# El bundle y las migraciones. `drizzle/` va en la imagen para que el paso de
# migracion del despliegue sea esta misma imagen con otro comando.
COPY --from=builder /repo/apps/api/dist ./dist
COPY apps/api/drizzle ./drizzle

USER node
EXPOSE 3001

# Sin curl en la imagen: Node 22 trae `fetch`, que ya sirve de sonda.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
