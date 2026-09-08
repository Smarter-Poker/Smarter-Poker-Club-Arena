/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGE GATE — a date of birth, stated once, refused under eighteen
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Store readiness, phase 3 (audit tier 0): "A simulated-gambling app rated
 * 17+ or 18+ with only a dismissible localStorage checkbox will not clear
 * age-rating review on either store."
 *
 * The World Hub's signup already asks a full date of birth and refuses under
 * 18. Two gaps remained: accounts created before `profiles.birthday` existed
 * (1,189 of 1,192 when this was written), and the app's own in-app signup.
 * This gate closes both for the app: a signed-in player whose profile has no
 * birthday is asked ONCE, the answer is written by `fn_set_my_birthday`
 * (their own profile, once, refused under 18 with nothing written), and an
 * under-18 answer signs the account out with a plain message.
 *
 * NATIVE ONLY, deliberately. Asking every existing web player for a date of
 * birth on their next visit is a product change on the web, which Dan asked
 * not to change; the stores review the app. Flipping AGE_GATE_ON_WEB below
 * turns it on for the web in one line, and that is Dan's call.
 *
 * Like TOSGuard: 'unknown' (the read failed) shows nothing and re-checks on
 * the next navigation. A blip must not lock the whole app. And like TOSGuard,
 * the UI is not the enforcement boundary; the server is.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { IS_NATIVE_BUILD } from '../../lib/appBase';
import { reportError } from '../../utils/errorReporter';
import { ageOn, latestAdultBirthday, MINIMUM_AGE } from '../../lib/age';
import './TOSAcceptanceModal.css';
import './AgeGate.css';

/** Dan's to flip. The stores review the app; the web is unchanged. */
export const AGE_GATE_ON_WEB = false;

/* Age arithmetic lives in src/lib/age.ts so the sign-up form can share it
   without importing this component. Re-exported for the existing callers. */
export { ageOn, latestAdultBirthday, MINIMUM_AGE };

type GateState = 'checking' | 'verified' | 'missing' | 'unknown';

const ALWAYS_REACHABLE = ['/legal', '/auth', '/help'];

function isAlwaysReachable(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return ALWAYS_REACHABLE.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * Renders NOTHING until a signed-in player is found without a birthday, then
 * a full-screen modal over the app. An overlay beside the route tree rather
 * than a wrapper around it, so App.tsx keeps its shape (see the note there).
 */
export default function AgeGate() {
  const { user, isHydrating } = useAuthUser();
  const location = useLocation();
  const [state, setState] = useState<GateState>('checking');
  const enabled = IS_NATIVE_BUILD || AGE_GATE_ON_WEB;

  useEffect(() => {
    if (!enabled || !user?.id) {
      setState('checking');
      return;
    }
    let cancelled = false;
    supabase
      .from('profiles')
      .select('birthday, age_verified')
      .eq('id', user.id)
      .maybeSingle()
      .then(
        ({ data, error }) => {
          if (cancelled) return;
          if (error || !data) {
            setState('unknown');
            return;
          }
          setState(data.birthday || data.age_verified ? 'verified' : 'missing');
        },
        (err: unknown) => {
          if (cancelled) return;
          reportError(err, 'AgeGate.status_check_failed', { userId: user.id });
          setState('unknown');
        }
      );
    return () => {
      cancelled = true;
    };
  }, [enabled, user?.id, location.pathname]);

  if (!enabled) return null;
  if (isHydrating || !user?.id) return null;
  if (isAlwaysReachable(location.pathname)) return null;
  if (state === 'missing') return <AgeGateModal onVerified={() => setState('verified')} />;
  return null;
}

function AgeGateModal({ onVerified }: { onVerified: () => void }) {
  const [birthday, setBirthday] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const today = useMemo(() => new Date(), []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      const age = ageOn(birthday, today);
      if (age === null) {
        setError('Please Enter Your Date Of Birth.');
        return;
      }
      setBusy(true);
      try {
        // Under 18 never reaches the server: nothing to write, and a
        // minor's date of birth is not something to send anywhere.
        const result =
          age < MINIMUM_AGE
            ? { ok: false, reason: 'under_18' }
            : ((await supabase.rpc('fn_set_my_birthday', { p_birthday: birthday })).data as {
                ok?: boolean;
                reason?: string;
              } | null);
        if (result?.ok) {
          onVerified();
          return;
        }
        if (result?.reason === 'under_18') {
          setRefused(true);
          try {
            await supabase.auth.signOut({ scope: 'local' });
          } catch {
            /* the message below still shows */
          }
          return;
        }
        if (result?.reason === 'already_set') {
          // Set elsewhere between the read and the write. Verified.
          onVerified();
          return;
        }
        setError('Could Not Save Your Date Of Birth. Please Try Again.');
      } catch (err) {
        reportError(err, 'AgeGate.submit_failed');
        setError('Could Not Save Your Date Of Birth. Please Try Again.');
      } finally {
        setBusy(false);
      }
    },
    [birthday, onVerified, today]
  );

  return (
    <div
      className="tos-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
    >
      <div className="tos-modal age-gate">
        <div className="tos-header">
          <div className="tos-icon">18+</div>
          <h1 id="age-gate-title">Confirm Your Age</h1>
          <p className="tos-subtitle">
            Club Arena Is For Players {MINIMUM_AGE} And Older. Enter Your Date Of Birth Once To
            Continue.
          </p>
        </div>

        {refused ? (
          <div className="tos-content age-gate__refused">
            <p>You Must Be {MINIMUM_AGE} Or Older To Use Club Arena. You Have Been Signed Out.</p>
          </div>
        ) : (
          <form className="tos-footer age-gate__form" onSubmit={submit}>
            <label className="age-gate__label" htmlFor="age-gate-birthday">
              Date Of Birth
            </label>
            <input
              id="age-gate-birthday"
              className="age-gate__input"
              type="date"
              value={birthday}
              onChange={(e) => setBirthday(e.target.value)}
              min="1900-01-01"
              max={today.toISOString().slice(0, 10)}
              required
              autoComplete="bday"
            />
            {error && <div className="tos-error">{error}</div>}
            <button type="submit" className="tos-accept-btn" disabled={busy || !birthday}>
              {busy ? 'Saving...' : 'Continue'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
