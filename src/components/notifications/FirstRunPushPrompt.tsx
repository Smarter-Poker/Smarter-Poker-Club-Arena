/**
 * FirstRunPushPrompt — the one-time "turn on notifications" sheet for Club Arena.
 *
 * WHY CLUB ARENA NEEDS ITS OWN
 * ────────────────────────────────────────────────────────────────────────
 * The World Hub's equivalent (FirstRunNotificationPrompt) is mounted in that
 * app's pages/_app.js. Club Arena is a Vite SPA served at /hub/club-arena/ and
 * never loads it, so a player who lives in Club Arena was never asked. On
 * 2026-08-27, two accounts on the whole platform had a push subscription while
 * 2,432 seat offers in seven days were skipped for `no_subscription`.
 *
 * IT ASKS ONCE PER ACCOUNT PER BROWSER, ACROSS BOTH APPS
 * The `sp_firstrun_notif_<uid>` localStorage key is the SAME one the hub
 * writes. Same origin, so we read each other's answer. There is one device and
 * one subscription behind both surfaces (see lib/pushClient.ts), so asking
 * twice would be asking about something the player already settled.
 *
 * DELIBERATE: the Enable button calls enablePush() synchronously inside the
 * click handler. iOS only honours Notification.requestPermission() while the
 * originating tap gesture is alive, so nothing may be awaited before it.
 *
 * THE iOS DEAD END (learned the hard way in the hub, 2026-08-25)
 * On iOS, PushManager does not exist in Safari at all. Web push works ONLY
 * once the site is installed to the Home Screen and opened as a standalone
 * app. So isWebPushSupported() is false there, and a component that simply
 * returns null shows the iPhone player nothing and teaches them push is
 * broken. The 'install' state below is the one instruction that unblocks them,
 * and it uses its own cooldown key rather than the permanent "asked once" key:
 * installing is a multi-step manual action a player may reasonably defer, and
 * marking it done forever would mean the real permission prompt never runs
 * either.
 *
 * Copy is Title Case with no em dashes, per CLAUDE.md section 5.7.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  enablePush,
  hasLocalSubscription,
  isIos,
  isIosStandalonePwa,
  isWebPushSupported,
  notificationPermission,
} from '../../lib/pushClient';
import { useAuthUser } from '../../hooks/useAuthUser';
import './FirstRunPushPrompt.css';

const KEY_PREFIX = 'sp_firstrun_notif_';
const IOS_KEY_PREFIX = 'sp_firstrun_ios_install_';
const IOS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // a week is long enough not to nag
const SHOW_DELAY_MS = 20_000; // let the player land before asking for anything

type PromptState = null | 'ask' | 'install' | 'blocked' | 'success';

export default function FirstRunPushPrompt() {
  // Reads the session itself rather than taking a prop, so App.tsx can mount it
  // beside the other hosts without threading auth through the root. Nothing
  // renders until somebody is signed in: the subscribe endpoint is
  // authenticated, so prompting a signed-out visitor could only ever fail.
  const { user } = useAuthUser();
  const userId = user?.id ?? null;

  const [state, setState] = useState<PromptState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const markDone = useCallback(() => {
    if (!userId) return;
    try {
      localStorage.setItem(`${KEY_PREFIX}${userId}`, String(Date.now()));
    } catch {
      /* private mode */
    }
  }, [userId]);

  useEffect(() => {
    if (!userId || typeof window === 'undefined') return undefined;

    let alreadyAsked = false;
    try {
      alreadyAsked = Boolean(localStorage.getItem(`${KEY_PREFIX}${userId}`));
    } catch {
      /* private mode */
    }
    if (alreadyAsked) return undefined;

    if (!isWebPushSupported()) {
      if (isIos() && !isIosStandalonePwa()) {
        let lastAsked = 0;
        try {
          lastAsked = Number(localStorage.getItem(`${IOS_KEY_PREFIX}${userId}`) || 0);
        } catch {
          /* private mode */
        }
        if (Date.now() - lastAsked < IOS_COOLDOWN_MS) return undefined;

        timer.current = setTimeout(() => {
          if (mounted.current) setState('install');
        }, SHOW_DELAY_MS);
        return () => {
          if (timer.current) clearTimeout(timer.current);
        };
      }
      // Any other browser without push support genuinely cannot do this.
      return undefined;
    }

    void (async () => {
      const perm = notificationPermission();
      if (perm === 'granted' && (await hasLocalSubscription())) {
        markDone(); // nothing to ask for
        return;
      }
      timer.current = setTimeout(() => {
        if (!mounted.current) return;
        setState(perm === 'denied' ? 'blocked' : 'ask');
      }, SHOW_DELAY_MS);
    })();

    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [userId, markDone]);

  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await enablePush();
    if (!mounted.current) return;
    setBusy(false);
    markDone();
    if (result.ok) {
      setState('success');
      setTimeout(() => {
        if (mounted.current) setState(null);
      }, 2600);
    } else if (notificationPermission() === 'denied') {
      setState('blocked');
    } else {
      setError(result.error || 'Could Not Enable Notifications.');
    }
  };

  const handleDismiss = () => {
    // The install nudge is deferrable, not answerable. Record it against its
    // own cooldown key so the real permission prompt still runs once the
    // player installs and opens the app.
    if (state === 'install') {
      if (userId) {
        try {
          localStorage.setItem(`${IOS_KEY_PREFIX}${userId}`, String(Date.now()));
        } catch {
          /* private mode */
        }
      }
    } else {
      markDone();
    }
    setState(null);
  };

  if (!state) return null;

  return (
    <div
      className="ca-push-prompt"
      role="dialog"
      aria-modal="true"
      aria-label="Enable notifications"
      onClick={handleDismiss}
    >
      <div className="ca-push-prompt__sheet" onClick={(e) => e.stopPropagation()}>
        {state === 'success' ? (
          <>
            <h3 className="ca-push-prompt__title">You Are All Set</h3>
            <p className="ca-push-prompt__body">Notifications Are On For This Device.</p>
          </>
        ) : state === 'install' ? (
          <>
            <h3 className="ca-push-prompt__title">Add Smarter Poker To Your Home Screen</h3>
            <p className="ca-push-prompt__body">
              Apple Devices Can Only Send Notifications From An Installed App. In Safari, Tap Share,
              Then Add To Home Screen, Then Open Smarter Poker From There.
            </p>
            <p className="ca-push-prompt__note">
              If You Are Using Chrome Or Firefox, Open This Page In Safari First.
            </p>
            <div className="ca-push-prompt__actions">
              <button type="button" className="ca-push-prompt__btn" onClick={handleDismiss}>
                Got It
              </button>
            </div>
          </>
        ) : state === 'blocked' ? (
          <>
            <h3 className="ca-push-prompt__title">Notifications Are Blocked</h3>
            <p className="ca-push-prompt__body">
              {isIos() && !isIosStandalonePwa()
                ? 'On iPhone And iPad, Add Smarter Poker To Your Home Screen First. Tap Share, Then Add To Home Screen, Then Open It From There.'
                : 'Open Your Browser Site Settings For Smarter Poker, Switch Notifications To Allow, Then Reload This Page.'}
            </p>
            <div className="ca-push-prompt__actions">
              <button type="button" className="ca-push-prompt__btn" onClick={handleDismiss}>
                Got It
              </button>
            </div>
          </>
        ) : (
          <>
            <h3 className="ca-push-prompt__title">Never Miss A Seat</h3>
            <p className="ca-push-prompt__body">
              Turn On Notifications And We Will Alert You The Moment Your Seat Opens, A Tournament
              You Registered For Starts, Or Someone Messages You. You Can Change This Any Time In
              Settings.
            </p>
            {error && <p className="ca-push-prompt__error">{error}</p>}
            <div className="ca-push-prompt__actions">
              <button
                type="button"
                className="ca-push-prompt__btn ca-push-prompt__btn--ghost"
                onClick={handleDismiss}
                disabled={busy}
              >
                Not Now
              </button>
              <button
                type="button"
                className="ca-push-prompt__btn"
                onClick={handleEnable}
                disabled={busy}
              >
                {busy ? 'Enabling...' : 'Enable'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
