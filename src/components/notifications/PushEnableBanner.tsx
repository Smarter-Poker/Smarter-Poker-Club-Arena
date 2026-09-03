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
import './PushEnableBanner.css';

type BannerState = null | 'ask' | 'install' | 'blocked';

export default function PushEnableBanner() {
  const [state, setState] = useState<BannerState>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const evaluate = useCallback(async () => {
    if (typeof window === 'undefined') return;

    if (!isWebPushSupported()) {
      // iOS Safari has no PushManager until the site is installed. That is a
      // prerequisite, not a dead end, so say so.
      if (mounted.current) setState(isIos() && !isIosStandalonePwa() ? 'install' : null);
      return;
    }

    // An explicit "off" is a decision, not a gap. Do not nag past it; Settings
    // is where somebody who changes their mind goes.
    if (isOptedOut()) {
      if (mounted.current) setState(null);
      return;
    }

    if (notificationPermission() === 'denied') {
      if (mounted.current) setState('blocked');
      return;
    }

    const subscribed = await hasLocalSubscription();
    if (mounted.current) setState(subscribed ? null : 'ask');
  }, []);

  useEffect(() => {
    void evaluate();
  }, [evaluate]);

  /**
   * DELIBERATE: enablePush() is awaited straight out of the click handler.
   * iOS only honours the permission prompt while the originating tap gesture
   * is alive, so nothing may be awaited ahead of it.
   */
  const handleEnable = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await enablePush();
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

  if (state === 'install') {
    return (
      <div className="ca-push-banner ca-push-banner--info">
        <div className="ca-push-banner__text">
          <strong className="ca-push-banner__title">Turn On Seat Alerts</strong>
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
      <div className="ca-push-banner ca-push-banner--info">
        <div className="ca-push-banner__text">
          <strong className="ca-push-banner__title">Notifications Are Blocked</strong>
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
        <strong className="ca-push-banner__title">Never Miss A Seat</strong>
        <span className="ca-push-banner__body">
          Get Alerted On This Device The Moment Your Seat Opens, Even When Smarter Poker Is Closed.
        </span>
        {error && <span className="ca-push-banner__error">{error}</span>}
      </div>
      <button type="button" className="ca-push-banner__btn" onClick={handleEnable} disabled={busy}>
        {busy ? 'Enabling...' : 'Turn On'}
      </button>
    </div>
  );
}
