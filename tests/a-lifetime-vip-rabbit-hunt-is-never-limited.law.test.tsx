/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A LIFETIME VIP'S RABBIT HUNT IS NEVER LIMITED, NEVER CHARGED, NEVER PRICED
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-11, verbatim: "Rabbit hunts aren't unlimited even to VIP
 * PLAYERS".
 *
 * What is advertised (VIPPage, VIPMembershipPlate, VIPCardsModal, ProfilePage,
 * the Lifetime plan card): Lifetime VIP = "Unlimited Rabbit Hunts With No
 * Diamond Charge". An ordinary (monthly / yearly) VIP = 100 free a month, then
 * 5 Diamonds each (Dan 2026-08-25). Nothing else, and `vip-is-not-a-ladder`
 * keeps the ordinary 100.
 *
 * The server kept that promise and still does: fn_consume_rabbit_hunt_v2 takes
 * the Lifetime branch before any cap, pack or price, and every rabbit-hunt
 * receipt in production (28 of 28) is `lifetime_vip` with 0 diamonds spent.
 * The felt did not: the tile is mounted fresh for every offer and opened as a
 * non-member, so a Lifetime VIP saw the "5" diamond price - the picture of a
 * player who has run out - until a three-query lookup answered, and for the
 * whole offer when it failed. See src/components/table/rabbitEntitlement.ts.
 *
 * Pinned, one per layer, so none of them can drift back:
 *   1. DATABASE  the newest definition of fn_consume_rabbit_hunt_v2 returns
 *                for a Lifetime VIP, unlimited and with 0 spent, before the
 *                monthly cap, any pack and any debit is reached;
 *   2. ENGINE    revealRabbitHunt asks that function and adds no VIP cap,
 *                count or price of its own;
 *   3. FELT      a Lifetime VIP's tile exposes unlimited entitlement accessibly,
 *                while the lookup is pending AND after it fails, and never
 *                shows a diamond price or a countdown;
 *   and the two things that must NOT change: an ordinary VIP is never told
 *   "Free" before their count is known, and a non-VIP still sees the price.
 *
 * Registry: docs/laws.d/a-lifetime-vip-rabbit-hunt-is-never-limited.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

vi.mock('../src/hooks/useButtonImage', () => ({
  useButtonImage: () => '/rabbit.webp',
  useTimebankIcon: () => '/time-bank.webp',
}));
vi.mock('../src/services/VIPService', () => ({
  FEATURE_PRICING: { rabbit_hunt: { cost: 5 } },
  vipService: { checkVIPStatus: vi.fn() },
}));
vi.mock('../src/components/common/Toast', () => ({
  useToast: () => ({ error: vi.fn(), info: vi.fn() }),
}));
vi.mock('../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import RabbitHunt from '../src/components/table/RabbitHunt';
import { vipService } from '../src/services/VIPService';
import { useUserStore } from '../src/stores/useUserStore';
import { __resetRabbitEntitlementCache } from '../src/components/table/rabbitEntitlement';

const ROOT = resolve(__dirname, '..');
const LIFETIME_ID = '47965354-0e56-43ef-931c-ddaab82af765';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  __resetRabbitEntitlementCache();
  useUserStore.setState({ user: null });
});

function signIn(id: string, vip_status: 'none' | 'vip' | 'lifetime') {
  useUserStore.setState({
    user: { id, username: 'player', vip_status } as never,
    isAuthenticated: true,
  });
}

function tile(userId: string) {
  return render(
    <RabbitHunt
      isAvailable={true}
      cardsAvailable={2}
      rabbitDiamondCost={5}
      userId={userId}
      onReveal={vi.fn()}
    />
  );
}

describe('1. the database never limits or charges a Lifetime VIP', () => {
  /** The newest migration that defines the function is what production runs. */
  function newestBody(): string {
    const dir = join(ROOT, 'supabase', 'migrations');
    const marker = 'CREATE OR REPLACE FUNCTION public.fn_consume_rabbit_hunt_v2(';
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .filter((f) => readFileSync(join(dir, f), 'utf8').includes(marker));
    expect(files.length).toBeGreaterThan(0);
    const sql = readFileSync(join(dir, files[files.length - 1]), 'utf8');
    const start = sql.lastIndexOf(marker);
    const end = sql.indexOf('$function$;', start);
    return sql.slice(start, end > start ? end : undefined);
  }

  it('returns unlimited and free before the cap, a pack or a debit', () => {
    const body = newestBody();
    const lifetime = body.indexOf('IF v_is_lifetime THEN');
    const free = body.indexOf("'source', 'lifetime_vip'", lifetime);
    const returned = body.indexOf('RETURN v_result;', free);
    const cap = body.indexOf('v_used < v_vip_monthly_cap');
    const pack = body.indexOf('FROM public.feature_purchases');
    const debit = body.indexOf('public.deduct_diamonds');

    expect(body).toContain("COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'");
    expect(lifetime).toBeGreaterThan(-1);
    expect(body.slice(lifetime, returned)).toContain("'unlimited', true");
    expect(body.slice(lifetime, returned)).toContain("'diamonds_spent', 0");
    expect(body.slice(lifetime, returned)).not.toContain('deduct_diamonds');
    expect(returned).toBeGreaterThan(free);
    for (const later of [cap, pack, debit]) expect(later).toBeGreaterThan(returned);
  });
});

