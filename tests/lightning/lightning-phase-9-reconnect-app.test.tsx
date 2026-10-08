/**
 * LIGHTNING PHASE 9 (client): what a returning player is told when their
 * room answers 4404. A pool session still open keeps the reconnect ladder on
 * the SAME room id; one that ended while they were away shows the ending's
 * words - keyed on `exit_reason`, the field the database actually writes
 * ('disconnect_expired' from the reaper, 'stop_playing' from the player),
 * never on a pool-session state 'expired', which does not exist - plus the
 * session summary and VIEW GAME to the seat that remains or to the Cluster's
 * entry. A database without fn_lightning_reconnect_state yet changes
 * nothing, and one whose function still answers all nulls for an ended
 * session degrades to the generic ending.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const POOL = '11111111-1111-4111-8111-111111111111';
const POOL_B = '11111111-1111-4111-8111-222222222222';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const SEAT_TABLE = '33333333-3333-4333-8333-333333333333';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: { rpc: (...a: unknown[]) => rpc(...a) },
}));
const reportError = vi.fn();
vi.mock('../../src/utils/errorReporter', () => ({
  reportError: (...a: unknown[]) => reportError(...a),
}));

import {
  LIGHTNING_TIMED_OUT_TITLE,
  LIGHTNING_SESSION_OVER_TEXT,
  LIGHTNING_STOPPED_TITLE,
  fetchLightningReconnectState,
  isMissingRpcError,
  lightningReconnectVerdict,
  lightningSessionEndText,
  parseLightningReconnectState,
  useLightningSessionEnd,
} from '../../src/lightning/lightningReconnect';
import LightningEndedNotice from '../../src/components/table/LightningEndedNotice';
import {
  LIGHTNING_ENDED_EYEBROW,
  LIGHTNING_ENDED_TEXT,
} from '../../src/lightning/lightningReversion';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

beforeEach(() => {
  rpc.mockReset();
  reportError.mockReset();
});
afterEach(() => {
  cleanup();
});

/**
 * The row the database ACTUALLY writes when the reaper times a disconnect
 * out: state 'closed' (there is no state 'expired' in lightning_pool_session)
 * and exit_reason 'disconnect_expired'. The remediated
 * fn_lightning_reconnect_state answers it with state 'ended' for a caller
 * whose only recent session is an exited one; both spellings are the ended
 * contract.
 */
const TIMED_OUT_ROW = {
  pool_session_id: POOL,
  state: 'closed',
  in_hand: false,
  hand_id: null,
  disconnected_at: '2026-10-08T01:00:00Z',
  seat_table_id: SEAT_TABLE,
  seat_number: 4,
  stack: 182.5,
  joinable: true,
  exit_reason: 'disconnect_expired',
};

// ─── 1. Reading the database's answer ──────────────────────────────────────

describe('fn_lightning_reconnect_state, read defensively', () => {
  it('reads every field; a malformed one is "not known", never a guess', () => {
    const s = parseLightningReconnectState([TIMED_OUT_ROW]);
    expect(s).toEqual({
      poolSessionId: POOL,
      state: 'closed',
      inHand: false,
      handId: null,
      disconnectedAt: '2026-10-08T01:00:00Z',
      seatTableId: SEAT_TABLE,
      seatNumber: 4,
      stack: 182.5,
      joinable: true,
      exitReason: 'disconnect_expired',
    });
    const bad = parseLightningReconnectState({
      pool_session_id: 'not-a-uuid',
      state: '',
      seat_table_id: 17,
      seat_number: 0,
      stack: 'much',
      joinable: 'yes',
      exit_reason: 42,
    });
    expect(bad.poolSessionId).toBeNull();
    expect(bad.state).toBeNull();
    expect(bad.seatTableId).toBeNull();
    expect(bad.seatNumber).toBeNull();
    expect(bad.stack).toBeNull();
    expect(bad.joinable).toBe(false);
    expect(bad.exitReason).toBeNull();
    expect(parseLightningReconnectState(null).poolSessionId).toBeNull();
  });

  it('a database without the function yet answers null (not a fault); a real failure throws', async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    expect(await fetchLightningReconnectState(CLUSTER)).toBeNull();
    expect(rpc.mock.calls[0]).toEqual(['fn_lightning_reconnect_state', { p_cluster_id: CLUSTER }]);
    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'canceled' } });
    await expect(fetchLightningReconnectState(CLUSTER)).rejects.toMatchObject({ code: '57014' });
    expect(isMissingRpcError({ code: '42883' })).toBe(true);
    expect(
      isMissingRpcError({ message: 'function fn_lightning_reconnect_state does not exist' })
    ).toBe(true);
    expect(isMissingRpcError({ code: '57014' })).toBe(false);
  });
});

