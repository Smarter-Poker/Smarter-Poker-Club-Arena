/**
 * LIGHTNING PHASE 9 (client): what a returning player is told when their
 * room answers 4404. A pool session still open keeps the reconnect ladder on
 * the SAME room id; one that ended while they were away (the disconnect
 * reaper's timeout included) shows the ending's words, the session summary,
 * and VIEW GAME to the seat that remains or to the Cluster's entry. A
 * database without fn_lightning_reconnect_state yet changes nothing.
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

const EXPIRED_ROW = {
  pool_session_id: POOL,
  state: 'expired',
  in_hand: false,
  hand_id: null,
  disconnected_at: '2026-10-08T01:00:00Z',
  seat_table_id: SEAT_TABLE,
  seat_number: 4,
  stack: 182.5,
  joinable: true,
};

// ─── 1. Reading the database's answer ──────────────────────────────────────

describe('fn_lightning_reconnect_state, read defensively', () => {
  it('reads every field; a malformed one is "not known", never a guess', () => {
    const s = parseLightningReconnectState([EXPIRED_ROW]);
    expect(s).toEqual({
      poolSessionId: POOL,
      state: 'expired',
      inHand: false,
      handId: null,
      disconnectedAt: '2026-10-08T01:00:00Z',
      seatTableId: SEAT_TABLE,
      seatNumber: 4,
      stack: 182.5,
      joinable: true,
    });
    const bad = parseLightningReconnectState({
      pool_session_id: 'not-a-uuid',
      state: '',
      seat_table_id: 17,
      seat_number: 0,
      stack: 'much',
      joinable: 'yes',
    });
    expect(bad.poolSessionId).toBeNull();
    expect(bad.state).toBeNull();
    expect(bad.seatTableId).toBeNull();
    expect(bad.seatNumber).toBeNull();
    expect(bad.stack).toBeNull();
    expect(bad.joinable).toBe(false);
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
  it('still open and the same room: re-enter; open but another room: says nothing', () => {
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({ ...EXPIRED_ROW, state: 'active' })
      )
    ).toEqual({ kind: 'open', poolSessionId: POOL });
    expect(
      lightningReconnectVerdict(
        POOL_B,
        parseLightningReconnectState({ ...EXPIRED_ROW, state: 'active' })
      )
    ).toEqual({ kind: 'unknown' });
    expect(lightningReconnectVerdict(POOL, null)).toEqual({ kind: 'unknown' });
  });

  it('expired is the timeout ending, with the seat when one remains; other ends are ordinary', () => {
    expect(lightningReconnectVerdict(POOL, parseLightningReconnectState(EXPIRED_ROW))).toEqual({
      kind: 'ended',
      timedOut: true,
      seatTableId: SEAT_TABLE,
    });
    expect(
      lightningReconnectVerdict(
        POOL,
        parseLightningReconnectState({ ...EXPIRED_ROW, state: 'cashed_out', seat_table_id: null })
      )
    ).toEqual({ kind: 'ended', timedOut: false, seatTableId: null });
    // The row is gone entirely (reaped and cleaned): the ordinary ending.
    expect(lightningReconnectVerdict(POOL, parseLightningReconnectState({}))).toEqual({
      kind: 'ended',
      timedOut: false,
      seatTableId: null,
    });
  });

  it('the ending’s words are Title Case with no em dashes', () => {
    expect(LIGHTNING_TIMED_OUT_TITLE).toBe('Your Lightning Session Timed Out');
    expect(LIGHTNING_SESSION_OVER_TEXT).toBe('Your Lightning Session Has Ended');
    const withSeat = lightningSessionEndText({ timedOut: true, seatTableId: SEAT_TABLE });
    const noSeat = lightningSessionEndText({ timedOut: false, seatTableId: null });
    expect(withSeat).toBe('Your Lightning Session Timed Out. Your Seat Is Ready At Your Table.');
    expect(noSeat).toBe('Your Lightning Session Has Ended.');
    for (const s of [withSeat, noSeat]) {
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
    rpc.mockResolvedValue({ data: { ...EXPIRED_ROW, state: 'active' }, error: null });
    const onStillOpen = vi.fn();
    render(<Probe roomClosed={{ code: 4404 }} onStillOpen={onStillOpen} />);
    await waitFor(() => expect(onStillOpen).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('end').textContent).toBe('none');
  });

  it('an expired session concludes once, and asks no further question after it', async () => {
    rpc.mockResolvedValue({ data: EXPIRED_ROW, error: null });
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
    rpc.mockResolvedValue({ data: EXPIRED_ROW, error: null });
    const view = render(<Probe roomClosed={{ code: 4404 }} />);
    await waitFor(() => expect(reportError).toHaveBeenCalledTimes(1));
    view.rerender(<Probe roomClosed={{ code: 4404, at: 2 }} />);
    await waitFor(() => expect(screen.getByTestId('end').textContent).toBe(`true|${SEAT_TABLE}`));
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
    // One message per ending: the toast stands down for either notice.
    const guard = sliceEnclosingBlock(
      page,
      '!lightningReturnRef.current && !lightningEndedRef.current'
    );
    expect(guard).toContain(
      "heartbeatToastRef.current?.info?.('Your Lightning Session Has Ended')"
    );
  });
});
