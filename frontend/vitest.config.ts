import { defineConfig } from 'vitest/config';
import { browserBufferAlias, profileRuntimeResolution } from './vite.config.ts';

export default defineConfig({
  plugins: [profileRuntimeResolution()],
  resolve: {
    alias: { ...browserBufferAlias },
  },
  test: {
    environment: 'jsdom',
    restoreMocks: true,
    clearMocks: true,
  },
});
