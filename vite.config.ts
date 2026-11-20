import { defineConfig } from 'vite';

/**
 * The deployed site is served from the domain root, so it uses absolute
 * asset paths. The Android APK loads the same bundle from
 * `file:///android_asset/www/index.html`, where an absolute `/assets/...`
 * path would resolve outside the app's assets and 404. The APK build
 * therefore sets `VITE_BASE=./` to emit relative paths instead.
 */
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Allow the sandbox preview host so the live preview is reachable.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
