/**
 * PushEnableBanner — the always-available way back to push enrolment.
 *
 * FirstRunPushPrompt asks once and then never again, by design: a modal that
 * reappears is a modal people learn to dismiss without reading. But "asked
 * once" is a one-way door, and the notifications page is exactly where a
 * player goes when they wonder why their phone has been quiet. This is the
 * door back.
 *
 * It renders only when there is something to offer: push is supported, the
 * device holds no subscription, and the player has not explicitly turned push
 * off (isOptedOut). A blocked browser gets the unblock instruction instead of
 * a button that cannot work. On an iPhone that has not been installed to the
 * Home Screen, PushManager does not exist at all, so it shows the install
 * instruction rather than nothing.
 *
 * Copy is Title Case with no em dashes, per CLAUDE.md section 5.7.
 *
 * #ClubArenaConsole (2026-09-14): A BANNER IS NOT A CARD. It is inked onto the
 * black glass - the title in engraved silver, the copy in Inter, one engraved
 * rule under it - and never framed: no border, no radius, no fill, no plate.
 * The one action is a lit word, not a drawn button. The failure line is the
 * one string here that comes from DATA rather than a literal, so it goes
 * through titleCase() at the print site (Dan 2026-09-14: "THE FIRST LETTER OF
 * EVERY WORD MUST ALWAYS BE CAPITALIZED"); the copy gates read literals only
 * and would never have seen it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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
  decidePushOffer,
  isContextualSurface,
  isCoolingDown,
  startCooldown,
  type PushOffer,
  type PushPromptSurface,
} from '../../lib/pushPromptPolicy';
import { recordPushPromptEvent } from '../../lib/pushPromptTelemetry';
import { titleCase } from '../../utils/titleCase';
import '../console/SpadeConsole.css';
import './PushEnableBanner.css';

type BannerState = PushOffer;

/**
 * CONTEXTUAL USE (2026-09-27). The same inked banner, laid on the glass of a
 * surface where the value of a push is obvious at that moment: the cashier, a
 * cashier receipt, a tournament just registered for. There it is
 * non-blocking, carries a Not Now, never shows the blocked instruction, and
 * respects a per-surface cooldown started when it is first shown
 * (src/lib/pushPromptPolicy.ts). Every showing and every answer is recorded
 * to push_prompt_events.
 *
 * Copy per surface. Literals only, so the Title Case and em dash gates read
 * every word of it.
 */
const CONTEXT_COPY: Record<
  'cashier' | 'cashier_receipt' | 'tournament_registration',
  { title: string; body: string }
> = {
  cashier: {
    title: 'Get Cashier Alerts',
    body: 'Know The Moment Chips Land In Your Wallet Or A Cashout Is Decided, Even When Smarter Poker Is Closed.',
  },
  cashier_receipt: {
    title: 'Get Receipts On Your Phone',
    body: 'Turn On Notifications And Every Buy-In And Cashout Receipt Reaches This Device The Moment It Is Issued.',
  },
  tournament_registration: {
    title: 'Know When It Starts',
    body: 'Turn On Notifications And We Will Alert You Fifteen Minutes And Two Minutes Before Your Tournament Starts.',
  },
};

export interface PushEnableBannerProps {
  /** Where this banner sits. Defaults to the Notifications page recovery door. */
  surface?: PushPromptSurface;
  /** Required for a contextual surface: its cooldown is per account. */
  userId?: string | null;
}

