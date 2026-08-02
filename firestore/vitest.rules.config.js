import { defineConfig } from 'vitest/config';

// Config for the emulator-backed security-rules test. Run via
// `npm run test:rules`, which wraps it in `firebase emulators:exec` so the
// Firestore emulator is up. Kept out of the default suite (see vitest.config.js)
// because CI has no emulator.
export default defineConfig({
  test: {
    include: ['firestore/**/*.test.js'],
    // Rules loading + a fresh test environment is slower than a pure unit test.
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