describe('2. the engine adds no VIP limit of its own', () => {
  it('revealRabbitHunt charges only through fn_consume_rabbit_hunt_v2', () => {
    const src = readFileSync(
      join(ROOT, 'server', 'src', 'engine', 'ServerTableEngineSettlement.ts'),
      'utf8'
    );
    const start = src.indexOf('public async revealRabbitHunt(');
    const end = src.indexOf('offer.revealed.add(userId);', start);
    const body = src.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("supabase.rpc('fn_consume_rabbit_hunt_v2'");
    // No second, engine-side opinion about VIP status, counts or price.
    expect(body).not.toMatch(/is_vip|vip_tier|vip_feature_usage|monthly_cap|diamond_cost/);
  });
});

describe('3. the felt never shows a Lifetime VIP a limit or a price', () => {
  it('keeps unlimited entitlement without a visible badge while the lookup is pending', () => {
    signIn(LIFETIME_ID, 'lifetime');
    vi.mocked(vipService.checkVIPStatus).mockReturnValue(new Promise(() => {}));
    const { getByRole, queryByText } = tile(LIFETIME_ID);

    expect(getByRole('button', { name: 'Rabbit Hunt, Unlimited With Lifetime VIP' })).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();
    expect(queryByText('5')).toBeNull();
  });

  it('stays Unlimited when the lookup fails, on every new offer', async () => {
    signIn(LIFETIME_ID, 'lifetime');
    vi.mocked(vipService.checkVIPStatus).mockRejectedValue(new Error('VIP status unreadable'));
    for (let hand = 0; hand < 3; hand++) {
      const { getByRole, queryByText, unmount } = tile(LIFETIME_ID);
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        getByRole('button', { name: 'Rabbit Hunt, Unlimited With Lifetime VIP' })
      ).toBeTruthy();
      expect(queryByText('5')).toBeNull();
      unmount();
    }
  });

  it('remembers a confirmed Lifetime answer for the next offer', async () => {
    // A profile that has not loaded yet: the confirmed lookup carries it.
    vi.mocked(vipService.checkVIPStatus).mockResolvedValueOnce({
      isVIP: true,
      status: 'lifetime',
      expiresAt: null,
      monthlyLimits: { rabbitHunts: { used: 500, limit: 100 } },
    } as never);
    const first = tile(LIFETIME_ID);
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    vi.mocked(vipService.checkVIPStatus).mockReturnValue(new Promise(() => {}));
    const { getByRole, queryByText } = tile(LIFETIME_ID);
    expect(getByRole('button', { name: 'Rabbit Hunt, Unlimited With Lifetime VIP' })).toBeTruthy();
    expect(queryByText('5')).toBeNull();
    expect(queryByText('0')).toBeNull();
  });
});

describe('and the two memberships that keep their own rules', () => {
  it('an ordinary VIP is never told Free before their count is known', () => {
    signIn('11111111-2222-4333-8444-555555555555', 'vip');
    vi.mocked(vipService.checkVIPStatus).mockReturnValue(new Promise(() => {}));
    const { getByRole, queryByText } = tile('11111111-2222-4333-8444-555555555555');
    expect(getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();
    expect(queryByText('Free')).toBeNull();
  });

  it('a non-VIP still sees the price', () => {
    signIn('22222222-2222-4333-8444-555555555555', 'none');
    vi.mocked(vipService.checkVIPStatus).mockReturnValue(new Promise(() => {}));
    const { getByRole, queryByText } = tile('22222222-2222-4333-8444-555555555555');
    expect(getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();
  });

  it("another account's Lifetime profile grants nothing", () => {
    signIn(LIFETIME_ID, 'lifetime');
    vi.mocked(vipService.checkVIPStatus).mockReturnValue(new Promise(() => {}));
    const { getByRole, queryByText } = tile('33333333-2222-4333-8444-555555555555');
    expect(getByRole('button', { name: 'Rabbit Hunt, 5 Diamonds' })).toBeTruthy();
    expect(queryByText('Unlimited')).toBeNull();
  });
});
