// Security-rules test — the acceptance gate for Package 2.
//
// The rules ARE the backend. This runs the real firestore/firestore.rules
// against the Firestore emulator and proves the one property that matters most:
// a client holding the app's own public config, signed in as a DIFFERENT
// anonymous uid, can read neither an active game's metadata nor its live/current
// state. Everything else in Package 2 is worth less than this test.
//
// Run it with `npm run test:rules`, which starts the emulator via
// `firebase emulators:exec` first. It is excluded from the default `npm test`
// (see vitest.config.js) because CI has no emulator.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, updateDoc } from 'firebase/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_UID = 'host-uid';
const GUEST_UID = 'guest-uid';
const STRANGER_UID = 'stranger-uid'; // a DIFFERENT anonymous uid — the attacker

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'demo-pnj',
    firestore: {
      rules: readFileSync(join(HERE, 'firestore.rules'), 'utf8'),
    },
  });
});

afterAll(async () => {
  if (testEnv) await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

// A game already dealt and in play: guest claimed, state written.
async function seedActiveGame(id = 'g1') {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'games', id), {
      participants: [HOST_UID, GUEST_UID],
      hostUid: HOST_UID,
      guestUid: GUEST_UID,
      code: 'ABC234',
      mode: 'partners',
      status: 'active',
      version: 3,
      currentPlayer: 1,
      waitingOn: 2,
      winner: null,
      createdAt: 1,
      updatedAt: 2,
    });
    await setDoc(doc(db, 'games', id, 'live', 'current'), {
      state: { secret: 'the whole board' },
      replay: [],
      version: 3,
    });
    await setDoc(doc(db, 'codes', 'ABC234'), { gameId: id });
  });
}

// A game still in the lobby: created, nobody has claimed the guest seat.
async function seedLobbyGame(id = 'lobby1') {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'games', id), {
      participants: [HOST_UID],
      hostUid: HOST_UID,
      guestUid: null,
      code: 'LOB234',
      mode: 'partners',
      status: 'lobby',
      version: 0,
      currentPlayer: 0,
      waitingOn: 0,
      winner: null,
      createdAt: 1,
      updatedAt: 1,
    });
  });
}

describe('THE ACCEPTANCE GATE: a different anonymous uid cannot read an active game', () => {
  it('cannot read active game metadata', async () => {
    await seedActiveGame();
    const stranger = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(getDoc(doc(stranger, 'games', 'g1')));
  });

  it('cannot read the live/current state', async () => {
    await seedActiveGame();
    const stranger = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(getDoc(doc(stranger, 'games', 'g1', 'live', 'current')));
  });

  it('an unauthenticated client cannot read either', async () => {
    await seedActiveGame();
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'games', 'g1')));
    await assertFails(getDoc(doc(anon, 'games', 'g1', 'live', 'current')));
  });

  it('the two actual participants CAN read both', async () => {
    await seedActiveGame();
    for (const uid of [HOST_UID, GUEST_UID]) {
      const db = testEnv.authenticatedContext(uid).firestore();
      await assertSucceeds(getDoc(doc(db, 'games', 'g1')));
      await assertSucceeds(getDoc(doc(db, 'games', 'g1', 'live', 'current')));
    }
  });
});

describe('create', () => {
  const valid = {
    participants: [HOST_UID],
    hostUid: HOST_UID,
    guestUid: null,
    code: 'ABC234',
    mode: 'partners',
    status: 'lobby',
    version: 0,
    currentPlayer: 0,
    waitingOn: 0,
    winner: null,
    createdAt: 1,
    updatedAt: 1,
  };

  it('the host can create a well-formed lobby game', async () => {
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertSucceeds(setDoc(doc(db, 'games', 'new1'), valid));
  });

  it('cannot create claiming someone else as host', async () => {
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(setDoc(doc(db, 'games', 'new2'), valid)); // hostUid != me
  });

  it('cannot create at a nonzero version', async () => {
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertFails(setDoc(doc(db, 'games', 'new3'), { ...valid, version: 1 }));
  });

  it('cannot create already-claimed or already-active', async () => {
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertFails(setDoc(doc(db, 'games', 'new4'), { ...valid, guestUid: GUEST_UID, participants: [HOST_UID, GUEST_UID] }));
    await assertFails(setDoc(doc(db, 'games', 'new5'), { ...valid, status: 'active' }));
  });
});

