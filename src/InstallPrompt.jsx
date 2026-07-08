import React, { useEffect, useState } from 'react';

// Educates players on installing the game to their home screen so it runs
// full-screen and offline like a native app.
//
// Two paths:
//  - Chrome / Android / desktop fire `beforeinstallprompt`, which we capture and
//    replay from an "Install" button (a real one-tap install).
//  - iOS Safari has no such event, so we show the manual "Share → Add to Home
//    Screen" instructions instead.
//
// The banner hides itself when already running as an installed app, and
// remembers a dismissal so we don't nag on every visit.

const DISMISS_KEY = 'pnj:installPromptDismissed:v1';

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true // iOS Safari
  );
}

function isIos() {
  if (typeof navigator === 'undefined') return false;
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) &&
    !/crios|fxios/i.test(navigator.userAgent) // only Safari supports Add to Home Screen
  );
}

function wasDismissed() {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [visible, setVisible] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if (isStandalone() || wasDismissed()) return;

    const onBeforeInstall = (e) => {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive install ourselves
      setDeferredPrompt(e);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);

    // iOS never fires the event, so surface the manual instructions there.
    if (isIos()) setVisible(true);

    const onInstalled = () => {
      setVisible(false);
      setDeferredPrompt(null);
    };
    window.addEventListener('appinstalled', onInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    setVisible(false);
    setShowIosHelp(false);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // ignore
    }
  };

  const install = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      setVisible(false);
    } else if (isIos()) {
      setShowIosHelp((v) => !v);
    }
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-3 inset-x-3 z-40 flex justify-center pointer-events-none">
      <div className="pointer-events-auto bg-gray-800 border border-gray-700 rounded-xl shadow-xl px-4 py-3 max-w-md w-full">
        <div className="flex items-start gap-3">
          <div className="text-2xl leading-none mt-0.5">📲</div>
          <div className="flex-1">
            <div className="font-semibold">Install Pegs and Jokers</div>
            <div className="text-sm text-gray-400">
              Add it to your home screen for full-screen, offline play.
            </div>
            {showIosHelp && (
              <div className="text-sm text-gray-300 mt-2 bg-gray-700/50 rounded-lg p-2">
                Tap the <span className="font-semibold">Share</span> button{' '}
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  className="inline-block w-4 h-4 -mt-0.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 16V4" />
                  <path d="M8 8l4-4 4 4" />
                  <path d="M6 12H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2h-1" />
                </svg>{' '}
                in Safari, then choose{' '}
                <span className="font-semibold">Add to Home Screen</span>.
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1 shrink-0">
            <button
              onClick={install}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm font-semibold"
            >
              {isIos() && !deferredPrompt ? 'How?' : 'Install'}
            </button>
            <button
              onClick={dismiss}
              className="px-3 py-1.5 text-gray-400 hover:text-white text-xs"
            >
              Not now
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
