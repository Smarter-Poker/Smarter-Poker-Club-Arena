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
  LIGHTNING_STOPPED_TITLE,
  lightningReconnectVerdict,
  lightningSessionEndText,
  parseLightningReconnectState,
} from '../../src/lightning/lightningReconnect';

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
  it('parses the migration’s answer; a malformed one refuses, never a guess', () => {
    // In a live hand: the stop is standing, the exit waits for the settle.
    expect(
      parseLightningStopPlaying({
        ok: true,
        pool_session_id: POOL,
        exited: false,
        in_hand: true,
        stop_requested_at: '2026-10-08T12:00:00Z',
      })
    ).toEqual({ ok: true, stopping: true, exited: false, inHand: true, reason: null });
    // Idle: exited at once (exit_reason stop_playing lands in the summary).
    expect(parseLightningStopPlaying({ ok: true, exited: true, in_hand: false })).toEqual({
      ok: true,
      stopping: true,
      exited: true,
      inHand: false,
      reason: null,
    });
    expect(parseLightningStopPlaying({ ok: false, reason: 'NO_SESSION' })).toEqual({
      ok: false,
      stopping: false,
      exited: false,
      inHand: false,
      reason: 'NO_SESSION',
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
      rgLimit: false,
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
      rgLimit: false,
      seatTableId: SEAT_TABLE,
    });
    expect(stopped).toBe('You Stopped Playing. Your Seat Is Ready At Your Table.');
    expect(
      lightningSessionEndText({ timedOut: true, stopped: false, rgLimit: false, seatTableId: null })
    ).toBe('Your Lightning Session Timed Out.');
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

describe('the responsible-gaming ending (Lightning Phase 12, exit_reason rg_limit)', () => {
  it('reads as its own ending, Title Case with no em dashes, the seat kept', () => {
    // The ended answer of fn_lightning_reconnect_state (20261008142857), its exit_reason rg_limit.
    const row = {
      pool_session_id: POOL,
      state: 'ended',
      in_hand: false,
      hand_id: null,
      disconnected_at: null,
      stop_requested: false,
      seat_table_id: SEAT_TABLE,
      seat_number: 3,
      stack: 180,
      joinable: false,
      exit_reason: 'rg_limit',
    };
    expect(lightningReconnectVerdict(POOL, parseLightningReconnectState(row))).toEqual({
      kind: 'ended',
      timedOut: false,
      stopped: false,
      rgLimit: true,
      seatTableId: SEAT_TABLE,
    });
    const text = lightningSessionEndText({
      timedOut: false,
      stopped: false,
      rgLimit: true,
      seatTableId: SEAT_TABLE,
    });
    expect(text).toBe(
      'Your Responsible Gaming Limit Ended This Session. Your Seat Is Ready At Your Table.'
    );
    expect(text).not.toMatch(/\u2014/);
    expect(
      lightningSessionEndText({ timedOut: false, stopped: false, rgLimit: true, seatTableId: null })
    ).toBe('Your Responsible Gaming Limit Ended This Session.');
  });
});

// ─── 5. The auto-rebuy status line ─────────────────────────────────────────

describe('the auto-rebuy status (read-only, from fn_lightning_pool_status since Lightning Phase 12)', () => {
  /* LIGHTNING PHASE 12 (widened, not deleted): the line used to read
     fn_lightning_config, which is service_role only, so it never showed. It
     now reads the `auto_rebuy` object fn_lightning_pool_status answers
     (20261009143757) and is shown only while auto-rebuy is ON. */
  it('parses the pool-status object and prints the one line', () => {
    expect(parseLightningAutoRebuyStatus(null)).toBeNull();
    expect(parseLightningAutoRebuyStatus({ auto_rebuy_enabled: true })).toBeNull();
    const off = parseLightningAutoRebuyStatus({ enabled: false })!;
    expect(lightningAutoRebuyText(off)).toBe('Auto-Rebuy: Off');
    const zero = parseLightningAutoRebuyStatus({
      enabled: true,
      trigger: 'zero',
      target: 'initial',
    })!;
    expect(lightningAutoRebuyText(zero)).toBe(
      'Auto-Rebuy: On (When Out Of Chips → Initial Buy-In)'
    );
    const bb = parseLightningAutoRebuyStatus({
      enabled: true,
      trigger: 'below_bb',
      threshold_bb: 20,
      target: 'max',
    })!;
    expect(lightningAutoRebuyText(bb)).toBe('Auto-Rebuy: On (Below 20 BB → Max Buy-In)');
    const pct = parseLightningAutoRebuyStatus({
      enabled: true,
      trigger: 'below_pct',
      threshold_pct: 25,
      target: 'initial',
      max_count: 3,
      session_cap: 0,
      used_count: 1,
      used_total: 200,
    })!;
    expect(pct.sessionCap).toBeNull();
    expect(pct.usedTotal).toBe(200);
    expect(lightningAutoRebuyText(pct)).toBe(
      'Auto-Rebuy: On (Below 25% → Initial Buy-In), 1 Of 3 Used'
    );
  });

  it('an unreadable status says nothing at all (deploy window, older payload)', async () => {
    rpc.mockResolvedValue({ data: null, error: MISSING });
    expect(await fetchLightningAutoRebuyStatus(CLUSTER)).toBeNull();
    rpc.mockResolvedValue({ data: { players: 20, status: 'ACTIVE' }, error: null });
    expect(await fetchLightningAutoRebuyStatus(CLUSTER)).toBeNull();
    rpc.mockRejectedValue(new Error('network'));
    expect(await fetchLightningAutoRebuyStatus(CLUSTER)).toBeNull();
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
    for (const f of ['src/lightning/lightningSessionApi.ts']) {
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
