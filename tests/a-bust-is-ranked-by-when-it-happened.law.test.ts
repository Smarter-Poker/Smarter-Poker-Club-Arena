/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Four defects, root-caused on 798866ae (Early Bird Freeroll (NLH), frozen with
 * three players left and 100.20 in escrow):
 *
 *   1. the knockout door stamped eliminated_at = now(), the moment it ACCEPTED a
 *      bust, and every finishing place is ranked from eliminated_at, so a bust
 *      the door refused for a while took a better place than everyone who busted
 *      after it (64 of 83 recorded more than a minute late, one 26h42m);
 *   2. the standings normalizer renumbered places without re-pricing them, so
 *      the place prepare refused the event for ever with
 *      recorded_prize_disagrees_with_structure;
 *   3. an orphaned 'pending' generation left by the 2026-09-08/09 rebuy chain
 *      made the door refuse the same player's next, real bust for ever;
 *   4. the engine ordered a bust by the EARLIEST pending generation while the
 *      door records the LATEST.
 *
 * These pins are on the migration text and the engine source. The behaviour is
 * proved in PostgreSQL 17 by scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh
 * (every FIXED scenario must fail on a byte-exact capture of the live bodies and
 * pass after the migration), which the accounting_postgres CI job runs, and the
 * engine rule by server/src/tournament/bustOrder.test.ts.
 *
 * Registry: docs/laws.d/a-bust-is-ranked-by-when-it-happened.md
 */
import { describe, expect, it } from 'vitest';
import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const SLUG = '_a_bust_is_ranked_by_when_it_happened.sql';
const hits = readdirSync(MIGRATIONS).filter((f) => f.endsWith(SLUG));
const SQL = hits.length === 1 ? readFileSync(join(MIGRATIONS, hits[0]), 'utf8') : '';
const FIXTURE = join(ROOT, 'scripts/dev/fixtures/a-bust-is-ranked-by-when-it-happened');
const PROBE = join(ROOT, 'scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh');
const INSTALLED = readFileSync(join(FIXTURE, 'installed.sql'), 'utf8');

/** A function statement, from its CREATE to the end of its body. */
const fnIn = (sql: string, name: string): string => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const end = sql.indexOf('$function$;', start);
  if (start < 0 || end < 0) return '';
  return sql.slice(start, end);
};
/** Block and line comments cannot satisfy a pin. */
const code = (sql: string): string =>
  sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

const LEGACY = code(fnIn(SQL, 'fn_eliminate_player_legacy_candidate_20260907'));
const DOOR = code(fnIn(SQL, 'fn_eliminate_tournament_player_atomic'));
const NORMALIZE = code(fnIn(SQL, 'fn_normalize_tournament_final_standings'));
const LIVE_PREPARE = fnIn(INSTALLED, 'fn_prepare_tournament_place_obligations');

