// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// Opcion B (docs/00 §4): el sitio publico es estatico; el portal privado se monta
// como una unica isla-app React (client:only) bajo /app. React se integra aqui.
export default defineConfig({
  site: 'https://hsgloballtd.com',
  integrations: [react()],
  vite: {
    // @courier/shared se distribuye como TS fuente (workspace); Vite debe procesarlo.
    ssr: { noExternal: ['@courier/shared'] },
  },
});
