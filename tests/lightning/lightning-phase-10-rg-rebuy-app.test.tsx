/**
 * LIGHTNING PHASE 10 (client): responsible gaming, auto-rebuy and the
 * hidden-information review (spec Phases 16 and 17).
 *
 *   - STOP PLAYING in the room's own tools: one tap asks
 *     fn_lightning_stop_playing; a database without the function yet gets a
 *     graceful "not available"; while the current hand finishes the control
 *     says so; the ending then carries the player's own words ("You Stopped
 *     Playing") through the Phase 9 ended notice.
 *   - HAND VOLUME is always on screen: hands, duration and hands per hour,
 *     ticked locally from the hand stream, reconciled by the one stats read.
 *   - AUTO-REBUY is a read-only status line from the operator's config.
 *   - LAW 10.6: none of it navigates - the player moves only by a tap.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const POOL = '11111111-1111-4111-8111-111111111111';
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
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => toast }));

import {
  LIGHTNING_STOP_FINISHING_TEXT,
  LIGHTNING_STOP_PLAYING_LABEL,
  LIGHTNING_STOP_UNAVAILABLE_TEXT,
  fetchLightningAutoRebuyStatus,
  isLightningRpcMissing,
  lightningAutoRebuyText,
  parseLightningAutoRebuyStatus,
  parseLightningStopPlaying,
  stopLightningPlaying,
} from '../../src/lightning/lightningSessionApi';
import {
  lightningHandVolume,
  lightningHandVolumeText,
} from '../../src/lightning/lightningSessionMetrics';
import {
  LIGHTNING_STOPPED_TITLE,
  lightningReconnectVerdict,
  lightningSessionEndText,
  parseLightningReconnectState,
} from '../../src/lightning/lightningReconnect';
import LightningRoomTools from '../../src/components/lightning/LightningRoomTools';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MISSING = { code: 'PGRST202', message: 'Could not find the function' };

/** The room's default database: every read answers quietly with nothing. */
function quietRpc(overrides: Record<string, (args: unknown) => { data: unknown; error: unknown }>) {
  rpc.mockImplementation(async (fn: string, args: unknown) => {
    if (overrides[fn]) return overrides[fn](args);
    return { data: null, error: null };
  });
}

beforeEach(() => {
  rpc.mockReset();
  reportError.mockReset();
  toast.info.mockReset();
  toast.warning.mockReset();
  localStorage.clear();
});
afterEach(cleanup);

// ─── 1. The Stop Playing door ──────────────────────────────────────────────

describe('fn_lightning_stop_playing, read defensively', () => {
  it('parses the answer; a malformed one refuses, never a guess', () => {
    expect(parseLightningStopPlaying({ ok: true, stopping: true, in_hand: true })).toEqual({
      ok: true,
      stopping: true,
      inHand: true,
      reason: null,
    });
    // ok alone means stopping: the database accepted the stop.
    expect(parseLightningStopPlaying({ ok: true }).stopping).toBe(true);
    expect(parseLightningStopPlaying({ ok: false, reason: 'no_open_session' })).toEqual({
      ok: false,
      stopping: false,
      inHand: false,
      reason: 'no_open_session',
    });
    expect(parseLightningStopPlaying(null).ok).toBe(false);
  });

  it('a database without the function answers null (deploy window); a real failure throws', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: MISSING });
    expect(await stopLightningPlaying(CLUSTER)).toBeNull();
    expect(rpc.mock.calls[0]).toEqual(['fn_lightning_stop_playing', { p_cluster_id: CLUSTER }]);
    rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'canceled' } });
    await expect(stopLightningPlaying(CLUSTER)).rejects.toMatchObject({ code: '57014' });
    expect(isLightningRpcMissing(MISSING)).toBe(true);
    expect(isLightningRpcMissing({ code: '42883' })).toBe(true);
    expect(isLightningRpcMissing({ code: '57014' })).toBe(false);
  });
});

// ─── 2. The control in the room's tools ────────────────────────────────────

function renderTools(handKey: string | null = 'id:h1') {
  return render(
    <LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey={handKey} visible={true} />
  );
}

