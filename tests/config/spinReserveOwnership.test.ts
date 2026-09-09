/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN RESERVE OWNERSHIP — the reserve is the UNION's, not the club's
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, verbatim: "THE RESERVE POOL COMES FROM THE UNION NOT THE CLUBS. IT ONLY
 * COMES FROM THE CLUBS IF THEY ARE A STAND ALONE CLUB WITH NO UNION
 * AFFILIATION. AND YOU NEED TO CREATE THE WALLET TO HOLD THE SEEDED AND
 * RESERVE FUNDS."
 *
 * Like spinEngineWiring, these read source rather than execute it — the RPCs
 * need a live Postgres and a running tournament. What is pinned here is not
 * behaviour under load, it is that four specific regressions cannot come back:
 *
 *   1. A spin RPC touching spin_bonus_pools with the PLAYING club's id
 *      instead of the resolved owner. That is the bug this migration fixes:
 *      one union ran three unrelated reserves, so the same capital cleared
 *      the 100x threshold at a third the rate and the top tier stayed locked
 *      for everyone while the union collectively held plenty.
 *
 *   2. Rake following the reserve into the union pool. Rake belongs to the
 *      club that generated it and reaches the union through the existing
 *      settlement path. Booking it against the pool owner would pay unions
 *      twice and starve every club's own P&L.
 *
 *   3. v_spin_tier_availability keyed off the POOL rather than off clubs.
 *      After pooling, an affiliated club has no pool row of its own, so a
 *      pool-keyed view returns nothing for it and the lobby's Spin badge goes
 *      dark. This is not hypothetical: on 2026-08-21 the can_draw_500x column
 *      was dropped while a cached client still selected it, the hook
 *      swallowed the error, and the badge went dark for real users.
 *
 *   4. The engine growing its own opinion about which pool to use. It passes
 *      only the immutable tournament identity to the atomic authority; the
 *      database reads the playing club and resolves the reserve owner under
 *      the same lock that commits the draw.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceSqlStatement, sliceCall } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/** Comments quote the very things these tests ban. Never match against them. */
const sqlCode = (src: string) => src.replace(/^[ \t]*--.*$/gm, '');
const tsCode = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260822030000_union_level_spin_reserve_wallet.sql';
const ATOMIC_MIGRATION =
  'supabase/migrations/20260909014433_spin_reserve_settlement_commits_its_journal_or_nothing.sql';

const migration = sqlCode(read(MIGRATION));
const atomicMigration = sqlCode(read(ATOMIC_MIGRATION));
const engine = tsCode(read('server/src/tournament/TournamentManagerBase.ts'));

/** The body of one CREATE [OR REPLACE] FUNCTION, bounded by its own $$ pair. */
function fnBody(name: string): string {
  const start = migration.indexOf(`FUNCTION public.${name}(`);
  expect(start, `expected ${name} to be defined in the migration`).toBeGreaterThan(-1);
  const open = migration.indexOf('AS $$', start);
  expect(open, `${name} has no $$ body`).toBeGreaterThan(start);
  const close = migration.indexOf('$$;', open + 5);
  expect(close, `${name} body is unterminated`).toBeGreaterThan(open);
  return migration.slice(open, close);
}

