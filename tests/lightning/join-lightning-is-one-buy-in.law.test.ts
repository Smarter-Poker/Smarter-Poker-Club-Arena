import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/services/TableFundingService', () => ({ readTableFundingBalance: vi.fn() }));

import { buyIntoLightning, type LightningBuyInDeps } from '../../src/lightning/lightningJoinBuyIn';

/* Dan 2026-10-24: "LIGHTNING NEEDS TO OPERATE JUST LIKE A TOURNAMENT, YOU
   DON'T SELECT YOUR SEAT, YOU 'JOIN LIGHTNING GAMES' SELECT HOW MUCH YOU WANT
   TO BUY IN FOR, AND THEN YOU AUTO ASSIGN THEM TO A SEAT AND TABLE." */
const CLUSTER = '22222222-2222-4222-8222-222222222222';
const TABLE = '33333333-3333-4333-8333-333333333333';
const USER = '66666666-6666-4666-8666-666666666666';
const POOL = '11111111-1111-4111-8111-111111111111';

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
    execute: vi.fn(async () => ({ kind: 'confirmed' as const, fromReceipt: false })),
    markIntent: vi.fn(),
    clearIntent: vi.fn(),
    readPoolSession: vi.fn(async () => POOL),
    ...over,
  };
}
const args = { clusterId: CLUSTER, userId: USER, amount: 120, clubId: null };

describe('Join Lightning is one buy-in: the amount, then an assigned seat', () => {
  it('holds a chair, buys exactly that chair for the amount, and opens the pool room', async () => {
    const d = deps();
    const r = await buyIntoLightning(args, d);
    expect(r).toEqual({ kind: 'seated', tableId: TABLE, poolSessionId: POOL });
    expect(d.join).toHaveBeenCalledWith(CLUSTER);
    expect(d.reserve).toHaveBeenCalledWith({
      p_user_id: USER,
      p_table_id: TABLE,
      p_seat_number: 4,
      p_amount: 120,
      p_auto_rebuy: false,
      p_club_id: null,
    });
    expect(d.markIntent).toHaveBeenCalledWith(TABLE, CLUSTER);
    expect(d.complete).toHaveBeenCalled();
  });

  it('a chair taken between the hold and the purchase asks the door once more for a fresh one', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'rejected',
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "table_seats_table_id_seat_number_key"',
        },
      })
      .mockResolvedValueOnce({ kind: 'confirmed', fromReceipt: false });
    const d = deps({ execute });
    const r = await buyIntoLightning(args, d);
    expect(d.join).toHaveBeenCalledTimes(2);
    expect(r.kind).toBe('seated');
  });

  it('an unanswered purchase is never retried here; it is left for the table to recover', async () => {
    const d = deps({
      execute: vi.fn(async () => ({ kind: 'unknown' as const, error: new Error('x') })),
    });
    const r = await buyIntoLightning(args, d);
    expect(r.kind).toBe('unconfirmed');
    expect(d.complete).not.toHaveBeenCalled();
    expect(d.join).toHaveBeenCalledTimes(1);
  });

  it('a refused join says why and buys nothing', async () => {
    const d = deps({ join: vi.fn(async () => Promise.reject(new Error('INSUFFICIENT_CHIPS:40'))) });
    const r = await buyIntoLightning(args, d);
    expect(r).toEqual({
      kind: 'rejected',
      message: 'Not Enough Chips. You Need At Least 40 Chips To Join This Game.',
    });
    expect(d.reserve).not.toHaveBeenCalled();
  });

  it('the Join Lightning page asks for the amount before any seat is held', () => {
    const page = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');
    expect(page).toContain('joinsLightning ? openLightningBuyIn() : joinGame()');
    expect(page).toMatch(
      /<BuyInModal[\s\S]*?onConfirm=\{\(amount\) => confirmLightningBuyIn\(amount\)\}/
    );
    expect(page).not.toMatch(/\?buyin=1/);
  });
});

describe('Join Lightning is one tap from everywhere, and nobody picks a Lightning seat', () => {
  const read = (p: string) => readFileSync(p, 'utf8');
  it('the lobby card and PLAY AGAIN open the amount at once', async () => {
    const { lightningJoinRoute } = await import('../../src/lightning/lightningLobby');
    expect(lightningJoinRoute(CLUSTER)).toBe(`/lightning/${CLUSTER}?join=1`);
    expect(read('src/pages/ClubHomePage.tsx')).toContain(
      'navigate(lightningJoinRoute(row.cluster_id));'
    );
    expect(read('src/components/lightning/LightningSessionSummary.tsx')).toContain(
      'navigate(lightningJoinRoute(req.clusterId));'
    );
  });

  it('a chair tapped on a Lightning table opens the one-question door, never a seat buy-in', () => {
    const page = read('src/pages/TablePage.tsx');
    const tap = page.slice(
      page.indexOf('const handleSeatClick = (seatNumber: number) => {'),
      page.indexOf('// Validate seat is empty before showing buy-in modal')
    );
    expect(tap).toMatch(
      /if \(anchorLightningClusterId && heroSeatRef\.current <= 0 && tableState\.heroSeat <= 0\) \{\s+openLightningAnchorEntry\(\);\s+return;/
    );
    /* no seat-change or waiting-list box on a Lightning table */
    expect(page).toMatch(
      /tableState\.clusterId &&\s+!anchorLightningClusterId &&\s+!lightningRoom && \(\s+<div className="hud-seat-change-dock">/
    );
  });
});

describe("the amount question remembers last time, inside today's range and wallet", () => {
  it('first visit keeps the default; later visits pre-fill the last confirmed amount, clamped', async () => {
    const m = await import('../../src/lightning/lightningJoinBuyIn');
    localStorage.clear();
    const ctx = { minBuyIn: 40, maxBuyIn: 200, balance: 500 };
    expect(m.rememberedLightningBuyIn(CLUSTER, ctx)).toBeUndefined();
    m.rememberLightningBuyIn(CLUSTER, 120);
    expect(m.rememberedLightningBuyIn(CLUSTER, ctx)).toBe(120);
    expect(m.rememberedLightningBuyIn(CLUSTER, { ...ctx, balance: 90 })).toBe(90);
    expect(m.rememberedLightningBuyIn(CLUSTER, { ...ctx, maxBuyIn: 100 })).toBe(100);
    expect(m.rememberedLightningBuyIn(CLUSTER, { ...ctx, balance: 10 })).toBeUndefined();
    expect(m.rememberedLightningBuyIn(TABLE, ctx)).toBeUndefined();
  });

  it('only a confirmed seat is remembered', () => {
    const page = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');
    expect(page).toContain(
      "if (result.kind === 'seated') rememberLightningBuyIn(clusterId, amount);"
    );
    expect(page).toContain(
      'defaultBuyIn={clusterId ? rememberedLightningBuyIn(clusterId, buyIn) : undefined}'
    );
  });
});

it('a Join Lightning that is not offered says why', () => {
  const page = readFileSync('src/pages/LightningEntryPage.tsx', 'utf8');
  expect(page).toMatch(/\{atLimit \? \(\s+<p[^>]*>\s+\{LIGHTNING_LIMIT_TEXT\}/);
  expect(page).toMatch(/joinsClosed \? \(\s+<p[^>]*>\s+\{LIGHTNING_JOINS_CLOSED_TEXT\}/);
});