describe('the Stop Playing control', () => {
  it('one tap asks the database, and a live hand shows "Finishing Current Hand..."', async () => {
    quietRpc({
      fn_lightning_stop_playing: () => ({
        data: { ok: true, stopping: true, in_hand: true },
        error: null,
      }),
    });
    renderTools('id:h1');
    const btn = screen.getByTestId('lightning-stop-playing');
    expect(btn.textContent).toBe(LIGHTNING_STOP_PLAYING_LABEL);
    fireEvent.click(btn);
    await waitFor(() =>
      expect(rpc.mock.calls.some(([fn]) => fn === 'fn_lightning_stop_playing')).toBe(true)
    );
    const call = rpc.mock.calls.find(([fn]) => fn === 'fn_lightning_stop_playing')!;
    expect(call[1]).toEqual({ p_cluster_id: CLUSTER });
    await waitFor(() => expect(btn.textContent).toBe(LIGHTNING_STOP_FINISHING_TEXT));
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // A second tap cannot ask again: one stop per session is the whole job.
    fireEvent.click(btn);
    expect(rpc.mock.calls.filter(([fn]) => fn === 'fn_lightning_stop_playing')).toHaveLength(1);
  });

  it('a database without the function gets a graceful "not available", not a crash', async () => {
    quietRpc({
      fn_lightning_stop_playing: () => ({ data: null, error: MISSING }),
    });
    renderTools();
    fireEvent.click(screen.getByTestId('lightning-stop-playing'));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(LIGHTNING_STOP_UNAVAILABLE_TEXT));
    // Still offered: the migration may land while the session runs.
    const btn = screen.getByTestId('lightning-stop-playing') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe(LIGHTNING_STOP_PLAYING_LABEL);
    expect(reportError).not.toHaveBeenCalled();
  });

  it('a failed stop is reported and the control stays usable', async () => {
    quietRpc({
      fn_lightning_stop_playing: () => ({
        data: null,
        error: { code: '57014', message: 'canceled' },
      }),
    });
    renderTools();
    fireEvent.click(screen.getByTestId('lightning-stop-playing'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(reportError).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('lightning-stop-playing') as HTMLButtonElement).disabled).toBe(
      false
    );
  });
});

// ─── 3. The ending's own words ─────────────────────────────────────────────

describe('the stop-playing ending (Phase 9 notice, Phase 10 words)', () => {
  const STOPPED_ROW = {
    pool_session_id: POOL,
    state: 'closed',
    exit_reason: 'stop_playing',
    seat_table_id: SEAT_TABLE,
  };

  it('exit_reason stop_playing reads as the player’s own ending; absent, nothing changes', () => {
    expect(parseLightningReconnectState(STOPPED_ROW).exitReason).toBe('stop_playing');
    expect(lightningReconnectVerdict(POOL, parseLightningReconnectState(STOPPED_ROW))).toEqual({
      kind: 'ended',
      timedOut: false,
      stopped: true,
      seatTableId: SEAT_TABLE,
    });
    const legacy = parseLightningReconnectState({ ...STOPPED_ROW, exit_reason: undefined });
    expect(legacy.exitReason).toBeNull();
    expect(lightningReconnectVerdict(POOL, legacy)).toMatchObject({ stopped: false });
  });

  it('the words are Title Case with no em dashes, and the old endings keep theirs', () => {
    expect(LIGHTNING_STOPPED_TITLE).toBe('You Stopped Playing');
    const stopped = lightningSessionEndText({
      timedOut: false,
      stopped: true,
      seatTableId: SEAT_TABLE,
    });
    expect(stopped).toBe('You Stopped Playing. Your Seat Is Ready At Your Table.');
    expect(lightningSessionEndText({ timedOut: true, stopped: false, seatTableId: null })).toBe(
      'Your Lightning Session Timed Out.'
    );
    for (const s of [stopped, LIGHTNING_STOP_FINISHING_TEXT, LIGHTNING_STOP_UNAVAILABLE_TEXT]) {
      expect(s).not.toContain('—');
      for (const word of s.replace(/[.]/g, '').split(' ')) {
        expect(word[0]).toBe(word[0].toUpperCase());
      }
    }
    // TablePage's ended notice prints exactly these words (the Phase 9 site).
    const page = read('src/pages/TablePage.tsx');
    expect(page).toContain('lightningSessionEndText(lightningSessionEnd.ended)');
  });
});

// ─── 4. Hand volume ────────────────────────────────────────────────────────

describe('session metrics: hand volume, duration and rate', () => {
  it('the arithmetic: baseline plus local ticks, a dash while nothing is known', () => {
    const v = lightningHandVolume({
      baseHands: 120,
      baseDurationS: 3_600,
      baseAtMs: 1_000_000,
      handsSinceBase: 3,
      nowMs: 1_060_000,
    });
    expect(v.hands).toBe(123);
    expect(v.durationS).toBe(3_660);
    expect(Math.round(v.handsPerHour!)).toBe(121);
    expect(lightningHandVolumeText(v)).toBe('Hands 123 · 1h 01m · 121/hr');
    const unknown = lightningHandVolume({
      baseHands: null,
      baseDurationS: null,
      baseAtMs: null,
      handsSinceBase: 0,
      nowMs: 1,
    });
    expect(lightningHandVolumeText(unknown)).toBe('Hands - · - · -/hr');
    // Under a minute of clock no rate is printed: a two-hand burst is not
    // "7200 hands an hour".
    expect(
      lightningHandVolume({
        baseHands: 2,
        baseDurationS: 10,
        baseAtMs: 0,
        handsSinceBase: 0,
        nowMs: 0,
      }).handsPerHour
    ).toBeNull();
  });

  it('the room shows the volume line and ticks it when a new hand deals', async () => {
    quietRpc({
      fn_lightning_session_stats: () => ({
        data: { hands: 40, duration_s: 1_200 },
        error: null,
      }),
    });
    const view = renderTools('id:h1');
    await waitFor(() =>
      expect(screen.getByTestId('lightning-hand-volume').textContent).toContain('Hands 40')
    );
    // The next hand reaches the felt: one more, locally, no new read.
    const statsReads = rpc.mock.calls.filter(([fn]) => fn === 'fn_lightning_session_stats').length;
    view.rerender(
      <LightningRoomTools poolSessionId={POOL} clusterId={CLUSTER} handKey="id:h2" visible={true} />
    );
    await waitFor(() =>
      expect(screen.getByTestId('lightning-hand-volume').textContent).toContain('Hands 41')
    );
    expect(rpc.mock.calls.filter(([fn]) => fn === 'fn_lightning_session_stats').length).toBe(
      statsReads
    );
  });
});

