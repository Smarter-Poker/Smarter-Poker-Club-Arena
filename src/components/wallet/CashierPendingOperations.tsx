import { useEffect, useRef, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { resolveClubUUIDStrict } from '../../utils/clubIdResolver';
import { reportError } from '../../utils/errorReporter';
import {
  clearCashierWalletOperation,
  readCashierWalletRecoveryState,
} from '../../services/CashierWalletRecovery';

/** Explicit receipt lookup moves no chips and survives withdrawn club access. */
export default function CashierPendingOperations({
  userId,
  clubId: routeClubId,
  actionClassName,
}: {
  userId?: string;
  clubId: string | null;
  actionClassName?: string;
}) {
  const [clubId, setClubId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setClubId(null);
    if (
      routeClubId &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(routeClubId)
    ) {
      setClubId(routeClubId);
    } else if (routeClubId)
      void resolveClubUUIDStrict(routeClubId)
        .then((id) => {
          if (live) setClubId(id);
        })
        .catch((error) => reportError(error, 'CashierPendingOperations.Club'));
    return () => {
      live = false;
    };
  }, [routeClubId]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [checking, setChecking] = useState(false);
  const busy = useRef(false);
  const scope = useRef({ userId, clubId });
  if (scope.current.userId !== userId || scope.current.clubId !== clubId)
    scope.current = { userId, clubId };
  useEffect(() => {
    const refresh = () => setRevision((n) => n + 1);
    window.addEventListener('storage', refresh);
    window.addEventListener('cashier-wallet-journal-changed', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('cashier-wallet-journal-changed', refresh);
    };
  }, []);
  void revision;
  const recovery =
    userId && clubId
      ? readCashierWalletRecoveryState(userId, clubId)
      : { operations: [], unreadable: false };
  const { operations, unreadable } = recovery;
  async function check() {
    if (!clubId || busy.current) return;
    const token = scope.current;
    busy.current = true;
    setChecking(true);
    try {
      let confirmed = 0;
      for (let offset = 0; offset < operations.length; offset += 25) {
        if (!mounted.current || scope.current !== token) return;
        const chunk = operations.slice(offset, offset + 25);
        const { data, error } = await supabase.rpc('fn_cashier_recovery_receipts', {
          p_club_id: clubId,
          p_operation_ids: chunk.map((row) => row.operationId),
          p_ticket_keys: [],
        });
        if (error) throw error;
        if (!data || !Array.isArray(data.operations)) throw new Error('Receipt Response Missing');
        for (const row of chunk) {
          if (
            data.operations.some(
              (receipt: { operation_id?: string; receipt?: { success?: boolean } }) =>
                receipt.operation_id === row.operationId && receipt.receipt?.success === true
            )
          ) {
            clearCashierWalletOperation(row);
            confirmed++;
          }
        }
      }
      if (mounted.current && scope.current === token) {
        setMessage(
          `${confirmed} Recorded. ${operations.length - confirmed} Still Need Verification. Original Retry Keys Are Preserved.`
        );
        setRevision((n) => n + 1);
      }
    } catch (error) {
      reportError(error, 'CashierPendingOperations.Receipt');
      if (mounted.current && scope.current === token)
        setMessage('Could Not Verify Receipts. Original Retry Keys Are Preserved.');
    } finally {
      busy.current = false;
      if (mounted.current) setChecking(false);
    }
  }
  if (!operations.length && !message && !unreadable) return null;
  return (
    <div className="sc-copy" aria-label="Interrupted Wallet Transfers">
      <p>{operations.length} Wallet Operations Need Verification</p>
      {unreadable && (
        <p role="alert">
          Some Saved Transfers Could Not Be Read. Their Original Identities Are Preserved.
        </p>
      )}
      <button
        type="button"
        className={actionClassName || 'sc-label'}
        disabled={checking || !operations.length}
        onClick={() => void check()}
      >
        {checking ? 'Checking Original Receipts' : 'Check Original Receipts'}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
