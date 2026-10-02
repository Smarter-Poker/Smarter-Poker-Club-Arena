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
import { usePromptTurn } from '../../lib/promptLane';
import './ConsentPrompt.css';

/** A beat after the lane clears: never on the first frame, never the instant
    the previous question closes. */
const SETTLE_MS = 2500;

export default function ConsentPrompt() {
  const { user } = useAuthUser();
  const userId = user?.id ?? null;
  /** The beat has passed and the question is still unanswered. */
  const [due, setDue] = useState(false);
  const turn = usePromptTurn('analytics-consent', Boolean(userId) && due);
  const laneClear = turn.clear;

  /* ONE ASK AT A TIME (2026-09-29, src/lib/promptLane.ts). This used to open
     2.5 seconds after sign-in whatever else was on screen - underneath the
     age gate on the first device run, stacked with the notifications sheet
     once the gate closed, and still up on the sign-in form after an under-18
     refusal signed the account out. Now: signed in, the lane clear, a beat,
     and only then; a sign-out or a different account starts over. */
  useEffect(() => {
    setDue(false);
  }, [userId]);

  useEffect(() => {
    if (!userId || due || !laneClear || !analyticsConsentNeeded()) return undefined;
    const t = window.setTimeout(() => setDue(analyticsConsentNeeded()), SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [userId, due, laneClear]);

  if (!turn.onScreen) return null;

  const answer = (v: 'granted' | 'denied') => {
    setAnalyticsConsent(v);
    setDue(false);
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