// ─── 5. The auto-rebuy status line ─────────────────────────────────────────

describe('the auto-rebuy status (read-only, from the operator’s config)', () => {
  it('parses the config keys and prints the one line', () => {
    expect(parseLightningAutoRebuyStatus(null)).toBeNull();
    const off = parseLightningAutoRebuyStatus({ auto_rebuy_enabled: false })!;
    expect(lightningAutoRebuyText(off)).toBe('Auto-Rebuy: Off');
    const on = parseLightningAutoRebuyStatus({
      auto_rebuy_enabled: true,
      auto_rebuy_threshold_bb: 20,
      auto_rebuy_target: 100,
    })!;
    expect(lightningAutoRebuyText(on)).toBe('Auto-Rebuy: On (Below 20 BB → 100 BB)');
    const pct = parseLightningAutoRebuyStatus({
      auto_rebuy_enabled: true,
      auto_rebuy_trigger: 'pct',
      auto_rebuy_threshold_pct: 40,
      auto_rebuy_target: 100,
    })!;
    expect(lightningAutoRebuyText(pct)).toBe('Auto-Rebuy: On (Below 40% → 100 BB)');
  });

  it('an unreadable config says nothing at all (deploy window, not granted)', async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    expect(await fetchLightningAutoRebuyStatus(CLUSTER)).toBeNull();
    rpc.mockRejectedValue(new Error('network'));
    expect(await fetchLightningAutoRebuyStatus(CLUSTER)).toBeNull();
  });

  it('the Session panel shows the line when the config can be read, and hides it when not', async () => {
    quietRpc({
      fn_lightning_config: () => ({
        data: { auto_rebuy_enabled: false },
        error: null,
      }),
    });
    renderTools();
    fireEvent.click(screen.getByTestId('lightning-session-toggle'));
    await waitFor(() =>
      expect(screen.getByTestId('lightning-auto-rebuy-status').textContent).toBe('Auto-Rebuy: Off')
    );
    cleanup();
    quietRpc({ fn_lightning_config: () => ({ data: null, error: MISSING }) });
    renderTools();
    fireEvent.click(screen.getByTestId('lightning-session-toggle'));
    await waitFor(() =>
      expect(rpc.mock.calls.some(([fn]) => fn === 'fn_lightning_config')).toBe(true)
    );
    expect(screen.queryByTestId('lightning-auto-rebuy-status')).toBeNull();
  });
});

// ─── 6. Law 10.6 and the hidden-information review, client side ────────────

describe('Law 10.6 and the replay door (spec Phase 17, client)', () => {
  it('Phase 10 adds no navigation: the two seat moves stay the only ones, behind their buttons', () => {
    const page = read('src/pages/TablePage.tsx');
    /* The Phase 7 pin's exact rule, restated so Phase 10 cannot erode it:
       exactly two navigate(lightningReturnPath(...)) sites, both inside
       onViewGame button handlers. */
    expect(page.split('navigate(lightningReturnPath(').length - 1).toBe(2);
    for (const f of [
      'src/components/lightning/LightningRoomTools.tsx',
      'src/lightning/lightningSessionMetrics.ts',
      'src/lightning/lightningSessionApi.ts',
    ]) {
      const src = read(f);
      expect(src, f).not.toMatch(/useNavigate|navigate\(|location\.href|history\.push/);
    }
  });

  it('the recent-hands and replay surfaces ask only the caller-scoped doors', () => {
    /* fn_lightning_recent_hands answers for the caller only, and the replay
       opens the EXISTING HandReplay by hand_histories id - the same
       component with the same entitlement rules as every other replay. No
       Lightning client surface reads another player's cards by any other
       path. */
    const api = read('src/lightning/lightningSessionApi.ts');
    expect(api).toContain("supabase.rpc('fn_lightning_recent_hands'");
    expect(api).not.toMatch(/\.from\(['"]hand_histories['"]\)|hole_cards/);
    const modal = read('src/components/lightning/LightningHandReplayModal.tsx');
    expect(modal).toContain('<HandReplay handId={handHistoryId}');
    expect(modal).not.toMatch(/supabase|\.rpc\(|\.from\(/);
  });
});
