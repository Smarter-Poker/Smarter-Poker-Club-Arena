/**
 * FirstRunPushPrompt — Club Arena's notification opt-in host.
 *
 * 2026-09-27: no longer only a one-time sheet. It hosts every opt-in ask: the
 * first visit, plus the meaningful moments features announce with
 * requestPushNudge() (joining a club, a rakeback receipt). WHETHER an ask may
 * appear is decided by src/lib/pushNudgePolicy.ts, shared in behaviour and in
 * localStorage with the World Hub: Not Now starts a cool-down instead of
 * closing the door, at most one ask a day, never when this device is already
 * on, turned off by the player, or blocked, and never for the owner's
 * receipts (they route to Production Alerts). A moment's ask is a card that
 * does not block the page; the first-visit ask keeps its sheet.
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
  isOptedOut,
  isWebPushSupported,
  notificationPermission,
} from '../../lib/pushClient';
import {
  decideNudge,
  NUDGE_EVENT,
  readNudgeState,
  recordDismissed,
  recordShown,
  takePendingNudge,
  writeLedger,
  isNudgeMoment,
  type NudgeMoment,
} from '../../lib/pushNudgePolicy';
import { useAuthUser } from '../../hooks/useAuthUser';
import './FirstRunPushPrompt.css';

/**
 * The legacy one-time key. Still WRITTEN when the player answers, because the
 * World Hub's older bundle and the E2E harnesses read it as "already asked".
 * It is no longer a permanent door: pushNudgePolicy reads it as one earlier
 * Not Now and applies the cool-down.
 *
 * ONE re-offer, on purpose (2026-08-29): the root worker could not install
 * from 2026-08-19 to 2026-08-29 (World Hub PR #929), so every ask in that
 * window was spent on a question nobody could answer yes to. `_v2` gave
 * everybody exactly one more ask. Do not bump it as a re-prompt lever.
 *
 * The suffix stays in step with the World Hub's own key
 * (src/components/notifications/FirstRunNotificationPrompt.jsx).
 */
const KEY_PREFIX = 'sp_firstrun_notif_v2_';
const IOS_KEY_PREFIX = 'sp_firstrun_ios_install_';
const SHOW_DELAY_MS = 20_000; // let the player land before asking for anything
// A moment the player just created is asked about promptly, but not in the
// same frame as the thing they came to do.
const MOMENT_DELAY_MS = 2_500;

/**
 * Where the ask is DEFERRED, never spent. `/table/:tableId` is the felt: a
 * sheet over a live hand is dismissed reflexively by a person with a clock
 * running. The timer is not armed on these routes and is armed fresh when the
 * player leaves for somewhere the question can actually be read.
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

function isAutomatedBrowser(): boolean {
  // An automation-driven browser is not a person and is never asked: it cannot
  // consent, and a sheet over an unattended journey blocks the run.
  try {
    return typeof navigator !== 'undefined' && navigator.webdriver === true;
  } catch {
    return false;
  }
}

const COPY: Record<NudgeMoment, { title: string; body: string }> = {
  first_run: {
    title: 'Never Miss A Seat',
    body: 'Turn On Notifications And We Will Alert You The Moment Your Seat Opens, A Tournament You Registered For Starts, Or Someone Messages You. You Can Change This Any Time In Settings.',
  },
  club_joined: {
    title: 'Stay In Touch With Your Club',
    body: 'Turn On Notifications And We Will Tell You When A Seat Opens, A Tournament You Registered For Starts, Or Your Club Messages You.',
  },
  rakeback_receipt: {
    title: 'Get Your Rakeback Receipts On This Device',
    body: 'Turn On Notifications And We Will Tell You When A Rakeback Receipt Is Posted To Your Account. You Can Change This Any Time In Settings.',
  },
  invoice_workspace: {
    title: 'Get Invoice Updates On This Device',
    body: 'Turn On Notifications And We Will Tell You When A New Invoice Or Club Statement Arrives. You Can Change This Any Time In Settings.',
  },
};

type PromptState = null | 'ask' | 'install' | 'blocked' | 'success';

/** What we have decided to ask, held until the route allows asking it. */
type PendingAsk = null | { moment: NudgeMoment; variant: 'ask' | 'install' };

