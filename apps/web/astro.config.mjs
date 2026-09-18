// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Opcion B (docs/00 §4): el sitio publico es estatico; el portal privado se monta
// como una unica isla-app React (client:only) bajo /app. React se integra aqui.
export default defineConfig({
  // Alimenta el canonical y las og:image, asi que tiene que ser el host por el
  // que de VERDAD se sirve el sitio. Desde sep-2026 es el dominio propio: ya
  // existe el CNAME de `www` en Squarespace (docs/15-dominio.md) y CloudFront lo
  // sirve con su certificado. Va siempre a la par de DOMAIN_LIVE en
  // infra/lib/config.ts; si uno cambia, el otro tambien.
  site: 'https://www.hsglobal-services.com',
  integrations: [react()],
  vite: {
    // @courier/shared se distribuye como TS fuente (workspace); Vite debe procesarlo.
    ssr: { noExternal: ['@courier/shared'] },
  },
});
