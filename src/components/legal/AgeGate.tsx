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
 * FAILS CLOSED (2026-09-29, reversing the original design). This gate first
 * shipped failing OPEN - an unreadable status rendered nothing, "so a blip
 * must not lock the whole app". The first device walkthrough showed what
 * that costs: the status read was broken for EVERY player (it selected a
 * column the privacy lockdown had revoked), so the gate never appeared to
 * anyone, and because failing open is silent, nobody noticed. A compliance
 * gate that breaks quietly in the permissive direction is not a gate.
 *
 * Now the question goes to fn_my_age_gate_status() (own row, server-side,
 * immune to column grants), gets one quiet retry, and an answer that still
 * cannot be had SHOWS the gate. A genuine blip costs a verified adult one
 * question at most: fn_set_my_birthday returns already_set for them and the
 * modal lets them through. A broken status now fails loudly instead.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { supabase } from '../../lib/supabase';
import { IS_NATIVE_BUILD } from '../../lib/appBase';
import { reportError } from '../../utils/errorReporter';
import { useHoldPromptLane } from '../../lib/promptLane';
import { ageOn, latestAdultBirthday, MINIMUM_AGE } from '../../lib/age';
import './TOSAcceptanceModal.css';
import './AgeGate.css';

/** Dan's to flip. The stores review the app; the web is unchanged. */
export const AGE_GATE_ON_WEB = false;

/* Age arithmetic lives in src/lib/age.ts so the sign-up form can share it
   without importing this component. Re-exported for the existing callers. */
export { ageOn, latestAdultBirthday, MINIMUM_AGE };

type GateState = 'checking' | 'verified' | 'missing';

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
  const [refused, setRefused] = useState(false);
  const enabled = IS_NATIVE_BUILD || AGE_GATE_ON_WEB;

  /* The gate holds the prompt lane (src/lib/promptLane.ts) for as long as the
     answer is OWED - while it is still being looked up, while the question is
     up (on every route, the legal pages included), and while a refusal is on
     screen - so no other sheet rises underneath it or lands the moment it
     closes. */
  useHoldPromptLane(
    'age',
    enabled && (refused || (!isHydrating && Boolean(user?.id) && state !== 'verified'))
  );

  /* THE GATE ASKS THE SERVER, AND FAILS CLOSED (2026-09-29).
     This used to read `birthday, age_verified` off the player's own profile.
     `age_verified` is revoked from players by the profile-privacy lockdown,
     PostgREST refuses a whole select when any one column is denied, and the
     'unknown' branch rendered nothing - so the gate never showed to anybody
     (found on the first device walkthrough; migration
     20260929024148_the_age_gate_asks_the_server_whether_it_is_needed.sql).
     Two changes, and both matter:
       1. The question goes to fn_my_age_gate_status(), which reads what it
          needs server-side and answers only about the caller. No column grant
          can break it again.
       2. An answer we cannot get SHOWS the gate. That is safe: for a player
          who is already verified, fn_set_my_birthday returns already_set and
          the modal lets them straight through, so the cost of a false alarm
          is one question - while the cost of the old fail-open was an
          unverified player in a gambling-adjacent app. One quiet retry first,
          so a request that races the session refresh on launch is not
          mistaken for an outage. */
  useEffect(() => {
    if (!enabled || !user?.id) {
      setState('checking');
      return;
    }
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = (attempt: number) => {
      const unanswered = (why: unknown) => {
        if (cancelled) return;
        if (attempt === 0) {
          retry = setTimeout(() => check(1), 1500);
          return;
        }
        reportError(why, 'AgeGate.status_unanswered_failing_closed', { userId: user.id });
        setState('missing');
      };
      supabase.rpc('fn_my_age_gate_status').then(
        ({ data, error }) => {
          if (cancelled) return;
          const answer = data as { ok?: boolean; verified?: boolean; reason?: string } | null;
          if (error || !answer || answer.ok !== true) {
            unanswered(error || new Error(answer?.reason || 'no_answer'));
            return;
          }
          setState(answer.verified ? 'verified' : 'missing');
        },
        (err: unknown) => unanswered(err)
      );
    };
    check(0);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [enabled, user?.id, location.pathname]);

  /* THE REFUSAL OUTLIVES THE SIGN-OUT (2026-09-29, found on the device).
     An under-18 answer signs the account out, and a signed-out player falls
     under every check below this line - so the refusal used to unmount about
     half a second after it rendered and a minor landed on the sign-in screen
     with no idea why. It is held HERE, above those checks, until it is
     closed. */
  if (refused) return <AgeGateRefusal onClose={() => setRefused(false)} />;
  if (!enabled) return null;
  if (isHydrating || !user?.id) return null;
  if (isAlwaysReachable(location.pathname)) return null;
  if (state === 'missing')
    return (
      <AgeGateModal onVerified={() => setState('verified')} onRefused={() => setRefused(true)} />
    );
  return null;
}

function AgeGateRefusal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="tos-modal-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
      aria-describedby="age-gate-refusal"
    >
      <div className="tos-modal age-gate">
        <div className="tos-header">
          <div className="tos-icon">18+</div>
          <h1 id="age-gate-title">Confirm Your Age</h1>
        </div>
        <div className="tos-content age-gate__refused">
          <p id="age-gate-refusal">
            You Must Be {MINIMUM_AGE} Or Older To Use Club Arena. You Have Been Signed Out.
          </p>
        </div>
        <div className="tos-footer age-gate__form">
          <button type="button" className="tos-accept-btn" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function AgeGateModal({
  onVerified,
  onRefused,
}: {
  onVerified: () => void;
  onRefused: () => void;
}) {
  const [birthday, setBirthday] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
          // The refusal is raised in the parent first, so it is already on
          // screen when the sign-out below unmounts everything else.
          onRefused();
          try {
            await supabase.auth.signOut({ scope: 'local' });
          } catch {
            /* the refusal is already showing */
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
    [birthday, onVerified, onRefused, today]
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
      </div>
    </div>
  );
}
