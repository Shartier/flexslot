// Builds the three screens (React) into dist/web; the FlexSlot server serves them (DESIGN 2, 14.5).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/web', import.meta.url)),
  base: '/',
  oxc: { jsx: { runtime: 'automatic', importSource: 'react' } },
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
    // No inline scripts or styles: the server's Content-Security-Policy allows only same-origin files.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
