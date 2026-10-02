/**
 * THE SEPTEMBER 8 GAMES' FINISH-REFUSED ALERTS CLOSE (2026-10-02)
 *
 * The 26 September 8 Spins and heads-up Sit & Gos each raised one
 * Tournament.atomic_finish_refused alert while still REGISTERING; after
 * 20261001225325 launched them, their terminal authority finished and paid
 * every one. 20261002061026 resolves exactly those 26 alerts, each only after
 * its event is proven COMPLETED with one payout equal to the pool and zero
 * escrow. These pins keep the file a resolution and nothing else.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  'supabase/migrations/20261002061026_the_september_eight_games_finish_refused_alerts_close.sql',
  'utf8'
);
const LAUNCH = readFileSync(
  'supabase/migrations/20261001225325_the_september_eight_games_commit_the_launch_their_engine_los.sql',
  'utf8'
);
const body = MIGRATION.split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

const pairs = [
  ...body.matchAll(
    /\('([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})','([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'\)/g
  ),
].map((m) => ({ alert: m[1], event: m[2] }));

describe('the September 8 finish-refused alerts close only on a settled event', () => {
  it('names exactly the 26 launched events, one alert each', () => {
    expect(pairs).toHaveLength(26);
    expect(new Set(pairs.map((p) => p.event)).size).toBe(26);
    expect(new Set(pairs.map((p) => p.alert)).size).toBe(26);
    const launchProof = LAUNCH.match(/^-- @live-proof: .*$/m)?.[0] ?? '';
    for (const p of pairs) expect(launchProof).toContain(p.event);
  });

  it('proves every event settled before resolving, and resolves only this alert class', () => {
    expect(body).toContain("WHEN t.status IS DISTINCT FROM 'COMPLETED' THEN 'not COMPLETED'");
    expect(body).toContain(
      's.cash_payout_count IS DISTINCT FROM 1 OR s.cash_payout_total IS DISTINCT FROM t.prize_pool'
    );
    expect(body).toContain("THEN 'payout row not one = pool to the winner'");
    expect(body).toContain('e.prize_balance IS DISTINCT FROM 0::numeric');
    expect(body).toContain('e.bounty_balance IS DISTINCT FROM 0::numeric');
    expect(body).toContain('v_pool IS DISTINCT FROM 1223.10');
    expect(body).toContain("AND fa.source = 'Tournament.atomic_finish_refused'");
    expect(body).toContain('IF v_n <> 26 THEN');
    expect(body).toContain('public.fn_ca_break_window_refuses_migrations(now())');
  });

  it('is one transaction that moves no money and creates no function', () => {
    expect(body.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(body.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(body).not.toMatch(/CREATE (OR REPLACE )?FUNCTION/i);
    expect(body).not.toMatch(
      /tournament_payouts\s+SET|INSERT INTO public\.(tournament_payouts|chip_ledger|tournament_escrow)/i
    );
    const updates = [...body.matchAll(/UPDATE\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(updates).toEqual(['public.financial_alerts']);
  });
});