describe('lobby read (the one accepted exposure)', () => {
  it('any signed-in client can read an unclaimed lobby game', async () => {
    await seedLobbyGame();
    const stranger = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertSucceeds(getDoc(doc(stranger, 'games', 'lobby1')));
  });
});

describe('join — rule (a): claim the empty guest seat', () => {
  it('a stranger can claim the empty seat by adding only itself', async () => {
    await seedLobbyGame();
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'games', 'lobby1'), {
        guestUid: STRANGER_UID,
        participants: [HOST_UID, STRANGER_UID],
      })
    );
  });

  it('cannot claim by setting guestUid to someone else', async () => {
    await seedLobbyGame();
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'games', 'lobby1'), {
        guestUid: GUEST_UID,
        participants: [HOST_UID, GUEST_UID],
      })
    );
  });

  it('cannot claim an already-claimed game', async () => {
    await seedActiveGame();
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'games', 'g1'), {
        guestUid: STRANGER_UID,
        participants: [HOST_UID, GUEST_UID, STRANGER_UID],
      })
    );
  });

  it('cannot take over the host while claiming', async () => {
    await seedLobbyGame();
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'games', 'lobby1'), {
        guestUid: STRANGER_UID,
        hostUid: STRANGER_UID,
        participants: [STRANGER_UID],
      })
    );
  });
});

describe('publish — rule (b): advance the game', () => {
  it('a participant can advance the version by exactly one', async () => {
    await seedActiveGame();
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertSucceeds(updateDoc(doc(db, 'games', 'g1'), { version: 4, currentPlayer: 3, waitingOn: 0 }));
  });

  it('cannot skip a version', async () => {
    await seedActiveGame();
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertFails(updateDoc(doc(db, 'games', 'g1'), { version: 5 }));
  });

  it('cannot change membership while publishing', async () => {
    await seedActiveGame();
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'games', 'g1'), { version: 4, participants: [HOST_UID] })
    );
  });

  it('a stranger cannot publish', async () => {
    await seedActiveGame();
    const db = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(updateDoc(doc(db, 'games', 'g1'), { version: 4 }));
  });

  it('a participant can write live/current; a stranger cannot', async () => {
    await seedActiveGame();
    const host = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertSucceeds(setDoc(doc(host, 'games', 'g1', 'live', 'current'), { state: { x: 1 }, replay: [], version: 4 }));
    const stranger = testEnv.authenticatedContext(STRANGER_UID).firestore();
    await assertFails(setDoc(doc(stranger, 'games', 'g1', 'live', 'current'), { state: { x: 2 }, replay: [], version: 4 }));
  });
});

describe('delete is never allowed', () => {
  it('even a participant cannot delete a game', async () => {
    await seedActiveGame();
    const { deleteDoc } = await import('firebase/firestore');
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertFails(deleteDoc(doc(db, 'games', 'g1')));
  });
});

describe('codes', () => {
  it('a signed-in client can create and read a code, but not overwrite it', async () => {
    const db = testEnv.authenticatedContext(HOST_UID).firestore();
    await assertSucceeds(setDoc(doc(db, 'codes', 'NEW234'), { gameId: 'g1' }));
    await assertSucceeds(getDoc(doc(db, 'codes', 'NEW234')));
    await assertFails(updateDoc(doc(db, 'codes', 'NEW234'), { gameId: 'g2' }));
  });

  it('an unauthenticated client cannot read a code', async () => {
    await seedActiveGame();
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'codes', 'ABC234')));
  });
});