describe('a bust is ranked by when it happened', () => {
  it('ships as exactly one single-transaction migration with a lock budget', () => {
    expect(hits, `exactly one migration ends ${SLUG}`).toHaveLength(1);
    expect(SQL.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
    expect(SQL).toMatch(/^SET LOCAL lock_timeout = '\d+s';$/m);
    for (const body of [LEGACY, DOOR, NORMALIZE]) expect(body.length).toBeGreaterThan(1000);
  });

  it('refuses to apply over any body it was not reviewed against, and proves what it left', () => {
    // live md5s (preflight) and the reviewed result (postflight), per function
    for (const md5 of [
      'f596d731cacf8d7e62a4549204ce73fc', // legacy, live
      'b4937067d9bf337e1466095b9e1d5424', // door, live
      'ad865880f99bc28896bec03c66ae55a9', // normalizer, live
      '0602827901be20bbb6e0dce6ece17f94', // the candidate the door binds (read, not replaced)
      'ca0abbc6d297f3009143676261d8cf19', // the place prepare whose rule is copied (read)
    ]) {
      expect(SQL).toContain(`'${md5}'`);
    }
    expect(SQL).toContain('$preflight$');
    expect(SQL).toContain('$postflight$');
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_eliminate_player_legacy_candidate_20260907\([^)]*\)\s+FROM PUBLIC, anon, authenticated, service_role;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_eliminate_tournament_player_atomic\([^)]*\)\s+TO service_role;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_normalize_tournament_final_standings\(uuid\)\s+TO service_role;/
    );
    expect(SQL).not.toMatch(/TO (anon|authenticated)\b/);
  });

  describe('1. the door stamps the bust hand, never the clock', () => {
    it('writes eliminated_at from the bust, and nowhere from now()', () => {
      expect(LEGACY).not.toMatch(/eliminated_at\s*=\s*now\(\)/);
      expect(LEGACY).toContain('eliminated_at=v_bust_at');
    });

    it('takes the time from the accepted hand of the generation the door binds', () => {
      expect(LEGACY).toContain('SELECT a.committed_at');
      expect(LEGACY).toContain('JOIN public.hand_atomic_commits a');
      expect(LEGACY).toMatch(
        /a\.table_id=c\.table_id\s+AND a\.hand_number=c\.hand_number\s+AND a\.hand_id=c\.hand_id/
      );
      expect(LEGACY).toMatch(
        /c\.id=public\.fn_ca_latest_committed_knockout_candidate\(\s*p_tournament_id,p_user_id\)/
      );
      expect(DOOR).toMatch(
        /c\.id=public\.fn_ca_latest_committed_knockout_candidate\(\s*p_tournament_id,p_user_id\)/
      );
    });

    it('orders one hand by the smaller starting stack, then user id, a microsecond apart', () => {
      expect(LEGACY).toMatch(
        /\(s\.stack_before,s\.eliminated_user_id\)\s*<\(c\.stack_before,c\.eliminated_user_id\)/
      );
      expect(LEGACY).toContain("* interval '1 microsecond'");
    });

    it('refuses a bust whose hand it cannot read, before it writes anything', () => {
      const refusal = LEGACY.indexOf("'knockout_bust_time_unproven'");
      expect(refusal).toBeGreaterThan(-1);
      expect(refusal).toBeLessThan(LEGACY.indexOf('UPDATE public.tournament_players'));
    });
  });

  describe('2. a moved place is re-priced with the place prepare rule', () => {
    // Each fragment of the ladder rule must appear in the live prepare AND in the
    // normalizer, so the two cannot price a place differently.
    const RULE = [
      "round((e->>'percentage')::numeric * 100)::bigint",
      "WHERE (e->>'place')::integer <= v_",
      'LEAST(v_remaining_cents, round(v_pool_cents * r.bp::numeric / v_total_bp)::bigint), 0)',
      'v_expected_cents := GREATEST(v_remaining_cents, 0);',
      'FROM public.spin_payout_ladder l',
      'public.fn_safe_jsonb_array(v_t.payout_structure)',
      "OR (e->>'percentage')::numeric < 0",
    ];
    it.each(RULE)('prices with %s, as the live prepare does', (fragment) => {
      expect(LIVE_PREPARE).toContain(fragment);
      expect(NORMALIZE).toContain(fragment);
    });

    it('re-prices every moved row inside the same write as the renumbering', () => {
      const write = NORMALIZE.indexOf('SET position = a.position');
      const reprice = NORMALIZE.indexOf(
        'SET prize = round((v_reprice->>tp.id::text)::numeric / 100, 2)'
      );
      expect(write).toBeGreaterThan(-1);
      expect(reprice).toBeGreaterThan(write);
      expect(NORMALIZE).toContain("'the moved places were not re-priced to the ladder'");
      expect(NORMALIZE).toContain("'repriced', v_repriced");
    });

    it('refuses, and writes nothing, once money has moved for the event', () => {
      const refusal = NORMALIZE.indexOf("'moved_places_cannot_be_repriced_after_money_moved'");
      expect(refusal).toBeGreaterThan(-1);
      const scan = NORMALIZE.slice(
        NORMALIZE.lastIndexOf('IF v_reprice_rows > 0 THEN', refusal),
        refusal
      );
      expect(scan).toContain('FROM public.tournament_payouts p');
      expect(scan).toContain('FROM public.tournament_obligations o');
      expect(scan).toContain('RAISE WARNING');
      // before the clear-then-assign write
      expect(refusal).toBeLessThan(NORMALIZE.indexOf('SET position = NULL'));
    });

    it('never guesses a ladder, and never re-prices a satellite or a frozen result', () => {
      expect(NORMALIZE).toContain("'moved_places_cannot_be_priced'");
      expect(NORMALIZE.indexOf("'moved_places_cannot_be_priced'")).toBeLessThan(
        NORMALIZE.indexOf('SET position = NULL')
      );
      expect(NORMALIZE).toMatch(/IF NOT \(lower\(COALESCE\(v_t\.variant, ''\)\) = 'satellite'/);
      // the frozen branch still returns before any of this
      expect(NORMALIZE.indexOf("IF v_batch_exists OR v_status = 'COMPLETED' THEN")).toBeLessThan(
        NORMALIZE.indexOf('SELECT round(COALESCE(t.prize_pool, 0), 2) AS prize_pool')
      );
    });
  });

  describe('3. a generation a rebuy paid for is not a live bust', () => {
    const proof = DOOR.slice(
      DOOR.indexOf('INTO v_rebought_generations'),
      DOOR.indexOf("'unresolved_knockout_generation_chain'")
    );

    it('proves a pending generation bought back only by a posted wallet-to-pool rebuy leg', () => {
      for (const clause of [
        "AND c.state='pending'",
        'FROM public.chip_ledger l',
        'l.from_entity_id=p_user_id',
        'l.tournament_id=p_tournament_id',
        "l.category='rebuy'",
        "l.from_type='player_wallet'",
        "l.to_type='prize_liability'",
        "l.status='posted'",
        'l.amount>0',
        'l.created_at>c.created_at',
      ]) {
        expect(proof, clause).toContain(clause);
      }
    });

    it('and only a leg written before the next generation of that player', () => {
      expect(proof).toMatch(
        /l\.created_at<\(\s*SELECT n\.created_at\s+FROM public\.tournament_knockout_candidates n[\s\S]*?n\.hand_number>c\.hand_number\s+ORDER BY n\.hand_number,n\.id\s+LIMIT 1\)/
      );
    });

    it('still refuses every older generation it cannot prove', () => {
      expect(DOOR).toMatch(
        /AND c\.hand_number<v_candidate\.hand_number\s+AND c\.state<>'rebought'\s+AND c\.id<>ALL\(v_rebought_generations\)\s+\) THEN\s+RETURN jsonb_build_object\(\s+'ok',false,'reason','unresolved_knockout_generation_chain'\);/
      );
    });

    it('resolves only the proven rows, only after the bust is recorded, and says so', () => {
      const legacyCall = DOOR.indexOf('fn_eliminate_player_legacy_candidate_20260907(');
      const resolve = DOOR.indexOf("SET state='rebought'");
      expect(resolve).toBeGreaterThan(legacyCall);
      expect(DOOR.match(/SET state='rebought'/g) ?? []).toHaveLength(1);
      const block = DOOR.slice(DOOR.lastIndexOf('IF', resolve), DOOR.indexOf('END IF;', resolve));
      expect(block).toContain("coalesce((v_result->>'ok')::boolean,false)");
      expect(block).toContain('c.id=ANY(v_rebought_generations)');
      expect(block).toContain("c.state='pending'");
      expect(DOOR).toContain("'rebought_generations',to_jsonb(v_rebought_generations)");
      expect(DOOR).toContain(
        "'a bought-back knockout generation changed while elimination committed'"
      );
    });
  });

  describe('4. the engine orders a bust by the generation the door binds', () => {
    const ELIM = readFileSync(
      join(ROOT, 'server/src/tournament/TournamentManagerEliminations.ts'),
      'utf8'
    );
    const ORDER = readFileSync(join(ROOT, 'server/src/tournament/bustOrder.ts'), 'utf8');

    it('binds the latest generation of each player, whatever its state', () => {
      expect(ORDER).toMatch(/hand > seen\.hand \|\| \(hand === seen\.hand && id > seen\.id\)/);
      expect(ORDER).toContain("pending: row.state === 'pending'");
      expect(ELIM).toContain('bindLatestKnockoutCandidates(bustHands ?? [])');
      expect(ELIM).not.toMatch(/hand < seen/);
    });
  });

  describe('the behaviour gate is real and runs in CI', () => {
    it('the PostgreSQL 17 probe exists, is executable, and runs every scenario both ways', () => {
      expect(() => accessSync(PROBE, constants.X_OK)).not.toThrow();
      const probe = readFileSync(PROBE, 'utf8');
      expect(probe).toContain('passes on the live bodies, so it does not prove the fix');
      expect(probe).toContain("grep -q 'PROBE FAILED'");
      // the complete migration, applied twice: replay-safe, and the preflight
      // accepts its own result
      expect(probe.match(/psql_db fx_fixed -f "\$migration"/g) ?? []).toHaveLength(2);
      const scenarios = readdirSync(join(FIXTURE, 'scenarios')).filter((f) => f.endsWith('.sql'));
      expect(scenarios.length).toBeGreaterThanOrEqual(10);
      for (const s of scenarios) {
        expect(readFileSync(join(FIXTURE, 'scenarios', s), 'utf8'), s).toMatch(
          /^-- (FIXED|KEPT)\./
        );
      }
    });

    it('the accounting_postgres job runs it', () => {
      const ci = parseYaml(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
      expect(ci.jobs.accounting_postgres.steps).toContainEqual(
        expect.objectContaining({
          run: 'bash scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh',
          env: { PGBIN: '/usr/lib/postgresql/17/bin' },
        })
      );
    });
  });
});
