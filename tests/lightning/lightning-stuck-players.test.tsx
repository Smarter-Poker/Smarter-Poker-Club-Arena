/**
 * LIGHTNING TRANSITION, PHASE 2: no Lightning player is left with no way forward.
 *
 * 1. A player who busts is offered the rebuy sheet once per bust, between
 *    hands, on a zero the database confirms, funded through the room's own
 *    top-up with one held key, with LEAVE running the room's own leave.
 * 2. A Join Lightning buy-in nobody could confirm no longer leaves the anchor
 *    table on "Joining Lightning..." until Cancel.
 * 3. The 'cluster_unfrozen' and 'lightning_off' endings have their own words.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { sliceStatement } from '../helpers/sourceWindow';

const rpc = vi.fn();
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: () => {
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'is']) chain[m] = () => chain;
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
vi.mock('../../src/services/TableFundingService', () => ({ readTableFundingBalance: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({
  soundService: { playBuyInConfirm: vi.fn() },
  haptic: { light: vi.fn() },
}));

import {
  lightningBustCandidate,
  lightningBustVerdict,
  useLightningBustRebuy,
  LIGHTNING_BUST_AUTO_TOP_UP_GRACE_MS,
  LIGHTNING_BUST_MAX_READS,
} from '../../src/lightning/lightningBustRebuy';
import BuyInModal from '../../src/components/table/BuyInModal';
import { buyIntoLightning, type LightningBuyInDeps } from '../../src/lightning/lightningJoinBuyIn';
import {
  clearLightningEntryIntent,
  getLightningEntryIntent,
  setLightningEntryIntent,
} from '../../src/lightning/lightningSession';
import { useLightningAnchorHandoff } from '../../src/lightning/useLightningAnchorHandoff';
import {
  LIGHTNING_OFF_TITLE,
  LIGHTNING_SESSION_OVER_TEXT,
  LIGHTNING_UNFROZEN_TITLE,
  lightningReconnectVerdict,
  lightningSessionEndText,
  parseLightningReconnectState,
} from '../../src/lightning/lightningReconnect';
import LightningEndedNotice from '../../src/components/table/LightningEndedNotice';

const ROOT = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const POOL = '11111111-1111-4111-8111-111111111111';
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const TABLE = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';

beforeEach(() => {
  rpc.mockReset();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── 1. The busted Lightning player ─────────────────────────────────────────

describe('a busted Lightning player is offered the rebuy sheet', () => {
  const idle = {
    room: true,
    heroInRoster: false,
    rosterStack: undefined,
    waitingStack: 0,
    handLive: false,
    roomClosed: false,
    sittingOut: false,
  };

  it('a zero between hands is a bust candidate; a hand, a closed room or a sit out is not', () => {
    expect(lightningBustCandidate(idle)).toBe('bust');
    expect(lightningBustCandidate({ ...idle, waitingStack: 12.5 })).toBe('funded');
    expect(lightningBustCandidate({ ...idle, waitingStack: null })).toBe('unknown');
    expect(lightningBustCandidate({ ...idle, handLive: true })).toBe('unknown');
    expect(lightningBustCandidate({ ...idle, roomClosed: true })).toBe('unknown');
    expect(lightningBustCandidate({ ...idle, sittingOut: true })).toBe('unknown');
    // An all-in hero in the roster reads 0 behind until the pot is paid.
    expect(
      lightningBustCandidate({ ...idle, heroInRoster: true, rosterStack: 0, handLive: true })
    ).toBe('unknown');
    expect(lightningBustCandidate({ ...idle, heroInRoster: true, rosterStack: 40 })).toBe('funded');
    // Never at a Classic table.
    expect(lightningBustCandidate({ ...idle, room: false })).toBe('unknown');
  });

  it('only the database’s own zero opens it, with its maximum', () => {
    expect(lightningBustVerdict({ stack: 0, maximum: 200 })).toEqual({
      kind: 'prompt',
      maximum: 200,
    });
    expect(lightningBustVerdict({ stack: 3, maximum: 200 })).toEqual({ kind: 'funded' });
    expect(lightningBustVerdict(null)).toEqual({ kind: 'unknown' });
  });

  const room = { poolSessionId: POOL, clusterId: CLUSTER };
  function mount(read: ReturnType<typeof vi.fn>, over: Record<string, unknown> = {}) {
    const onPrompt = vi.fn();
    const props = {
      room,
      userId: USER,
      candidate: 'bust' as const,
      autoTopUpEnabled: false,
      blocked: false,
      onPrompt,
      read,
      ...over,
    };
    const h = renderHook((p: typeof props) => useLightningBustRebuy(p), { initialProps: props });
    return { h, props, onPrompt };
  }

  it('offers a showdown loser the prompt after presentation ends, even when the final roster stays', async () => {
    vi.useFakeTimers();
    const readTopUp = vi.fn(async () => ({ stack: 0, maximum: 200 }));
    const finalRoster = { ...idle, heroInRoster: true, rosterStack: 0, handLive: false };
    const candidate = lightningBustCandidate(finalRoster);
    expect(candidate).toBe('bust');
    const { onPrompt } = mount(readTopUp, { candidate });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onPrompt).toHaveBeenCalledWith(200);
  });

  it('a new room owns a fresh read budget after the old room could not confirm a bust', async () => {
    vi.useFakeTimers();
    const readTopUp = vi.fn().mockResolvedValue(null);
    const { h, props, onPrompt } = mount(readTopUp);
    for (let n = 0; n < LIGHTNING_BUST_MAX_READS + 1; n++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1600);
      });
    }
    expect(readTopUp).toHaveBeenCalledTimes(LIGHTNING_BUST_MAX_READS);
    readTopUp.mockResolvedValue({ stack: 0, maximum: 150 });
    const nextPool = '77777777-7777-4777-8777-777777777777';
    h.rerender({ ...props, room: { ...room, poolSessionId: nextPool } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(readTopUp).toHaveBeenLastCalledWith(CLUSTER, nextPool, USER);
    expect(onPrompt).toHaveBeenCalledWith(150);
  });

  it('prompts once per bust (not on every snapshot), and again after chips are seen', async () => {
    vi.useFakeTimers();
    const readTopUp = vi.fn(async () => ({ stack: 0, maximum: 200 }));
    const { h, props, onPrompt } = mount(readTopUp);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(readTopUp).toHaveBeenCalledWith(CLUSTER, POOL, USER);
    expect(onPrompt).toHaveBeenCalledTimes(1);
    expect(onPrompt).toHaveBeenCalledWith(200);
    // The idle snapshot repeats; the prompt does not.
    for (let i = 0; i < 4; i += 1) {
      h.rerender({ ...props, blocked: true });
      h.rerender({ ...props });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    expect(onPrompt).toHaveBeenCalledTimes(1);
    // A rebuy landed (or a hand was dealt), then the player busted again.
    h.rerender({ ...props, candidate: 'funded' });
    h.rerender({ ...props, candidate: 'bust' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onPrompt).toHaveBeenCalledTimes(2);
  });

  it('a stale zero the database contradicts never opens it', async () => {
    vi.useFakeTimers();
    const readTopUp = vi.fn(async () => ({ stack: 55, maximum: 200 }));
    const { onPrompt } = mount(readTopUp);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it('a hand still settling (no answer yet) is asked again, then prompts', async () => {
    vi.useFakeTimers();
    const readTopUp = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ stack: 0, maximum: 150 });
    const { onPrompt } = mount(readTopUp);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(onPrompt).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(onPrompt).toHaveBeenCalledWith(150);
  });

  it('the opt-in auto top-up gets its moment first, and another money sheet blocks it', async () => {
    vi.useFakeTimers();
    const readTopUp = vi.fn(async () => ({ stack: 0, maximum: 200 }));
    const auto = mount(readTopUp, { autoTopUpEnabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIGHTNING_BUST_AUTO_TOP_UP_GRACE_MS - 100);
    });
    expect(auto.onPrompt).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(auto.onPrompt).toHaveBeenCalledTimes(1);
    cleanup();
    const blocked = mount(readTopUp, { blocked: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(blocked.onPrompt).not.toHaveBeenCalled();
  });

  it('the sheet is the existing rebuy sheet; LEAVE runs the leave, the corner close only closes', async () => {
    const onLeave = vi.fn();
    const onClose = vi.fn();
    render(
      <BuyInModal
        isOpen
        purchaseKind="rebuy"
        onClose={onClose}
        onConfirm={vi.fn()}
        onLeave={onLeave}
        minBuyIn={40}
        maxBuyIn={200}
        bigBlind={2}
        accountBalance={500}
      />
    );
    expect(screen.getByText('Rebuy Available')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Leave Table'));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Close Purchase'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it('without a Leave (every other table) the sheet is exactly as before', () => {
    render(
      <BuyInModal
        isOpen
        purchaseKind="rebuy"
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        minBuyIn={40}
        maxBuyIn={200}
        bigBlind={2}
        accountBalance={500}
      />
    );
    expect(screen.getByLabelText('Close Buy-In')).toBeTruthy();
    expect(screen.queryByLabelText('Leave Table')).toBeNull();
  });

  it('TablePage funds it through the Lightning top-up with one held key, and never moves the player', () => {
    const page = read('src/pages/TablePage.tsx');
    const confirm = sliceStatement(page, 'const confirmBustRebuy =');
    const lightning = confirm.slice(
      confirm.indexOf('if (lightningRoomRef.current) {'),
      confirm.indexOf('/* A DIAMOND SEAT REBUYS THROUGH ITS OWN DOOR.')
    );
    expect(lightning).toMatch(
      /bustRebuyKeyRef\.current = \{ amount, key: crypto\.randomUUID\(\) \}/
    );
    expect(lightning).toMatch(/handleAddChipsRef\.current\(amount, held, \{/);
    expect(lightning).not.toContain('atomic_table_rebuy');
    expect(confirm.indexOf('if (lightningRoomRef.current) {')).toBeLessThan(
      confirm.indexOf('atomic_table_rebuy')
    );
    // The cash prompt still stands down in a Lightning room (its own watch asks).
    expect(page).toMatch(
      /Lightning room rebuys through its own watch[\s\S]{0,400}if \(lightningRoomRef\.current\) return;/
    );
    const wiring = page.slice(
      page.indexOf('const lightningBust = lightningBustCandidate({'),
      page.indexOf('// A Lightning idle room intentionally has no hand seat.')
    );
    expect(wiring).toContain('useLightningBustRebuy({');
    expect(wiring).toContain('handLive: lightningHandLive && !tableHandIsOver');
    expect(wiring).not.toMatch(/navigate\(|movedToTableId/);
    const leave = page.slice(
      page.indexOf('onLeaveBustRebuy={'),
      page.indexOf('showProfileModal={showProfileModal}')
    );
    expect(leave).toContain('void handleLeaveTable();');
    expect(read('src/lightning/lightningBustRebuy.ts')).not.toMatch(/is_horse|isHorse/);
  });
});

// ─── 2. "Joining Lightning..." after an unconfirmed buy-in ──────────────────

describe('an unconfirmed Join Lightning buy-in does not leave the table on Joining Lightning', () => {
  function deps(over: Partial<LightningBuyInDeps> = {}): LightningBuyInDeps {
    return {
      join: vi.fn(async () => ({ ok: true, action: 'seat', table_id: TABLE, seat_number: 4 })),
      reserve: vi.fn(async (intent) => ({
        attempt: {
          version: 1 as const,
          createdAt: 0,
          payload: { ...intent, p_idempotency_key: 'k' },
        },
        recovered: false,
      })),
      complete: vi.fn(async () => undefined),
      execute: vi.fn(async () => ({ kind: 'unknown' as const, error: new Error('lost') })),
      markIntent: setLightningEntryIntent,
      clearIntent: clearLightningEntryIntent,
      readPoolSession: vi.fn(async () => null),
      ...over,
    } as LightningBuyInDeps;
  }
  const args = { clusterId: CLUSTER, userId: USER, amount: 120, clubId: null };

  it('the unanswered purchase clears the intent, so the anchor table shows the table, not Joining', async () => {
    const r = await buyIntoLightning(args, deps());
    expect(r.kind).toBe('unconfirmed');
    expect(getLightningEntryIntent(TABLE)).toBeNull();
    // The anchor table, with the seat funded as far as it can tell.
    rpc.mockResolvedValue({ data: null, error: null });
    const h = renderHook(() =>
      useLightningAnchorHandoff({
        tableId: TABLE,
        clusterId: CLUSTER,
        userId: USER,
        isPoolSession: false,
        heroBoughtIn: true,
        follow: vi.fn(),
      })
    );
    expect(h.result.current.joining).toBe(false);
  });

  it('an earlier unanswered request to review clears it too', async () => {
    const r = await buyIntoLightning(
      args,
      deps({
        reserve: vi.fn(async (intent) => ({
          attempt: {
            version: 1 as const,
            createdAt: 0,
            payload: { ...intent, p_amount: 80, p_idempotency_key: 'old' },
          },
          recovered: true,
        })),
      })
    );
    expect(r.kind).toBe('unconfirmed');
    expect(getLightningEntryIntent(TABLE)).toBeNull();
  });

  it('a confirmed purchase keeps it, so the tab still follows the chair', async () => {
    const r = await buyIntoLightning(
      args,
      deps({ execute: vi.fn(async () => ({ kind: 'confirmed' as const, fromReceipt: false })) })
    );
    expect(r.kind).toBe('seated');
    expect(getLightningEntryIntent(TABLE)).toBe(CLUSTER);
  });

  it('the table’s own buy-in sheet clears it on an unknown or refused outcome, and Cancel still works', () => {
    const page = read('src/pages/TablePage.tsx');
    const unknown = page.slice(
      page.indexOf("reportError(outcome.error, 'TablePage.cash_buyin_outcome_unknown');"),
      page.indexOf('if (isDeadSessionRefusal(outcome.error)) {')
    );
    expect(unknown).toContain('if (anchorLightningClusterId) clearLightningEntryIntent(tableId);');
    const refused = page.slice(
      page.indexOf("reportError(outcome.error, 'TablePage.atomic_table_buyin_returned_failure');"),
      page.indexOf('cashBuyInRefusalText(outcome.error) ??')
    );
    expect(refused).toContain('if (anchorLightningClusterId) clearLightningEntryIntent(tableId);');
    expect(page).toContain('<LightningJoining onCancel={lightningHandoff.cancel} />');
  });
});

// ─── 3. The two endings that used to read generic ───────────────────────────

describe('cluster_unfrozen and lightning_off have their own words', () => {
  const ended = (exit_reason: string, seat: string | null) =>
    parseLightningReconnectState({
      pool_session_id: POOL,
      state: 'ended',
      in_hand: false,
      seat_table_id: seat,
      seat_number: seat ? 3 : null,
      exit_reason,
    });

  it('an unfreeze says the game was paused and the seat is kept', () => {
    const verdict = lightningReconnectVerdict(POOL, ended('cluster_unfrozen', TABLE));
    expect(verdict).toMatchObject({ kind: 'ended', unfrozen: true, seatTableId: TABLE });
    const text = lightningSessionEndText(verdict as never);
    expect(text).toBe(`${LIGHTNING_UNFROZEN_TITLE}. Your Seat Is Ready At Your Table.`);
    expect(text).not.toContain(LIGHTNING_SESSION_OVER_TEXT);
  });

  it('Lightning switching off says so, and the seat line only when the seat is still theirs', () => {
    const withSeat = lightningReconnectVerdict(POOL, ended('lightning_off', TABLE));
    expect(lightningSessionEndText(withSeat as never)).toBe(
      `${LIGHTNING_OFF_TITLE}. Your Seat Is Ready At Your Table.`
    );
    const noSeat = lightningReconnectVerdict(POOL, ended('lightning_off', null));
    expect(lightningSessionEndText(noSeat as never)).toBe(`${LIGHTNING_OFF_TITLE}.`);
  });

  it('the words follow the popup rules and reach the ended notice', () => {
    for (const t of [LIGHTNING_UNFROZEN_TITLE, LIGHTNING_OFF_TITLE]) {
      expect(t).not.toMatch(/[—–-]/);
      for (const w of t.split(' ')) expect(w[0]).toBe(w[0].toUpperCase());
    }
    const verdict = lightningReconnectVerdict(POOL, ended('cluster_unfrozen', TABLE));
    render(
      <LightningEndedNotice
        eyebrow="Lightning"
        text={lightningSessionEndText(verdict as never)}
        onViewGame={vi.fn()}
      />
    );
    expect(screen.getByTestId('lightning-ended').textContent).toContain(LIGHTNING_UNFROZEN_TITLE);
  });

  it('every other ending reads exactly as before', () => {
    const plain = lightningReconnectVerdict(POOL, ended('anchor_seat_left', null));
    expect(plain).not.toHaveProperty('unfrozen');
    expect(plain).not.toHaveProperty('lightningOff');
    expect(lightningSessionEndText(plain as never)).toBe(`${LIGHTNING_SESSION_OVER_TEXT}.`);
  });
});
