// Firebase configuration and lazy SDK loading.
//
// Two hard constraints from the plan shape this file:
//
//   1. Solo play must be untouched. A player who never taps "Play with a friend"
//      must never sign in and must never download the Firestore SDK — even once
//      the env vars are set in production. So the SDK is imported behind a
//      dynamic import() reached only from the multiplayer paths (loadSdk below),
//      never at module top level. Importing this file is cheap; it pulls in no
//      Firebase code until getFirebase() is actually called.
//
//   2. The four config values are public by design. Firebase's own docs are
//      explicit that the web API key is an identifier, not a secret; the security
//      model rests entirely on firestore/firestore.rules. They are baked into the
//      static Pages build from VITE_FIREBASE_* env vars.
//
// With any of the four missing, isMultiplayerConfigured() is false and the app
// builds, deploys and plays solo with no multiplayer UI — which is what keeps CI
// (no env vars) green.

// Read a Vite env var without assuming import.meta.env exists (it doesn't under
// some tooling). Vite statically replaces import.meta.env.VITE_* at build time.
function readEnv(key) {
  try {
    // eslint-disable-next-line no-undef
    return import.meta.env ? import.meta.env[key] : undefined;
  } catch {
    return undefined;
  }
}

export const firebaseConfig = {
  apiKey: readEnv('VITE_FIREBASE_API_KEY'),
  authDomain: readEnv('VITE_FIREBASE_AUTH_DOMAIN'),
  projectId: readEnv('VITE_FIREBASE_PROJECT_ID'),
  appId: readEnv('VITE_FIREBASE_APP_ID'),
};

// "All four present." The single gate for whether multiplayer can be started at
// all. Note: this does NOT gate whether the lobby opens on load — that is gated
// on the device actually having remote games (§3.4), so a solo player never sees
// multiplayer even when the vars are set.
export function isMultiplayerConfigured() {
  return Boolean(
    firebaseConfig.apiKey &&
      firebaseConfig.authDomain &&
      firebaseConfig.projectId &&
      firebaseConfig.appId
  );
}

// Optional emulator wiring, for local development and the browser-driven tests.
// Absent in production. VITE_FIRESTORE_EMULATOR_HOST looks like "127.0.0.1:8080";
// VITE_AUTH_EMULATOR_URL like "http://127.0.0.1:9099".
const firestoreEmulatorHost = readEnv('VITE_FIRESTORE_EMULATOR_HOST');
const authEmulatorUrl = readEnv('VITE_AUTH_EMULATOR_URL');

let sdkPromise = null;

// Load the Firebase SDK once and wire up app, auth and firestore. Everything
// downstream (session.js) goes through this, so the dynamic import lives in
// exactly one place and a solo player never triggers it.
async function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    const [appMod, authMod, fsMod] = await Promise.all([
      import('firebase/app'),
      import('firebase/auth'),
      import('firebase/firestore'),
    ]);

    const app = appMod.getApps().length
      ? appMod.getApp()
      : appMod.initializeApp(firebaseConfig);

    const auth = authMod.getAuth(app);
    const db = fsMod.getFirestore(app);

    if (firestoreEmulatorHost) {
      const [host, port] = firestoreEmulatorHost.split(':');
      fsMod.connectFirestoreEmulator(db, host, Number(port));
    }
    if (authEmulatorUrl) {
      authMod.connectAuthEmulator(auth, authEmulatorUrl, { disableWarnings: true });
    }

    return { app, auth, db, authMod, fsMod };
  })();
  return sdkPromise;
}

// The initialised SDK handle. Callers in session.js await this and use the
// re-exported module namespaces (authMod/fsMod) so they never import Firebase
// statically themselves.
export function getFirebase() {
  return loadSdk();
}