// ─── 2. The verdict for one room ───────────────────────────────────────────

describe('the verdict', () => {
  it('still open and the same room: re-enter', () => {
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({ ...TIMED_OUT_ROW, state: 'active', exit_reason: null })
      )
    ).toEqual({ kind: 'open', poolSessionId: POOL });
    expect(lightningReconnectVerdict(POOL, null)).toEqual({ kind: 'unknown' });
  });

  it('an answer naming ANOTHER pool session ends THIS tab plainly, and never joins the new one', () => {
    // The player was reaped here and re-entered from another tab or seat:
    // the stale tab's session is over, and the new session belongs to the
    // tab that opened it (navigation only on an explicit tap).
    const endedForThisTab = { kind: 'ended', timedOut: false, stopped: false, seatTableId: null };
    expect(
      lightningReconnectVerdict(
        POOL_B,
        parseLightningReconnectState({ ...TIMED_OUT_ROW, state: 'active', exit_reason: null })
      )
    ).toEqual(endedForThisTab);
    // An ended answer about another session likewise lends this tab neither
    // its reason nor its seat.
    expect(lightningReconnectVerdict(POOL_B, parseLightningReconnectState(TIMED_OUT_ROW))).toEqual(
      endedForThisTab
    );
  });

  it('the ending is keyed on exit_reason: the reaper, the player, or neither', () => {
    // The reaper's ending (exit_reason disconnect_expired), with the seat.
    expect(lightningReconnectVerdict(POOL, parseLightningReconnectState(TIMED_OUT_ROW))).toEqual({
      kind: 'ended',
      timedOut: true,
      stopped: false,
      seatTableId: SEAT_TABLE,
    });
    // The remediated function's own spelling for a recent exited session.
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({ ...TIMED_OUT_ROW, state: 'ended' })
      )
    ).toEqual({ kind: 'ended', timedOut: true, stopped: false, seatTableId: SEAT_TABLE });
    // The player's own STOP PLAYING.
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({
          ...TIMED_OUT_ROW,
          state: 'ended',
          exit_reason: 'stop_playing',
        })
      )
    ).toEqual({ kind: 'ended', timedOut: false, stopped: true, seatTableId: SEAT_TABLE });
    // Any other exit_reason is the generic ending.
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({
          ...TIMED_OUT_ROW,
          state: 'closed',
          seat_table_id: null,
          exit_reason: 'cash_out',
        })
      )
    ).toEqual({ kind: 'ended', timedOut: false, stopped: false, seatTableId: null });
  });

  it('a database before the remediation degrades to the generic ending', () => {
    // The old function answers ALL NULLS for an ended session.
    expect(lightningReconnectVerdict(POOL, parseLightningReconnectState({}))).toEqual({
      kind: 'ended',
      timedOut: false,
      stopped: false,
      seatTableId: null,
    });
    // An ended row that carries no exit_reason field names no special ending.
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({ ...TIMED_OUT_ROW, exit_reason: null })
      )
    ).toEqual({ kind: 'ended', timedOut: false, stopped: false, seatTableId: SEAT_TABLE });
  });

  it("no code path references a pool-session state 'expired' - the database cannot produce one", () => {
    // The reaper closes with state 'closed' + exit_reason 'disconnect_expired';
    // a client keying any behaviour on state 'expired' is keying on a value
    // production can never emit (the Phase 9 deep-dive's HIGH finding).
    expect(read('src/lightning/lightningReconnect.ts')).not.toMatch(/'expired'/);
    expect(read('src/lightning/lightningSession.ts')).not.toMatch(/'expired'/);
  });

  it('the ending’s words are Title Case with no em dashes', () => {
    expect(LIGHTNING_TIMED_OUT_TITLE).toBe('Your Lightning Session Timed Out');
    expect(LIGHTNING_SESSION_OVER_TEXT).toBe('Your Lightning Session Has Ended');
    expect(LIGHTNING_STOPPED_TITLE).toBe('You Stopped Playing');
    const withSeat = lightningSessionEndText({ timedOut: true, seatTableId: SEAT_TABLE });
    const noSeat = lightningSessionEndText({ timedOut: false, seatTableId: null });
    const stopped = lightningSessionEndText({ timedOut: false, stopped: true, seatTableId: null });
    expect(withSeat).toBe('Your Lightning Session Timed Out. Your Seat Is Ready At Your Table.');
    expect(noSeat).toBe('Your Lightning Session Has Ended.');
    expect(stopped).toBe('You Stopped Playing.');
    for (const s of [withSeat, noSeat, stopped]) {
      expect(s).not.toContain('—');
      for (const word of s.replace(/[.]/g, '').split(' ')) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
  });
});

