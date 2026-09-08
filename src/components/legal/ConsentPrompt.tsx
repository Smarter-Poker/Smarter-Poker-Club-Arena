/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CONSENT PROMPT — "help improve Club Arena?" asked once, in the app
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Product analytics (PostHog) is opt-in inside the app (src/lib/consent.ts).
 * This is the one question, shown once to a signed-in player who has never
 * answered, as a small sheet that never blocks play. Either answer is
 * remembered; the Settings page has the toggle to change it later.
 *
 * Renders nothing on the web (analytics there is unchanged) and nothing once
 * answered.
 */

import { useEffect, useState } from 'react';
import { useAuthUser } from '../../hooks/useAuthUser';
import { analyticsConsentNeeded, setAnalyticsConsent } from '../../lib/consent';
import './ConsentPrompt.css';

export default function ConsentPrompt() {
  const { user } = useAuthUser();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    // A beat after the lobby paints, never on top of the first frame.
    const t = window.setTimeout(() => setOpen(analyticsConsentNeeded()), 2500);
    return () => window.clearTimeout(t);
  }, [user?.id]);

  if (!open) return null;

  const answer = (v: 'granted' | 'denied') => {
    setAnalyticsConsent(v);
    setOpen(false);
  };

  return (
    <div className="ca-consent" role="dialog" aria-labelledby="ca-consent-title">
      <div className="ca-consent__card">
        <h3 id="ca-consent-title">Help Improve Club Arena?</h3>
        <p>
          Share Anonymous Usage Data So We Can See Which Features Work And Fix What Does Not. No
          Hands, No Chips, No Messages. You Can Change This Any Time In Settings.
        </p>
        <div className="ca-consent__actions">
          <button type="button" className="ca-consent__btn" onClick={() => answer('denied')}>
            Not Now
          </button>
          <button
            type="button"
            className="ca-consent__btn ca-consent__btn--primary"
            onClick={() => answer('granted')}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
