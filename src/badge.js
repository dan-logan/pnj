// The app-icon badge: "games waiting on you", on the home-screen icon.
//
// This is Tier 0 turn signalling — everything that can be done without a
// backend. `navigator.setAppBadge` is a purely local call: it writes a number
// to the launcher icon and makes no network request, registers nothing with a
// push service, and costs nothing on the Firestore side. The count it draws is
// `countWaitingOnMe` (lobby.js), already computed for the in-app badge on the
// My Games button, so this adds a signal without adding a single read.
//
// Two deliberate properties, both easy to "fix" into bugs:
//
//  1. **The badge is never cleared on unmount.** The OS keeps a badge until
//     something clears it, which is the whole point: close the app with a turn
//     waiting and the icon still says so tomorrow. A cleanup function here
//     would wipe it on every teardown and leave nothing to come back to.
//
//  2. **It is only ever as fresh as the last time the app was open.** Nothing
//     runs while the app is closed, so a partner's move made overnight raises
//     no badge, and a turn played on another device leaves this one's badge
//     stale until it next opens. That is the honest ceiling of a no-backend
//     signal — a service worker woken by push is the only thing that can
//     update an icon for an app that isn't running.
//
// Support is partial — absent on Firefox and desktop Safari; on iOS it needs
// the PWA installed to the home screen (16.4+) *and* notification permission
// granted, which the app does not ask for today, so iOS users get nothing until
// that lands with Tier 1 push. Chrome on Android and desktop badge with no
// permission prompt at all. The promise can also reject where the method does
// exist, so every path here is a swallowed no-op rather than a throw.

// Resolve the navigator to use. Injectable so the tests can drive fakes without
// a DOM, and undefined outside a browser (Vitest's default node environment).
function resolveNav(nav) {
  if (nav !== undefined) return nav;
  return typeof navigator === 'undefined' ? null : navigator;
}

// True when this environment can show an icon badge at all. Useful for deciding
// whether to offer badge-related UI; the sync below feature-detects on its own.
export function isBadgeSupported(nav) {
  const n = resolveNav(nav);
  return Boolean(n && typeof n.setAppBadge === 'function' && typeof n.clearAppBadge === 'function');
}

// Point the icon badge at `count`. Zero clears it — an empty badge and a badge
// reading "0" are different things to the OS, and only the former is right.
export function syncAppBadge(count, nav) {
  const n = resolveNav(nav);
  if (!isBadgeSupported(n)) return false;
  try {
    const result = count > 0 ? n.setAppBadge(count) : n.clearAppBadge();
    // Rejects on some platforms (an uninstalled PWA, a revoked permission).
    // Nothing to do about it and nothing worth telling the player.
    if (result && typeof result.catch === 'function') result.catch(() => {});
    return true;
  } catch {
    // Never let a cosmetic badge break the game.
    return false;
  }
}