// ─── 3. The hook ───────────────────────────────────────────────────────────

function Probe({ roomClosed, onStillOpen }: { roomClosed: unknown; onStillOpen?: () => void }) {
  const { ended } = useLightningSessionEnd({
    clusterId: CLUSTER,
    roomId: POOL,
    roomClosed,
    onStillOpen,
  });
  return (
    <div data-testid="end">{ended ? `${ended.timedOut}|${ended.seatTableId ?? ''}` : 'none'}</div>
  );
}

describe('useLightningSessionEnd', () => {
  it('a session still open nudges the ladder and concludes nothing', async () => {
    rpc.mockResolvedValue({
      data: { ...TIMED_OUT_ROW, state: 'active', exit_reason: null },
      error: null,
    });
    const onStillOpen = vi.fn();
    render(<Probe roomClosed={{ code: 4404 }} onStillOpen={onStillOpen} />);
    await waitFor(() => expect(onStillOpen).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('end').textContent).toBe('none');
  });

  it('a timed-out session concludes once, and asks no further question after it', async () => {
    rpc.mockResolvedValue({ data: TIMED_OUT_ROW, error: null });
    const view = render(<Probe roomClosed={{ code: 4404 }} />);
    await waitFor(() => expect(screen.getByTestId('end').textContent).toBe(`true|${SEAT_TABLE}`));
    const asked = rpc.mock.calls.length;
    // The ladder keeps producing closes; the verdict is already in.
    view.rerender(<Probe roomClosed={{ code: 4404, at: 2 }} />);
    await Promise.resolve();
    expect(rpc.mock.calls.length).toBe(asked);
  });

  it('a database without the function changes nothing and is not asked again', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: 'PGRST202', message: 'Could not find the function' },
    });
    const view = render(<Probe roomClosed={{ code: 4404 }} />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    view.rerender(<Probe roomClosed={{ code: 4404, at: 2 }} />);
    await Promise.resolve();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('end').textContent).toBe('none');
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a read that fails is reported and asked again on the next close', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'canceled' } });
    rpc.mockResolvedValue({ data: TIMED_OUT_ROW, error: null });
    const view = render(<Probe roomClosed={{ code: 4404 }} />);
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    view.rerender(<Probe roomClosed={{ code: 4404, at: 2 }} />);
    await waitFor(() => expect(screen.getByTestId('end').textContent).toBe(`true|${SEAT_TABLE}`));
  });

  it('an answer about a NEWER session ends the stale tab plainly instead of grinding the ladder', async () => {
    // The player was reaped, then re-entered from another tab: this tab's
    // room id is not the one the database answers with any more.
    rpc.mockResolvedValue({
      data: { ...TIMED_OUT_ROW, pool_session_id: POOL_B, state: 'active', exit_reason: null },
      error: null,
    });
    render(<Probe roomClosed={{ code: 4404 }} />);
    await waitFor(() => expect(screen.getByTestId('end').textContent).toBe('false|'));
  });

  it('pendingRef is true only while the question is in flight', async () => {
    let resolveRpc: (v: { data: unknown; error: unknown }) => void = () => undefined;
    rpc.mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      })
    );
    let pendingRef: { readonly current: boolean } | null = null;
    function PendingProbe() {
      const hook = useLightningSessionEnd({
        clusterId: CLUSTER,
        roomId: POOL,
        roomClosed: { code: 4404 },
      });
      pendingRef = hook.pendingRef;
      return <div data-testid="pend">{hook.ended ? 'ended' : 'none'}</div>;
    }
    render(<PendingProbe />);
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    expect(pendingRef!.current).toBe(true);
    resolveRpc({ data: TIMED_OUT_ROW, error: null });
    await waitFor(() => expect(screen.getByTestId('pend').textContent).toBe('ended'));
    expect(pendingRef!.current).toBe(false);
  });
});

