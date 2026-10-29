import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { runWithRequestDeadline } from '../../utils/requestDeadline';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { toTitleCase } from '../../utils/titleCase';
import { masterBus } from '../../core/MasterBus';
import type { ClubRole } from '../../types/clubRoles';
import '../../pages/MemberManagementPage.css';

type Terms = {
  id: string;
  club_id: string;
  user_id: string;
  role: string;
  is_prepaid: boolean;
  credit_limit: number;
  credit_used: number;
};

/** Existing audited credit administration, without a role or rate write. */
export default function MemberCreditEditor({
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
  const [funding, setFunding] = useState<'prepaid' | 'credit'>('prepaid');
  const [amount, setAmount] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [requiresReload, setRequiresReload] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setTerms(null);
    setError('');
    setRequiresReload(false);
    void (async () => {
      try {
        const { data, error: readError } = await runWithRequestDeadline(
          (signal) =>
            supabase
              .from('agents')
              .select('id,club_id,user_id,role,is_prepaid,credit_limit,credit_used')
              .eq('club_id', clubId)
              .eq('user_id', userId)
              .eq('status', 'active')
              .abortSignal(signal)
              .maybeSingle(),
          { timeoutMs: 40_000 }
        );
        if (readError) throw readError;
        const row = data as Terms | null;
        if (
          !row ||
          !row.id ||
          row.club_id !== clubId ||
          row.user_id !== userId ||
          row.role !== role ||
          typeof row.is_prepaid !== 'boolean' ||
          row.credit_limit == null ||
          row.credit_used == null ||
          !Number.isFinite(Number(row.credit_limit)) ||
          Number(row.credit_limit) < 0 ||
          !Number.isFinite(Number(row.credit_used)) ||
          Number(row.credit_used) < 0
        ) {
          throw new Error('Credit Terms Are Unavailable Or The Member Role Changed.');
        }
        if (generation.current !== current) return;
        setTerms(row);
        setFunding(row.is_prepaid ? 'prepaid' : 'credit');
        setAmount(String(row.credit_limit));
      } catch (e) {
        if (generation.current === current)
          setError(safeErrorMessage(e, 'Credit Terms Could Not Be Loaded'));
      }
    })();
    return () => {
      ++generation.current;
    };
  }, [clubId, userId, role, attempt]);

  const save = async () => {
    if (!terms || inFlight.current || requiresReload) return;
    const limit = funding === 'prepaid' ? 0 : Number(amount);
    if (funding === 'credit' && (!amount.trim() || !Number.isSafeInteger(limit) || limit <= 0)) {
      setError('Enter A Credit Limit In Whole Chips Greater Than Zero.');
      return;
    }
    if (limit < Number(terms.credit_used)) {
      setError('Settle The Outstanding Credit Before Reducing The Limit Below The Amount Used.');
      return;
    }
    const current = generation.current;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const { data, error: rpcError } = await runWithRequestDeadline(
        (signal) =>
          supabase
            .rpc('fn_admin_update_agent', {
              p_agent_id: terms.id,
              p_is_prepaid: funding === 'prepaid',
              p_credit_limit: limit,
              p_credit_reason: 'Credit Line Edited From Member Record',
            })
            .abortSignal(signal),
        { timeoutMs: 40_000 }
      );
      if (rpcError) throw rpcError;
      const receipt = data as {
        success?: boolean;
        error?: string;
        agent_id?: string;
        club_id?: string;
        is_prepaid?: boolean;
        credit_limit?: number;
      } | null;
      if (receipt?.success !== true) throw new Error(receipt?.error || 'Credit Update Refused');
      if (
        receipt.agent_id !== terms.id ||
        receipt.club_id !== clubId ||
        receipt.is_prepaid !== (funding === 'prepaid') ||
        Number(receipt.credit_limit) !== limit
      ) {
        throw new Error('Credit Receipt Did Not Match. Reload Terms Before Saving Again.');
      }
      if (generation.current !== current) return;
      masterBus.emit('CLUB_UPDATED', { clubId });
      masterBus.emit('AGENT_UPDATED', { clubId, agentId: userId });
      onSaved();
    } catch (e) {
      if (generation.current === current) {
        setRequiresReload(true);
        setError(
          safeErrorMessage(e, 'Credit Save Was Not Confirmed. Reload Terms Before Trying Again.')
        );
      }
    } finally {
      inFlight.current = false;
      if (generation.current === current) setSaving(false);
    }
  };

  return (
    <div className="mm-roles__confirm" aria-label="Edit Credit Line">
      <p>Edit Credit Line</p>
      {terms ? (
        <>
          <label className="mm-field">
            <span className="mm-field__label">Funding</span>
            <select
              autoFocus
              className="mm-assign__select"
              value={funding}
              disabled={saving}
              onChange={(event) => setFunding(event.target.value as typeof funding)}
            >
              <option value="prepaid">Prepaid</option>
              <option value="credit">Credit Line</option>
            </select>
          </label>
          {funding === 'credit' && (
            <label className="mm-field">
              <span className="mm-field__label">Credit Limit In Chips</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={amount}
                disabled={saving}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
          )}
          <p className="mm-roles__rates-note">
            This Updates The Credit Agreement. The Role And Rakeback Stay The Same. No Chips Are
            Transferred.
          </p>
          <button
            type="button"
            className="mm-roles__confirm-yes"
            disabled={saving || requiresReload}
            onClick={() => void save()}
          >
            {saving ? 'Saving...' : 'Save Credit Line'}
          </button>
        </>
      ) : !error ? (
        <p>Loading Credit Terms...</p>
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