export default function FirstRunPushPrompt() {
  // Nothing renders until somebody is signed in: the subscribe endpoint is
  // authenticated, so prompting a signed-out visitor could only ever fail.
  const { user } = useAuthUser();
  const userId = user?.id ?? null;
  const { pathname } = useLocation();
  const suppressed = isSuppressedRoute(pathname);

  const [state, setState] = useState<PromptState>(null);
  const [moment, setMoment] = useState<NudgeMoment>('first_run');
  const [pending, setPending] = useState<PendingAsk>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  /** The first-visit check is one-shot per account. */
  const decidedFor = useRef<string | null>(null);

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

  /**
   * Decide WHETHER to ask. Everything about the rules is in pushNudgePolicy;
   * this only reads the device honestly.
   */
  const consider = useCallback(
    async (requested: NudgeMoment) => {
      if (!userId || typeof window === 'undefined' || isAutomatedBrowser()) return;
      const permission = notificationPermission();
      const device = {
        supported: isWebPushSupported(),
        iosNeedsInstall: false,
        permission,
        subscribed: false,
        optedOut: isOptedOut(),
      };
      if (!device.supported) device.iosNeedsInstall = isIos() && !isIosStandalonePwa();
      else if (permission === 'granted') device.subscribed = await hasLocalSubscription();
      if (!mounted.current) return;

      const stored = readNudgeState(window.localStorage, userId);
      const decision = decideNudge({
        userId,
        moment: requested,
        now: Date.now(),
        device,
        ...stored,
      });
      if (!decision.show) {
        // A denied browser permission cannot be repaired from inside the app,
        // and a device that is already on has nothing to ask about: record the
        // first-visit ask as settled so older bundles agree. The Notifications
        // page keeps the non-blocking recovery path (PushEnableBanner).
        if (
          requested === 'first_run' &&
          (decision.reason === 'blocked' || decision.reason === 'already_on')
        ) {
          markDone();
        }
        return;
      }
      // A moment the player just created outranks a first-visit ask still
      // waiting for its delay; two moments keep the first.
      setPending((current) =>
        current && (current.moment !== 'first_run' || requested === 'first_run')
          ? current
          : { moment: requested, variant: decision.variant }
      );
    },
    [userId, markDone]
  );

  /* ── The first-visit ask. Decided once per account, never on the route. ── */
  useEffect(() => {
    if (!userId || decidedFor.current === userId) return;
    decidedFor.current = userId;
    void consider('first_run');
  }, [userId, consider]);

  /* ── Meaningful moments announced by features (requestPushNudge). ─────── */
  useEffect(() => {
    if (!userId || typeof window === 'undefined') return undefined;
    const onNudge = (e: Event) => {
      const m = (e as CustomEvent<{ moment?: string }>).detail?.moment;
      if (!isNudgeMoment(m)) return;
      takePendingNudge(); // consumed here
      void consider(m);
    };
    window.addEventListener(NUDGE_EVENT, onNudge);
    const early = takePendingNudge();
    if (early) void consider(early);
    return () => window.removeEventListener(NUDGE_EVENT, onNudge);
  }, [userId, consider]);

  /* ── Decide WHEN to ask. Re-arms on every route change. ──────────────── */
  useEffect(() => {
    // `suppressed` is a dependency, so leaving the felt re-runs this and starts
    // a fresh delay. Nothing is consumed while the player is on a bad screen.
    if (!pending || state || suppressed) return undefined;
    const delay = pending.moment === 'first_run' ? SHOW_DELAY_MS : MOMENT_DELAY_MS;
    const t = setTimeout(() => {
      const uid = userIdRef.current;
      if (!mounted.current || !uid) return;
      writeLedger(
        window.localStorage,
        uid,
        recordShown(readNudgeState(window.localStorage, uid).ledger, Date.now())
      );
      setMoment(pending.moment);
      setError(null);
      setState(pending.variant);
    }, delay);
    return () => clearTimeout(t);
  }, [pending, state, suppressed]);

  const close = () => {
    setPending(null);
    setState(null);
  };

  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    // DELIBERATE: nothing is awaited before enablePush(). iOS only honours
    // the permission dialog while the originating tap gesture is alive.
    const result = await enablePush();
    if (!mounted.current) return;
    setBusy(false);

    /**
     * ONLY AN ANSWER SPENDS THE ASK. Success and a DENIED permission are real
     * answers and are recorded; a technical failure (worker still installing,
     * a dropped VAPID fetch, a flaky minute of signal) leaves the door open.
     */
    const wasAnswered = result.ok || notificationPermission() === 'denied';
    if (wasAnswered) markDone();
    setPending(null);
    if (result.ok) {
      setState('success');
      setTimeout(() => {
        if (mounted.current) close();
      }, 2600);
    } else if (notificationPermission() === 'denied') {
      setState('blocked');
    } else {
      setError(result.error || 'Could Not Enable Notifications.');
    }
  };

  const handleDismiss = () => {
    if (userId) {
      const stored = readNudgeState(window.localStorage, userId);
      if (state === 'install') {
        // The install nudge is deferrable, not answerable: its own cool-down
        // key, so the real permission prompt still runs once installed.
        try {
          localStorage.setItem(`${IOS_KEY_PREFIX}${userId}`, String(Date.now()));
        } catch {
          /* private mode */
        }
        writeLedger(
          window.localStorage,
          userId,
          recordDismissed(stored.ledger, Date.now(), stored.legacyAskedAt)
        );
      } else if (state === 'ask') {
        // Not Now: a cool-down, not a permanent no.
        writeLedger(
          window.localStorage,
          userId,
          recordDismissed(stored.ledger, Date.now(), stored.legacyAskedAt)
        );
        markDone();
      }
    }
    close();
  };

  if (!state) return null;

  const copy = COPY[moment] ?? COPY.first_run;
  const modal = moment === 'first_run' || state === 'blocked';

  return (
    <div
      className={modal ? 'ca-push-prompt' : 'ca-push-prompt ca-push-prompt--card'}
      role="dialog"
      aria-modal={modal ? 'true' : 'false'}
      aria-label="Enable Notifications"
      data-push-nudge={moment}
      onClick={modal ? handleDismiss : undefined}
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
                ? 'On IPhone And IPad, Add Smarter Poker To Your Home Screen First. Tap Share, Then Add To Home Screen, Then Open It From There.'
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
            <h3 className="ca-push-prompt__title">{copy.title}</h3>
            <p className="ca-push-prompt__body">{copy.body}</p>
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
