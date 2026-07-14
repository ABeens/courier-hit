# HS Global Courier — Guía del repositorio

App modular de courier/casillero (Miami → Colombia). Migración de un HTML
autocontenido (`backup/`) a un monorepo con web (Astro, islas) + API (Node).

La documentación viva del rediseño está en [`docs/`](./docs/) — empieza por
[`docs/README.md`](./docs/README.md).

## Gestor de paquetes: SOLO pnpm

**Usar siempre `pnpm`. Nunca `npm` ni `yarn`.**

- Instalar: `pnpm install`
- Añadir dependencia a un paquete del workspace: `pnpm --filter @courier/web add <pkg>`
- Ejecutar scripts: `pnpm --filter @courier/web dev` (o `pnpm -C apps/web dev`)
- No commitear `package-lock.json` ni `yarn.lock`; el lockfile del repo es `pnpm-lock.yaml`.

## Estructura (monorepo pnpm)

```
apps/
  web/     # Astro — sitio público (estático) + portal isla-app (Opción B)
packages/  # (futuro) @courier/shared — dominio compartido
docs/      # documentación por módulos
backup/    # origen funcional (prototipo). No se modifica.
```

## Convenciones

- Idioma del producto y del dominio: español (es-CO).
- **Nombres de código en inglés** (archivos, clases, interfaces, funciones,
  variables), especialmente en `packages/`. Solo se conserva el español para el
  **dominio**: miembros y valores de enum de dominio (p. ej. `Role.ServicioCliente`,
  `State.Prealertado`, `'maritimo_fcl'`), etiquetas visibles (`STATE_LABELS`) y
  comentarios. Los enums de comportamiento van 100% en inglés, valores incluidos
  (p. ej. `Trigger.NotifyStateChange = 'notify_state_change'`).
- Sistema de diseño en `apps/web/src/styles/` (tokens · base · atoms), portado 1:1
  del prototipo. Reutilizar los tokens/átomos; no hardcodear colores.
- Componentes Astro modulares: primitivas en `components/ui/`, secciones en carpetas
  por área (p. ej. `components/landing/`).
