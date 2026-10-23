import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    // Tests never touch the durable store or a real library.
    env: { MENUSMITH_STORE_URL: '', MENUSMITH_STORE_KEY: '', MENUSMITH_STORE_TOKEN: '', MENUSMITH_LIBRARY: '.cache/test-library', MENUSMITH_LLM: 'replay' },
  },
});
