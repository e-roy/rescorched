import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Phaser is large and changes rarely — keep it in its own chunk so a
        // game-code change does not force players to re-download the engine.
        codeSplitting: {
          groups: [{ name: 'phaser', test: /[\\/]node_modules[\\/]\.pnpm[\\/]phaser@/ }],
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
