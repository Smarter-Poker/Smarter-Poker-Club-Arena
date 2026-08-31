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
import { useLocation } from 'react-router-dom';
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

/**
 * ONE re-offer, on purpose. Read this before changing the suffix again.
 *
 * This prompt asks once per account per browser and then closes that door for
 * good. Between 2026-08-19 and 2026-08-29 the door was being closed against a
 * question nobody could answer yes to: the ROOT service worker this app enrols
 * against could not install at all, because one entry in its precache manifest
 * 404'd (World Hub PR #929). Every player who saw this sheet in that window and
 * tapped Not Now — or tapped Enable, hit the error, and gave up — had
 * `sp_firstrun_notif_<uid>` written anyway, permanently.
 *
 * Measured the day the worker was fixed: 1 subscribed user out of 1,023
 * profiles, against 2,437 seat offers in seven days skipped for
 * `no_subscription`. Shipping the fix without this line would have fixed push
 * for an audience that could never be asked again.
 *
 * `_v2` gives everybody exactly one more ask. It is NOT a re-prompt lever to
 * reach for whenever enrolment looks low — bumping it again re-asks 1,000
 * people who already said no, which is nagging, and the honest reading of a
 * second no is that they meant the first one. Bump it only if the enrolment
 * path is broken again in a way that made their answer meaningless, and say
 * here what broke.
 *
 * The suffix stays in step with the World Hub's own key
 * (src/components/FirstRunNotificationPrompt.jsx). Same origin, same device,
 * same single subscription behind both apps: if one app re-offers and the other
 * does not, a player gets asked twice about the same thing.
 */
const KEY_PREFIX = 'sp_firstrun_notif_v2_';
const IOS_KEY_PREFIX = 'sp_firstrun_ios_install_';
const IOS_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // a week is long enough not to nag
const SHOW_DELAY_MS = 20_000; // let the player land before asking for anything

/**
 * Where the ask is DEFERRED, never spent.
 *
 * This prompt asks once per account per browser and then closes that door for
 * good, so the twenty-second timer landing on the wrong screen does not cost a
 * prompt, it costs the only prompt. `/table/:tableId` is the felt: a modal over
 * a live hand is dismissed reflexively, by a person with a decision to make and
 * a clock running, and `sp_firstrun_notif_<uid>` would then record that reflex
 * as a considered no.
 *
 * Deliberately a DEFERRAL and not a suppression. The timer is not armed on
 * these routes and is armed fresh when the player leaves for somewhere the
 * question can actually be read. Somebody who only ever plays still gets asked,
 * in the lobby, on the way out.
 *
 * Paths are basename-relative: BrowserRouter carries basename="/hub/club-arena"
 * (src/main.tsx), so useLocation() reports "/table/abc", not the full URL.
 */
const SUPPRESSED_ROUTES = [
  '/auth', // signed out, or mid sign-in: the subscribe endpoint would 401 anyway
  '/table', // the felt
  '/replay', // full-screen hand playback
  '/sim',
  '/share', // a shared hand, often opened by somebody with no account
];

function isSuppressedRoute(pathname: string): boolean {
  return SUPPRESSED_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
}

type PromptState = null | 'ask' | 'install' | 'blocked' | 'success';

/** What we have decided to ask, held until the route allows asking it. */
type PendingAsk = null | 'ask' | 'install' | 'blocked';

export default function FirstRunPushPrompt() {
  // Reads the session itself rather than taking a prop, so App.tsx can mount it
  // beside the other hosts without threading auth through the root. Nothing
  // renders until somebody is signed in: the subscribe endpoint is
  // authenticated, so prompting a signed-out visitor could only ever fail.
  const { user } = useAuthUser();
  const userId = user?.id ?? null;
  const { pathname } = useLocation();
  const suppressed = isSuppressedRoute(pathname);

  const [state, setState] = useState<PromptState>(null);
  const [pending, setPending] = useState<PendingAsk>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  /** The eligibility check is one-shot: it reads storage and the subscription. */
  const decided = useRef(false);
  /** Once answered, nothing re-arms, whatever the player navigates to next. */
  const answered = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
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

  /* ── Decide WHAT to ask. Runs once, and never on the route. ──────────── */
  useEffect(() => {
    if (!userId || typeof window === 'undefined') return;
    if (decided.current || answered.current) return;
    decided.current = true;

    let alreadyAsked = false;
    try {
      alreadyAsked = Boolean(localStorage.getItem(`${KEY_PREFIX}${userId}`));
    } catch {
      /* private mode */
    }
    if (alreadyAsked) return;

    if (!isWebPushSupported()) {
      if (isIos() && !isIosStandalonePwa()) {
        let lastAsked = 0;
        try {
          lastAsked = Number(localStorage.getItem(`${IOS_KEY_PREFIX}${userId}`) || 0);
        } catch {
          /* private mode */
        }
        if (Date.now() - lastAsked < IOS_COOLDOWN_MS) return;
        setPending('install');
      }
      // Any other browser without push support genuinely cannot do this.
      return;
    }

    void (async () => {
      const perm = notificationPermission();
      // A denied browser permission cannot be repaired from inside the app.
      // Raising a modal here only blocks the lobby with instructions the
      // player cannot act on in context, and it used to interrupt every
      // authenticated production E2E journey after twenty seconds. The
      // Notifications page keeps the persistent, non-blocking recovery path
      // through PushEnableBanner, so record this one-time ask as settled and
      // let the player keep playing.
      if (perm === 'denied') {
        markDone();
        answered.current = true;
        return;
      }
      if (perm === 'granted' && (await hasLocalSubscription())) {
        markDone(); // nothing to ask for
        return;
      }
      if (mounted.current) setPending('ask');
    })();
  }, [userId, markDone]);

  /* ── Decide WHEN to ask. Re-arms on every route change. ──────────────── */
  useEffect(() => {
    // `suppressed` is a dependency, so leaving the felt re-runs this and starts
    // a fresh delay. Nothing is consumed while the player is on a bad screen:
    // the timer is simply never armed there.
    if (!pending || state || suppressed) return undefined;
    const t = setTimeout(() => {
      if (mounted.current) setState(pending);
    }, SHOW_DELAY_MS);
    return () => clearTimeout(t);
  }, [pending, state, suppressed]);

  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await enablePush();
    if (!mounted.current) return;
    setBusy(false);

    /**
     * ONLY AN ANSWER SPENDS THE ASK.
     *
     * markDone() used to run here unconditionally, which meant a player who
     * tapped Enable and hit a TECHNICAL failure — the service worker still
     * installing, a dropped VAPID fetch, a flaky minute of signal — had their
     * one and only prompt recorded as spent. They wanted notifications. They
     * said so. The platform wrote down "asked, done" and never offered again.
     *
     * That is exactly how the 2026-08-19..29 outage turned a fixable bug into a
     * permanent loss of audience, and the outage is over but the mechanism is
     * not: any transient failure still burns the prompt.
     *
     * Success and a DENIED permission are both real answers and are recorded.
     * Anything else leaves the door open for the next session. `answered` is
     * still set either way, so nothing re-raises the sheet at the player while
     * they are standing here reading the error.
     */
    const wasAnswered = result.ok || notificationPermission() === 'denied';
    if (wasAnswered) markDone();
    // Clearing `pending` is what stops the re-arm effect from raising it again
    // after the success card fades or the player navigates.
    answered.current = true;
    setPending(null);
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
    answered.current = true;
    setPending(null);
    setState(null);
  };

  if (!state) return null;

  return (
    <div
      className="ca-push-prompt"
      role="dialog"
      aria-modal="true"
      aria-label="Enable Notifications"
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
