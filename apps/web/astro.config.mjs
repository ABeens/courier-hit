// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Opcion B (docs/00 §4): el sitio publico es estatico; el portal privado se monta
// como una unica isla-app React (client:only) bajo /app. React se integra aqui.
export default defineConfig({
  // Alimenta el canonical y las og:image, asi que tiene que ser el host por el
  // que de VERDAD se sirve el sitio hoy: la URL de CloudFront. El dominio propio
  // ya tiene certificado y alias, pero todavia no existe el CNAME de `www` en
  // Squarespace (docs/15-dominio.md). El dia que exista, esto pasa a
  // 'https://www.hsglobal-services.com' a la vez que DOMAIN_LIVE en
  // infra/lib/config.ts.
  site: 'https://d3889h2ywa1fhc.cloudfront.net',
  integrations: [react()],
  vite: {
    // @courier/shared se distribuye como TS fuente (workspace); Vite debe procesarlo.
    ssr: { noExternal: ['@courier/shared'] },
  },
});