describe('Spin reserve ownership', () => {
  it('resolves ownership in exactly one place', () => {
    // A second resolver is a second answer, and money paths do not get to
    // have two. Every RPC calls fn_spin_reserve_pool, which calls
    // fn_spin_reserve_owner; nothing else re-derives it from clubs.union_id.
    expect(migration).toMatch(/FUNCTION public\.fn_spin_reserve_owner\(p_club_id uuid\)/);
    expect(migration).toMatch(/FUNCTION public\.fn_spin_reserve_pool\(p_club_id uuid\)/);

    const resolverBody = fnBody('fn_spin_reserve_owner');
    // The rule itself: the club's union, or the club when it has none.
    expect(resolverBody).toMatch(/c\.union_id/);
    expect(resolverBody).toMatch(/COALESCE/i);
    expect(resolverBody).toMatch(/p_club_id/);
  });

  it.each([
    'fn_spin_reserve_state',
    'fn_spin_reserve_seed',
    'fn_spin_draw_multiplier',
    'fn_spin_settle_game',
  ])('%s reads the pool by resolved owner, never by the playing club', (name) => {
    const body = fnBody(name);

    expect(body, `${name} must resolve the owner`).toMatch(
      /v_owner\s*:=\s*public\.fn_spin_reserve_pool\(p_club_id\)/
    );

    // The regression in one line: any pool access keyed on the raw argument.
    expect(body, `${name} still keys spin_bonus_pools on the playing club`).not.toMatch(
      /spin_bonus_pools[\s\S]{0,400}?club_id\s*=\s*p_club_id/
    );
  });

  it('keeps rake with the club that generated it', () => {
    const settle = fnBody('fn_spin_settle_game');
    const i = settle.indexOf('INSERT INTO public.rake_records');
    expect(i, 'settlement must still book rake').toBeGreaterThan(-1);

    const insert = sliceSqlStatement(settle, 'INSERT INTO public.rake_records');
    // The club column is p_club_id. v_owner may appear in metadata for
    // traceability, but must never be the club the rake is booked against.
    expect(insert).toMatch(/p_club_id,\s*v_rake/);
    expect(insert).not.toMatch(/v_owner,\s*v_rake/);
  });

  it('gives every club a tier-availability row, pooled or not', () => {
    const i = migration.indexOf('CREATE VIEW public.v_spin_tier_availability');
    expect(i, 'expected the availability view').toBeGreaterThan(-1);
    const view = migration.slice(i, migration.indexOf(';', i));

    // Driven FROM clubs and joined to the owner's pool. Driven from the pool
    // instead, an affiliated club returns no row at all and its badge dies.
    expect(view).toMatch(/FROM public\.clubs c/);
    expect(view).toMatch(/JOIN public\.spin_bonus_pools p[\s\S]*fn_spin_reserve_owner\(c\.id\)/);
    expect(view).toMatch(/c\.id AS club_id/);

    // The retired tier must not come back through a view.
    expect(view).not.toMatch(/can_draw_500x/);
  });

  it('creates the wallet that holds seeded and reserve funds', () => {
    expect(migration).toMatch(
      /ALTER TABLE public\.union_wallets[\s\S]{0,120}spin_reserve_wallet numeric NOT NULL DEFAULT 0/
    );
    // A wallet that can only be spent down is not a wallet.
    expect(migration).toMatch(/FUNCTION public\.fn_spin_reserve_wallet_fund\(/);

    // Surplus above the ceiling has a destination now. Before this it simply
    // decremented the pool and landed nowhere at all.
    const settle = fnBody('fn_spin_settle_game');
    expect(settle).toMatch(
      /UPDATE public\.union_wallets[\s\S]{0,160}spin_reserve_wallet\s*=\s*spin_reserve_wallet\s*\+\s*v_return/
    );
  });

  it('will not let a union seed a reserve it does not own', () => {
    const body = fnBody('fn_spin_reserve_seed_from_union');
    expect(body).toMatch(/v_owner\s*:=\s*public\.fn_spin_reserve_owner\(p_club_id\)/);
    expect(body).toMatch(/v_owner\s*<>\s*p_union_id/);
    expect(body).toMatch(/union_does_not_own_this_reserve/);
  });

  it('books a pool merge as its own ledger kind, not as a shortfall', () => {
    // v_spin_reserve_health counts kind='adjustment' as shortfall events and
    // the spin-sweep cron alerts on any non-zero count. A merge booked as an
    // adjustment pages someone about a shortfall that never happened.
    expect(migration).toMatch(/CHECK \(kind IN \([\s\S]{0,200}'merge'/);
    expect(migration).toMatch(/'merge', -r\.balance/);
    expect(migration).toMatch(/'merge', r\.balance/);
  });

  it('keeps reserve ownership inside the one atomic database authority', () => {
    const call = sliceCall(engine, "supabase.rpc('fn_spin_draw_and_settle'");
    expect(call).toMatch(/p_tournament_id:\s*this\.tournamentId/);
    expect(call).toMatch(/p_tiers:\s*SPIN_TIERS\.map/);
    expect(call).not.toMatch(/p_club_id|p_union_id|union_id/);

    // The two old process-side doors remain database primitives during the
    // rolling migration, but the live engine may no longer call either one.
    expect(engine).not.toMatch(/supabase\.rpc\('fn_spin_(?:draw_multiplier|settle_game)'/);

    const authority = (() => {
      const start = atomicMigration.indexOf(
        'CREATE OR REPLACE FUNCTION public.fn_spin_draw_and_settle('
      );
      expect(start).toBeGreaterThan(-1);
      const source = atomicMigration.slice(start);
      const open = source.indexOf('AS $spin_authority$');
      const close = source.indexOf('$spin_authority$;', open + 1);
      expect(open).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(open);
      return source.slice(open, close);
    })();
    expect(authority).toMatch(
      /SELECT t\.id, t\.club_id[\s\S]*INTO v_t[\s\S]*FROM public\.tournaments t[\s\S]*WHERE t\.id = p_tournament_id[\s\S]*FOR UPDATE/
    );
    expect(authority).toMatch(/v_owner\s*:=\s*public\.fn_spin_reserve_pool\(v_t\.club_id\)/);
    expect(authority).toMatch(/public\.fn_spin_settle_game\(\s*p_tournament_id, v_t\.club_id/);
  });
});
