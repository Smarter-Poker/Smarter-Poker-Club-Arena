import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { masterBus } from '../core/MasterBus';
import {
  claimCapturedRakeback,
  claimLegacyRakeback,
  clearRakebackRequest,
  getCapturedRakeback,
  getLegacyRakeback,
  observeRakebackActivation,
  prepareRakebackRequest,
  readRakebackRequests,
  type LegacyRakebackPeriod,
  type RakebackClaimRequest,
} from '../services/CapturedRakebackService';

import type { CapturedRakebackReadV2 } from '../types/capturedRakeback';
import { cashRefreshAmount, formatRakebackCash } from '../services/CapturedRakebackV2';

type ClaimStatus = 'idle' | 'claiming' | 'success' | 'error';
interface RakebackState {
  userId: string | null;
  owner: object;
  legacyPeriods: LegacyRakebackPeriod[];
  captured: CapturedRakebackReadV2 | null;
  sourceActive: boolean | null;
  loading: boolean;
  loadError: string | null;
  historyError: string | null;
  pendingRequest: RakebackClaimRequest | null;
  claimStatus: ClaimStatus;
  claimMessage: string;
}

function initialState(userId: string | null, owner: object): RakebackState {
  return {
    userId,
    owner,
    legacyPeriods: [],
    captured: null,
    sourceActive: null,
    loading: !!userId,
    loadError: null,
    historyError: null,
    pendingRequest: null,
    claimStatus: 'idle',
    claimMessage: '',
  };
}

export function useRakeback(userId: string | null) {
  const session = useMemo(() => ({ userId, alive: true, loadId: 0, claiming: false }), [userId]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [state, setState] = useState<RakebackState>(() => initialState(userId, session));
  const current = useCallback(() => session.alive && sessionRef.current === session, [session]);
  const update = useCallback(
    (patch: Partial<RakebackState>) => {
      if (!current()) return;
      setState((previous) => ({
        ...(previous.owner === session ? previous : initialState(userId, session)),
        ...patch,
      }));
    },
    [current, session, userId]
  );

  const refresh = useCallback(async () => {
    if (!userId || !current()) return;
    const loadId = ++session.loadId;
    update({ loading: true });
    const [source, legacy] = await Promise.allSettled([
      getCapturedRakeback(userId),
      getLegacyRakeback(userId),
    ]);
    if (!current() || loadId !== session.loadId) return;
    const patch: Partial<RakebackState> = {
      loading: false,
      legacyPeriods: legacy.status === 'fulfilled' ? legacy.value : [],
      historyError:
        legacy.status === 'fulfilled' ? null : 'Previous Rakeback History Could Not Be Loaded.',
    };
    try {
      patch.pendingRequest = readRakebackRequests(userId)[0] ?? null;
      if (source.status === 'rejected') throw source.reason;
      patch.sourceActive = observeRakebackActivation(userId, source.value.source_active);
      patch.captured = source.value;
      patch.loadError = null;
    } catch {
      patch.sourceActive = null;
      patch.loadError =
        'Rakeback Availability Could Not Be Verified. Retry To Check It. Saved Claims Can Still Be Recovered.';
    }
    update(patch);
  }, [current, session, update, userId]);

  useEffect(() => {
    session.alive = true;
    void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith('ca:captured-rakeback:v1:')) void refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      session.alive = false;
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh, session]);

  const claim = useCallback(async () => {
    if (!userId || !current() || session.claiming) return;
    session.claiming = true;
    update({ claimStatus: 'claiming', claimMessage: '' });
    let request: RakebackClaimRequest | undefined;
    let confirmedTotal: string | undefined;
    try {
      request = readRakebackRequests(userId)[0];
      if (!request) {
        // Recheck the exact payer activation at the action boundary. The SQL
        // cutover also fences legacy claims if activation occurs after this read.
        const source = await getCapturedRakeback(userId);
        if (!current()) return;
        const sourceActive = observeRakebackActivation(userId, source.source_active);
        update({ sourceActive, captured: source });
        if (sourceActive) request = prepareRakebackRequest(userId);
      }
      if (!current()) return;
      let total: string;
      let clubId: string | null;
      let deferred = false;
      if (request) {
        update({ pendingRequest: request });
        const result = await claimCapturedRakeback(request);
        if (!current()) return;
        confirmedTotal = result.new_payout;
        deferred = result.scopes.some((scope) => scope.deferred.length > 0);
        clearRakebackRequest(request);
        update({ pendingRequest: readRakebackRequests(userId)[0] ?? null });
        total = result.new_payout;
        clubId = request.clubId;
      } else {
        const legacy = await getLegacyRakeback(userId);
        if (!current()) return;
        clubId = legacy.find((period) => period.status === 'pending')?.club_id ?? null;
        // Never retry a legacy mutation after a cutover refusal or lost response.
        total = (await claimLegacyRakeback(clubId)).toFixed(2);
        if (!current()) return;
      }
      update({
        claimStatus: 'success',
        claimMessage:
          total !== '0.00'
            ? `Claimed ${formatRakebackCash(total)} Chips.` +
              (deferred ? ' Some Rakeback Remains Unpaid.' : '')
            : deferred
              ? 'Claim Checked. Rakeback Remains Unpaid. Please Check Again Later.'
              : 'Claim Verified. No Additional Chips Were Paid.',
      });
      if (total !== '0.00') {
        masterBus.emit('RAKEBACK_CLAIMED', {
          clubId: clubId ?? '',
          amount: cashRefreshAmount(total),
          userId,
        });
      }
      void refresh();
    } catch (error) {
      if (!current()) return;
      const cutover =
        typeof error === 'object' && error !== null && 'code' in error && error.code === '55000';
      update({
        claimStatus: 'error',
        claimMessage:
          confirmedTotal !== undefined
            ? 'Claim Confirmed. This Browser Could Not Clear Its Saved Receipt. Recover Claim Safely Checks That Confirmation.'
            : request
              ? 'Claim Not Yet Confirmed. Use Recover Claim To Check The Same Request.'
              : cutover
                ? 'Rakeback Claiming Has Changed. Review The Refreshed Balance And Claim Again.'
                : 'Claim Could Not Be Started Safely. Retry The Balance Check Before Claiming.',
      });
      if (confirmedTotal !== undefined && confirmedTotal !== '0.00') {
        masterBus.emit('RAKEBACK_CLAIMED', {
          clubId: request?.clubId ?? '',
          amount: cashRefreshAmount(confirmedTotal),
          userId,
        });
      }
      void refresh();
    } finally {
      session.claiming = false;
    }
  }, [current, refresh, session, update, userId]);

  // A newly rendered account never sees the preceding account's amounts,
  // recovery receipt, or completion message, even before effect cleanup runs.
  const visible = state.owner === session ? state : initialState(userId, session);
  return { ...visible, refresh, claim };
}
