import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { runWithRequestDeadline } from '../../utils/requestDeadline';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { masterBus } from '../../core/MasterBus';
import { toTitleCase } from '../../utils/titleCase';
import type { ClubRole } from '../../types/clubRoles';
import '../../pages/MemberManagementPage.css';

type Terms = {
  success: boolean;
  error?: string;
  club_id: string;
  user_id: string;
  role: ClubRole;
  rate: number;
  max_rate: number;
};
function verifyTerms(result: Terms, clubId: string, userId: string, role: ClubRole) {
  if (
    result.club_id !== clubId ||
    result.user_id !== userId ||
    result.role !== role ||
    !Number.isFinite(Number(result.rate)) ||
    !Number.isFinite(Number(result.max_rate))
  ) {
    throw new Error('Rakeback Receipt Did Not Match');
  }
}

/** Edits the existing agreement, without replaying a promotion or funding a wallet. */
export default function MemberRakebackEditor({
  clubId,
  userId,
  role,
  onClose,
  onSaved,
}: {
  clubId: string;
  userId: string;
  role: ClubRole;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [terms, setTerms] = useState<Terms | null>(null);
  const [percent, setPercent] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [requiresReload, setRequiresReload] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    live.current = true;
    let active = true;
    setTerms(null);
    setRequiresReload(false);
    setError('');
    void (async () => {
      try {
        const { data, error: rpcError } = await runWithRequestDeadline(
          () =>
            supabase.rpc('fn_member_rakeback_terms', {
              p_club_id: clubId,
              p_user_id: userId,
              p_role: role,
            }),
          { timeoutMs: 40_000 }
        );
        if (rpcError) throw rpcError;
        const result = data as Terms | null;
        if (!result?.success) throw new Error(result?.error || 'Rakeback Terms Unavailable');
        verifyTerms(result, clubId, userId, role);
        if (!active) return;
        setTerms(result);
        setPercent(String(Number(result.rate) * 100));
      } catch (e) {
        if (active) setError(safeErrorMessage(e, 'Rakeback Terms Could Not Be Loaded'));
      }
    })();
    return () => {
      active = false;
      live.current = false;
    };
  }, [clubId, userId, role, attempt]);

  const save = async () => {
    if (!terms || inFlight.current || requiresReload) return;
    const value = Number(percent);
    if (
      !percent.trim() ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > Number(terms.max_rate) * 100
    ) {
      setError('Enter A Percentage Within The Available Limit.');
      return;
    }
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const { data, error: rpcError } = await runWithRequestDeadline(
        () =>
          supabase.rpc('fn_member_rakeback_terms', {
            p_club_id: clubId,
            p_user_id: userId,
            p_role: role,
            p_rate: value / 100,
            p_expected_rate: Number(terms.rate),
          }),
        { timeoutMs: 40_000 }
      );
      if (rpcError) throw rpcError;
      const result = data as Terms | null;
      if (!result?.success) throw new Error(result?.error || 'Rakeback Update Refused');
      verifyTerms(result, clubId, userId, role);
      if (result.role !== role || Number(result.rate) !== value / 100)
        throw new Error('Rakeback Receipt Did Not Match');
      if (!live.current) return;
      masterBus.emit('CLUB_UPDATED', { clubId });
      masterBus.emit('AGENT_UPDATED', { clubId, agentId: userId });
      onSaved();
    } catch (e) {
      if (live.current) {
        setRequiresReload(true);
        setError(
          safeErrorMessage(e, 'Rakeback Save Was Not Confirmed. Reload Terms Before Trying Again.')
        );
      }
    } finally {
      inFlight.current = false;
      if (live.current) setSaving(false);
    }
  };

  return (
    <div className="mm-roles__confirm" aria-label="Edit Rakeback">
      <p>Edit {role === 'player' ? 'Player' : 'Agent'} Rakeback</p>
      {terms ? (
        <>
          <label className="mm-field">
            <span className="mm-field__label">Rakeback Percent</span>
            <input
              autoFocus
              type="number"
              inputMode="decimal"
              min={0}
              max={Number(terms.max_rate) * 100}
              step={0.1}
              value={percent}
              onChange={(event) => setPercent(event.target.value)}
              disabled={saving}
            />
          </label>
          <p className="mm-roles__rates-note">
            Maximum {Number(terms.max_rate) * 100}%. This Updates The Existing Agreement.
          </p>
          <button
            type="button"
            className="mm-roles__confirm-yes"
            onClick={() => void save()}
            disabled={saving || requiresReload}
          >
            {saving ? 'Saving...' : 'Save Rakeback'}
          </button>
        </>
      ) : !error ? (
        <p>Loading Rakeback Terms...</p>
      ) : null}
      {error && (
        <p className="mm-roles__error" role="alert">
          {toTitleCase(error)}
        </p>
      )}
      <div className="mm-roles__confirm-actions">
        <button
          type="button"
          className="mm-roles__confirm-no"
          disabled={saving}
          onClick={() => setAttempt((n) => n + 1)}
        >
          Reload Terms
        </button>
        <button type="button" className="mm-roles__confirm-no" disabled={saving} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
