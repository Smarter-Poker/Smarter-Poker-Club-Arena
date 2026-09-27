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
import { SpadeConsole, type ConsoleCrest, type ConsoleFamily } from '../console/SpadeConsole';
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
  { eyebrow: string; title: string; body: string }
> = {
  cashier: {
    eyebrow: 'Notifications',
    title: 'Cashier Alerts',
    body: 'Know The Moment Chips Land In Your Wallet Or A Cashout Is Decided, Even When Smarter Poker Is Closed.',
  },
  cashier_receipt: {
    eyebrow: 'Notifications',
    title: 'Receipt Alerts',
    body: 'Turn On Notifications And Every Buy-In And Cashout Receipt Reaches This Device The Moment It Is Issued.',
  },
  tournament_registration: {
    eyebrow: 'Notifications',
    title: 'Start Alerts',
    body: 'Turn On Notifications And We Will Alert You Fifteen Minutes And Two Minutes Before Your Tournament Starts.',
  },
};

/**
 * #ClubArenaConsole (2026-09-27, owner review of #5489): IN CONTEXT THE OFFER
 * IS ITS OWN CONSOLE. A message and two actions is SpadeConsole + plates
 * (skill section 4, step 4): the title engraved in the painted head, the copy
 * on the black glass, Not Now on the steel plate and Turn On on the lit
 * plate, all printed into the approved master. It is a separate surface
 * placed BESIDE the console it relates to, never nested inside another
 * console's glass (FRAMES SHOULD NEVER SIT ON TOP OF FRAMES), the same way the
 * cashier's wallet is a separate master above its console.
 *
 * All three wear the spade chassis because it is the family whose primary
 * plate is the lit blue glass (Turn On) beside the steel secondary (Not Now).
 * The crest follows the skill's section map: the diamond for wallet and
 * transaction surfaces. On Game Details the offer sits inside the Details
 * panel, whose painted shell already carries a centred crown notch, so it
 * wears the FLAT head: a second emblem directly under the shell's would read
 * as art on art.
 */
const CONTEXT_FAMILY: Record<
  'cashier' | 'cashier_receipt' | 'tournament_registration',
  { family: ConsoleFamily; crest: ConsoleCrest }
> = {
  cashier: { family: 'spade', crest: 'diamond' },
  cashier_receipt: { family: 'spade', crest: 'diamond' },
  tournament_registration: { family: 'spade', crest: 'flat' },
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

  if (contextual) {
    const key = surface as keyof typeof CONTEXT_COPY;
    const dress = CONTEXT_FAMILY[key];
    if (state === 'install') {
      return (
        <SpadeConsole
          as="section"
          family={dress.family}
          crest={dress.crest}
          eyebrow="Notifications"
          title="Add To Home Screen"
          pill="Install"
          pillInk="blue"
          foot="plates"
          plates={{
            secondary: { label: 'Not Now', onClick: handleDismiss },
            primary: { label: 'Got It', ink: 'white', onClick: handleDismiss },
          }}
          className="ca-push-offer"
          data-surface={surface}
          aria-label="Add Smarter Poker To Your Home Screen"
        >
          <p className="sc-copy">
            Apple Devices Can Only Send Notifications From An Installed App. In Safari, Tap Share,
            Then Add To Home Screen, Then Open Smarter Poker From There.
          </p>
        </SpadeConsole>
      );
    }
    const copy = CONTEXT_COPY[key];
    return (
      <SpadeConsole
        as="section"
        family={dress.family}
        crest={dress.crest}
        eyebrow={copy.eyebrow}
        title={copy.title}
        pill="Off"
        pillInk="muted"
        foot="plates"
        plates={{
          secondary: { label: 'Not Now', onClick: handleDismiss, disabled: busy },
          primary: {
            label: busy ? 'Enabling...' : 'Turn On',
            ink: 'white',
            onClick: handleEnable,
            disabled: busy,
          },
        }}
        className="ca-push-offer"
        data-surface={surface}
        aria-label={copy.title}
      >
        <p className="sc-copy">{copy.body}</p>
        {/* The one string here that is not a literal: whatever the push
            service said. Title Cased where it is printed. */}
        {error && <p className="sc-copy sc-ink--red">{titleCase(error)}</p>}
      </SpadeConsole>
    );
  }

  // The Notifications page door (2026-09-14 ruling): inked on that page's
  // glass, one lit word, no frame of its own. Unchanged.
  if (state === 'install') {
    return (
      <div className="ca-push-banner">
        <div className="ca-push-banner__text">
          <strong className="ca-push-banner__title sc-ink--silver">Turn On Seat Alerts</strong>
          <span className="ca-push-banner__body">
            Apple Devices Can Only Send Notifications From An Installed App. In Safari, Tap Share,
            Then Add To Home Screen, Then Open Smarter Poker From There.
          </span>
        </div>
      </div>
    );
  }

  if (state === 'blocked') {
    return (
      <div className="ca-push-banner">
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

  return (
    <div className="ca-push-banner">
      <div className="ca-push-banner__text">
        <strong className="ca-push-banner__title sc-ink--silver">Never Miss A Seat</strong>
        <span className="ca-push-banner__body">
          Get Alerted On This Device The Moment Your Seat Opens, Even When Smarter Poker Is Closed.
        </span>
        {/* The one string on this surface that is not a literal: whatever the
            push service said. Title Cased where it is printed, because the
            copy gates cannot see it. */}
        {error && <span className="ca-push-banner__error sc-ink--red">{titleCase(error)}</span>}
      </div>
      <button
        type="button"
        className="ca-push-banner__btn sc-ink--blue"
        onClick={handleEnable}
        disabled={busy}
      >
        {busy ? 'Enabling...' : 'Turn On'}
      </button>
    </div>
  );
}