export default function PushEnableBanner({
  surface = 'notifications_page',
  userId = null,
}: PushEnableBannerProps = {}) {
  const contextual = isContextualSurface(surface);
  const [state, setState] = useState<BannerState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  /** One "shown" per mount, however often the state is re-evaluated. */
  const recordedShown = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const evaluate = useCallback(async () => {
    if (typeof window === 'undefined') return;
    // A contextual nudge belongs to an account (its cooldown is keyed on it)
    // and waits out its window. The Notifications page door never cools down.
    if (contextual && (!userId || isCoolingDown(surface, userId))) {
      if (mounted.current) setState(null);
      return;
    }
    const supported = isWebPushSupported();
    const optedOut = supported && isOptedOut();
    const permission = notificationPermission();
    // Only ask the service worker when the cheap answers leave an offer open.
    const subscribed =
      supported && !optedOut && permission !== 'denied' ? await hasLocalSubscription() : false;
    const offer = decidePushOffer(
      {
        supported,
        // iOS Safari has no PushManager until the site is installed. That is a
        // prerequisite, not a dead end, so say so.
        iosNeedsInstall: isIos() && !isIosStandalonePwa(),
        // An explicit "off" is a decision, not a gap. Do not nag past it;
        // Settings is where somebody who changes their mind goes.
        optedOut,
        permission,
        subscribed,
      },
      contextual
    );
    if (mounted.current) setState(offer);
  }, [contextual, surface, userId]);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  // Record the showing once, and start a contextual surface's cooldown the
  // moment the player has actually seen it.
  useEffect(() => {
    if (!state || recordedShown.current) return;
    recordedShown.current = true;
    if (contextual && userId) startCooldown(surface, userId);
    if (state === 'install') recordPushPromptEvent(surface, 'unsupported', 'ios_install_shown');
    else recordPushPromptEvent(surface, 'shown', state === 'blocked' ? 'blocked' : null);
  }, [state, contextual, surface, userId]);

  const handleDismiss = () => {
    if (state === 'ask') recordPushPromptEvent(surface, 'declined', 'not_now');
    setState(null);
  };

  /**
   * DELIBERATE: enablePush() is awaited straight out of the click handler.
   * iOS only honours the permission prompt while the originating tap gesture
   * is alive, so nothing may be awaited ahead of it.
   */
  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await enablePush({ surface });
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      setState(null);
      return;
    }
    if (notificationPermission() === 'denied') {
      setState('blocked');
      return;
    }
    setError(result.error || 'Could Not Enable Notifications.');
  };

  if (!state) return null;

  // Inside a console's glass (the cashier, its receipt) the banner lines up
  // with the glass's own rows instead of indenting past them.
  const bannerClass =
    surface === 'cashier' || surface === 'cashier_receipt'
      ? 'ca-push-banner ca-push-banner--in-console'
      : 'ca-push-banner';

  if (state === 'install') {
    return (
      <div className={bannerClass} data-surface={surface}>
        <div className="ca-push-banner__text">
          {contextual ? (
            <strong className="ca-push-banner__title sc-ink--silver">
              Add Smarter Poker To Your Home Screen
            </strong>
          ) : (
            <strong className="ca-push-banner__title sc-ink--silver">Turn On Seat Alerts</strong>
          )}
          <span className="ca-push-banner__body">
            Apple Devices Can Only Send Notifications From An Installed App. In Safari, Tap Share,
            Then Add To Home Screen, Then Open Smarter Poker From There.
          </span>
        </div>
        {contextual && (
          <div className="ca-push-banner__actions">
            <button
              type="button"
              className="ca-push-banner__btn sc-ink--blue"
              onClick={handleDismiss}
            >
              Got It
            </button>
          </div>
        )}
      </div>
    );
  }

  if (state === 'blocked') {
    return (
      <div className={bannerClass} data-surface={surface}>
        <div className="ca-push-banner__text">
          <strong className="ca-push-banner__title sc-ink--silver">
            Notifications Are Blocked
          </strong>
          <span className="ca-push-banner__body">
            Open Your Browser Site Settings For Smarter Poker, Switch Notifications To Allow, Then
            Reload This Page.
          </span>
        </div>
      </div>
    );
  }

  const copy = contextual ? CONTEXT_COPY[surface as keyof typeof CONTEXT_COPY] : null;

  return (
    <div className={bannerClass} data-surface={surface}>
      <div className="ca-push-banner__text">
        {copy ? (
          <>
            <strong className="ca-push-banner__title sc-ink--silver">{copy.title}</strong>
            <span className="ca-push-banner__body">{copy.body}</span>
          </>
        ) : (
          <>
            <strong className="ca-push-banner__title sc-ink--silver">Never Miss A Seat</strong>
            <span className="ca-push-banner__body">
              Get Alerted On This Device The Moment Your Seat Opens, Even When Smarter Poker Is
              Closed.
            </span>
          </>
        )}
        {/* The one string on this surface that is not a literal: whatever the
            push service said. Title Cased where it is printed, because the
            copy gates cannot see it. */}
        {error && <span className="ca-push-banner__error sc-ink--red">{titleCase(error)}</span>}
      </div>
      <div className="ca-push-banner__actions">
        <button
          type="button"
          className="ca-push-banner__btn sc-ink--blue"
          onClick={handleEnable}
          disabled={busy}
        >
          {busy ? 'Enabling...' : 'Turn On'}
        </button>
        {contextual && (
          <button
            type="button"
            className="ca-push-banner__btn ca-push-banner__btn--quiet sc-ink--muted"
            onClick={handleDismiss}
            disabled={busy}
          >
            Not Now
          </button>
        )}
      </div>
    </div>
  );
}