// ─── 4. The notice and the page wiring ─────────────────────────────────────

describe('the ended notice and TablePage', () => {
  it('the notice takes the ending’s words, and every existing caller keeps the MUST MOVE defaults', () => {
    rpc.mockResolvedValue({ data: null, error: null });
    const view = render(
      <LightningEndedNotice
        onViewGame={vi.fn()}
        eyebrow="Lightning"
        text={lightningSessionEndText({ timedOut: true, seatTableId: null })}
      />
    );
    expect(screen.getByTestId('lightning-ended').textContent).toContain(
      'Your Lightning Session Timed Out.'
    );
    expect(screen.getByTestId('lightning-ended-view-game').textContent).toBe('View Game');
    view.unmount();
    render(<LightningEndedNotice onViewGame={vi.fn()} />);
    expect(screen.getByTestId('lightning-ended').textContent).toContain(LIGHTNING_ENDED_EYEBROW);
    expect(screen.getByTestId('lightning-ended').textContent).toContain(LIGHTNING_ENDED_TEXT);
  });

  it('TablePage wires the 4404 close into the hook, the ladder nudge, the notice and the toast guard', () => {
    const page = read('src/pages/TablePage.tsx');
    const hook = sliceEnclosingBlock(page, 'useLightningSessionEnd({');
    expect(hook).toContain('engineLastError?.code === 4404 ? engineLastError : null');
    expect(hook).toContain('onStillOpen: reconnectEngineNow');
    // The verdict's notice: Phase 7's MUST MOVE wins; otherwise the ending's words.
    const notice = sliceEnclosingBlock(
      page,
      'lightningRoom && !lightningReversion.seatTableId && lightningSessionEnd.ended'
    );
    expect(notice).toContain('lightningSessionEndText(lightningSessionEnd.ended)');
    expect(notice).toContain('lightningRoute(lightningRoom.clusterId)');
    // One message per ending: the toast stands down for either notice, AND
    // while the reconnect-state answer is still on its way - a question in
    // flight releases the slot instead of speaking before the notice does.
    const guard = sliceEnclosingBlock(
      page,
      '!lightningReturnRef.current && !lightningEndedRef.current'
    );
    expect(guard).toContain(
      "heartbeatToastRef.current?.info?.('Your Lightning Session Has Ended')"
    );
    const standDown = sliceEnclosingBlock(page, 'lightningEndPendingRef.current');
    expect(standDown).toContain('tableClosedToastShownRef.current = false');
    expect(standDown).toContain('return;');
  });
});
