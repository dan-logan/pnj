import { defineConfig } from 'vitest/config';

// The default suite (`npm test`) is everything under src/. It must pass in CI
// with no Firebase env vars and no emulator, so the emulator-backed rules test
// under firestore/ is deliberately NOT included here — it runs on its own via
// `npm run test:rules`, which starts the Firestore emulator first.
export default defineConfig({
  test: {
    include: ['src/**/*.test.js'],
  },
});
