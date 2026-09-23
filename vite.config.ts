import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

/**
 * GitHub Pages serves a project site from /<repo>/. The deploy workflow passes BASE_PATH in.
 * An empty BASE_PATH or "/" means a root deployment.
 */
const basePath = process.env.BASE_PATH ?? '';
const base = basePath === '' || basePath === '/' ? '/' : `/${basePath.replace(/^\/|\/$/g, '')}/`;

/**
 * Serves local-data/ (map tiles and terrain from tools/fetch-map-data.ts) at /local-data/ in `dev` and `preview`.
 * The build leaves it out of dist/; the Pages workflow copies it in.
 */
function localData(): Plugin {
  const root = fileURLToPath(new URL('./local-data/', import.meta.url));
  const types: Record<string, string> = { '.webp': 'image/webp', '.json': 'application/json', '.bin': 'application/octet-stream' };
  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const path = decodeURIComponent((req.url ?? '').split('?')[0]);
    const file = normalize(join(root, path));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) return next();
    res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'max-age=86400');
    createReadStream(file).pipe(res);
  };
  return {
    name: 'backtrack:local-data',
    configureServer: (server) => { server.middlewares.use('/local-data', serve); },
    configurePreviewServer: (server) => { server.middlewares.use('/local-data', serve); },
  };
}

export default defineConfig({
  base,
  plugins: [svelte(), tailwindcss(), localData()],
  server: { port: 5175, open: false },
  build: { target: 'es2022' },
});
