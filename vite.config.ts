import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative assets work both at a custom domain root and under
  // username.github.io/repository-name/ on GitHub Pages.
  base: './',
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => assetInfo.names.includes('eng.traineddata.gz')
          ? 'assets/eng.traineddata.gz'
          : 'assets/[name]-[hash][extname]',
      },
    },
  },
  test: {
    environment: 'node',
  },
});
