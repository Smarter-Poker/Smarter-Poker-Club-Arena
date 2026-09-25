/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  A BUST IS RANKED BY WHEN IT HAPPENED (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE RULE. A finishing place is decided by when the bust happened: the commit
 * time of the accepted hand that took the stack. Busts in different hands are
 * ordered by those commit times; busts in one hand rank the smaller hand-start
 * stack first (TDA), then user id, one microsecond apart. Hand-for-hand
 * simultaneity is out of scope.
 *
 * What was wrong, root-caused on production (read-only):
 *
 *   1. the engine's finish, fn_settle_tournament_places, numbered places by
 *      elimination_sequence - RECORDING order - so a bust the door recorded late
 *      was paid a place it did not finish in (15 COMPLETED events in 34 hours,
 *      about 1,437-1,659 chips, 11 of them bounty events);
 *   2. both knockout doors stamped eliminated_at = now(), the moment they
 *      ACCEPTED a bust;
 *   3. the standings normalizer renumbered places without re-pricing them;
 *   4. an orphaned 'pending' generation left by the 2026-09-08/09 rebuy chain
 *      made both doors refuse the same player's next, real bust for ever;
 *   5. a player who played on after such a rebuy could be recorded at the bust
 *      they came back from;
 *   6. the unfinished-finish alarm measured from eliminated_at, which is now a
 *      bust time and can be long before the bust was recorded;
 *   7. the engine ordered a bust by the EARLIEST pending generation while the
 *      door records the LATEST, and read the generations with no row-cap guard.
 *
 * Found by two verifications of the second pass (2026-09-11):
 *
 *   8. the hand-history prune deletes a horse-only hand's commit row after
 *      seven days, and the finish then fell back to eliminated_at - the
 *      RECORDING time for every bust recorded before this change; it now reads
 *      the generation's capture time, which the prune never deletes;
 *   9. a door refusal that cannot clear by itself left the player 'playing' at
 *      zero chips, so the event could never finish, and nothing said so; both
 *      doors now write one critical financial alert per player for it;
 *  10. the bounty door resolved an older generation no obligation names, whose
 *      head was never collected, handing that head to the player's next
 *      knocker; it now requires the head collected.
 *
 * Satellites and final-table deals keep their own authorities, which this
 * migration did not claim and which ranked by recording order until
 * 20260921095012 gave them the same bust witness; the header says so rather
 * than claiming them, and the assertions below still hold of THIS file. The
 * reviewed inverse is docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql.
 *
 * These pins are on the migration text and the engine source. The behaviour is
 * proved in PostgreSQL 17 by scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh
 * (every FIXED scenario must fail on a byte-exact capture of the live bodies and
 * pass after the migration, applied twice), which the accounting_postgres CI job
 * runs, and the engine rule by server/src/tournament/bustOrder.test.ts.
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
const MANIFEST = JSON.parse(readFileSync(join(FIXTURE, 'source-manifest.json'), 'utf8')) as {
  bodies: Record<string, string>;
};

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
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const REPLACED = {
  fn_settle_tournament_places: 'd0262f4928b12eea1cc5e9175cbf2737',
  fn_eliminate_player_legacy_candidate_20260907: 'f596d731cacf8d7e62a4549204ce73fc',
  fn_claim_bounty_legacy_candidate_20260907: '590f0f782e127288f33763bbab8c89f0',
  fn_eliminate_tournament_player_atomic: 'b4937067d9bf337e1466095b9e1d5424',
  fn_claim_tournament_bounty_elimination: '876456f79250a307292dc6f2ae1564f3',
  fn_normalize_tournament_final_standings: 'ad865880f99bc28896bec03c66ae55a9',
  fn_ca_tournament_finished_but_not_completed: 'e1eebfe28f393f2617c0a1ac93c2583a',
} as const;
const READ_ONLY = {
  fn_ca_latest_committed_knockout_candidate: '0602827901be20bbb6e0dce6ece17f94',
  fn_prepare_tournament_place_obligations: 'ca0abbc6d297f3009143676261d8cf19',
  fn_bounty_obligation_has_complete_marker: 'bd29069e8d07bedf84e24e57242c2afe',
} as const;

const SETTLE_RAW = fnIn(SQL, 'fn_settle_tournament_places');
const SETTLE = code(SETTLE_RAW);
const LEGACY = code(fnIn(SQL, 'fn_eliminate_player_legacy_candidate_20260907'));
const BOUNTY_LEGACY = code(fnIn(SQL, 'fn_claim_bounty_legacy_candidate_20260907'));
const DOOR = code(fnIn(SQL, 'fn_eliminate_tournament_player_atomic'));
const BOUNTY_DOOR = code(fnIn(SQL, 'fn_claim_tournament_bounty_elimination'));
const NORMALIZE = code(fnIn(SQL, 'fn_normalize_tournament_final_standings'));
const ALARM = code(fnIn(SQL, 'fn_ca_tournament_finished_but_not_completed'));
const LIVE_PREPARE = fnIn(INSTALLED, 'fn_prepare_tournament_place_obligations');
const LIVE_SETTLE = fnIn(INSTALLED, 'fn_settle_tournament_places');
const LIVE_BOUNTY_LEGACY = fnIn(INSTALLED, 'fn_claim_bounty_legacy_candidate_20260907');
const LIVE_ALARM = fnIn(INSTALLED, 'fn_ca_tournament_finished_but_not_completed');
const ROLLBACK_PATH = join(
  ROOT,
  'docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql'
);
const ROLLBACK = readFileSync(ROLLBACK_PATH, 'utf8');
const HEADER = SQL.slice(0, SQL.indexOf('BEGIN;'));

describe('a bust is ranked by when it happened', () => {
  describe('the migration is one reviewed transaction', () => {
    it('ships as exactly one single-transaction migration with a lock budget', () => {
      expect(hits, `exactly one migration ends ${SLUG}`).toHaveLength(1);
      expect(SQL.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
      expect(SQL.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
      expect(SQL).toMatch(/^SET LOCAL lock_timeout = '5s';$/m);
      expect(SQL).toMatch(/^SET LOCAL statement_timeout = '\d+s';$/m);
      for (const name of Object.keys(REPLACED)) {
        expect(fnIn(SQL, name).length, name).toBeGreaterThan(1000);
      }
      expect(count(SQL, 'CREATE OR REPLACE FUNCTION')).toBe(Object.keys(REPLACED).length);
    });

    it('says in its header that it must not be applied inside the break window', () => {
      const header = SQL.slice(0, SQL.indexOf('BEGIN;'));
      expect(header).toMatch(/DO NOT APPLY INSIDE MINUTE :50-:03 UTC/);
    });

    it('writes no data: outside function bodies there is only DDL, grants and checks', () => {
      const outside = SQL.replace(/\$function\$[\s\S]*?\$function\$/g, '')
        .replace(/\$preflight\$[\s\S]*?\$preflight\$/g, '')
        .replace(/\$postflight\$[\s\S]*?\$postflight\$/g, '');
      expect(code(outside)).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i
      );
      // and the checks themselves only read the catalog
      for (const tag of ['$preflight$', '$postflight$']) {
        const block = SQL.slice(SQL.indexOf(tag), SQL.lastIndexOf(tag));
        expect(block).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
      }
    });

    it('refuses to apply over any body it was not reviewed against, and proves what it left', () => {
      const pre = SQL.slice(SQL.indexOf('$preflight$'), SQL.lastIndexOf('$preflight$'));
      const post = SQL.slice(SQL.indexOf('$postflight$'), SQL.lastIndexOf('$postflight$'));
      for (const [name, md5] of Object.entries({ ...REPLACED, ...READ_ONLY })) {
        expect(pre, `${name} is pinned to its live body`).toContain(`'${md5}'`);
        expect(pre).toContain(`public.${name}(`);
      }
      for (const name of Object.keys(REPLACED)) {
        expect(post, `${name} is proven after the migration`).toContain(`public.${name}(`);
      }
      // the live md5s are exactly the bodies the PostgreSQL 17 probe runs
      for (const [name, md5] of Object.entries({ ...REPLACED, ...READ_ONLY })) {
        const identity = Object.keys(MANIFEST.bodies).find((k) => k.startsWith(`public.${name}(`));
        expect(identity, `${name} is captured in installed.sql`).toBeDefined();
        expect(MANIFEST.bodies[identity!]).toBe(md5);
      }
      // no replaced body is proven to be its live body afterwards
      for (const md5 of Object.values(REPLACED)) expect(post).not.toContain(`'${md5}'`);
    });

    it('restates the live authority of every function and admits no new caller', () => {
      for (const name of [
        'fn_eliminate_player_legacy_candidate_20260907',
        'fn_claim_bounty_legacy_candidate_20260907',
      ]) {
        expect(SQL).toMatch(
          new RegExp(
            `REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated, service_role;`
          )
        );
        expect(SQL).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\(`));
      }
      for (const name of [
        'fn_settle_tournament_places',
        'fn_eliminate_tournament_player_atomic',
        'fn_claim_tournament_bounty_elimination',
        'fn_normalize_tournament_final_standings',
        'fn_ca_tournament_finished_but_not_completed',
      ]) {
        expect(SQL).toMatch(
          new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\)\\s+TO service_role;`)
        );
      }
      expect(SQL).not.toMatch(/TO (anon|authenticated)\b/);
      // settings are part of the reviewed authority
      expect(SETTLE_RAW).toContain("SET search_path TO 'public'\n SET statement_timeout TO '30s'");
    });

    it('carries no transient data inside a function body', () => {
      for (const name of Object.keys(REPLACED)) {
        const body = fnIn(SQL, name);
        for (const id of ['798866ae', '7aa16fa7', 'a5aa6984', 'dca6c345', '9bb330b7']) {
          expect(body, `${name} names ${id}`).not.toContain(id);
        }
        expect(body).not.toMatch(/further orphans sit/i);
      }
      expect(SQL).not.toMatch(/dca6c345[\s\S]{0,200}resolves it when that player next busts/);
    });
  });

  describe('1. the finish ranks every bust by the hand that took the stack', () => {
    const ORDER = 'ORDER BY b.bust_at DESC, b.elimination_sequence DESC, b.id ASC';

    it('derives the bust from the consumed generation and its hand commit, in the statement', () => {
      // the player's latest generation the door consumed ...
      expect(count(SETTLE, "AND k.state = 'eliminated'")).toBe(2);
      expect(count(SETTLE, 'ORDER BY k.hand_number DESC, k.id DESC')).toBe(2);
      // ... and the commit of exactly its hand
      expect(
        SETTLE.match(
          /a\.table_id = c\.table_id\s+AND a\.hand_number = c\.hand_number\s+AND a\.hand_id = c\.hand_id/g
        ) ?? []
      ).toHaveLength(2);
      // the door's same-hand rule, one microsecond per earlier rank
      expect(
        SETTLE.match(
          /\(s\.stack_before, s\.eliminated_user_id\)\s*<\s*\(c\.stack_before, c\.eliminated_user_id\)/g
        ) ?? []
      ).toHaveLength(2);
      expect(count(SETTLE, "* interval '1 microsecond'")).toBe(2);
      // no witness: the row's own eliminated_at
      expect(count(SETTLE, '), tp.eliminated_at) AS bust_at')).toBe(2);
    });

    it('times a hand by its first capture when the prune has taken its commit', () => {
      // the generation rows are never pruned; the hand's commit row can be
      expect(count(SETTLE, 'LEFT JOIN public.hand_atomic_commits a')).toBe(2);
      // one time for the whole hand - the earliest capture of its generations -
      // so the same-hand stack rank still decides within it
      expect(
        SETTLE.match(
          /SELECT COALESCE\(a\.committed_at,\s+\(SELECT min\(g\.created_at\)\s+FROM public\.tournament_knockout_candidates g\s+WHERE g\.tournament_id = c\.tournament_id\s+AND g\.table_id = c\.table_id\s+AND g\.hand_number = c\.hand_number\s+AND g\.hand_id = c\.hand_id\)\)/g
        ) ?? []
      ).toHaveLength(2);
      // never one generation's own capture (a hand's captures are seconds apart
      // and out of stack order), never an inner join that turns a pruned commit
      // into the recording order
      expect(SETTLE).not.toMatch(/\bc\.created_at\b/);
      expect(SETTLE).not.toMatch(/^\s+JOIN public\.hand_atomic_commits a/m);
      expect(SETTLE).not.toMatch(/SELECT a\.committed_at\s/);
      expect(HEADER).toContain('sp_prune_hand_history');
    });

    it('decides whether anything moves by the same order it renumbers by', () => {
      expect(count(SETTLE, ORDER)).toBe(2);
      const check = SETTLE.indexOf('INTO v_unwitnessed_busts, v_misplaced_busts');
      const renumber = SETTLE.indexOf('SET position = ranked.expected_position');
      expect(check).toBeGreaterThan(-1);
      expect(renumber).toBeGreaterThan(check);
      expect(SETTLE.lastIndexOf(ORDER, check)).toBeGreaterThan(-1);
      expect(SETTLE.lastIndexOf(ORDER, renumber)).toBeGreaterThan(check);
      expect(SETTLE).toContain('IF v_misplaced_busts > 0 THEN');
    });

    it('refuses a bust with no witness and no time before it renumbers anything', () => {
      const refusal = SETTLE.indexOf(
        "'tournament % has % eliminated player(s) with no bust witness and no eliminated_at'"
      );
      expect(refusal).toBeGreaterThan(-1);
      expect(refusal).toBeLessThan(SETTLE.indexOf('SET position = NULL'));
      expect(SETTLE).toContain('IF v_unwitnessed_busts > 0 THEN');
    });

    it('never relabels a place that carries money, except a COMPLETING replay of the recording ladder', () => {
      const evidence = SETTLE.slice(
        SETTLE.indexOf('IF v_misplaced_busts > 0 THEN'),
        SETTLE.indexOf('SET position = NULL')
      );
      expect(evidence).toContain('AND p."position" IS NOT NULL');
      expect(evidence).toContain("AND o.kind = 'place'");
      expect(evidence).toContain(
        "'tournament % needs a late-entry position normalization but already carries settled place evidence'"
      );
      expect(evidence).toMatch(/IF v_status <> 'COMPLETING' OR EXISTS \(/);
      expect(evidence).toContain('ORDER BY tp.elimination_sequence DESC, tp.id ASC');
      // the renumber is only in the branch with no money on the ladder
      expect(
        SETTLE.slice(
          SETTLE.indexOf('SET position = NULL') - 200,
          SETTLE.indexOf('SET position = NULL')
        )
      ).toMatch(/ELSE\s+UPDATE public\.tournament_players tp\s*$/);
    });

    it('keeps elimination_sequence as the witness of the last elimination, and nothing else changes', () => {
      expect(SETTLE).toContain('tp.elimination_sequence > v_winner.elimination_sequence');
      expect(SETTLE).toContain("'tournament % has an ambiguous final elimination witness'");
      // Outside the ranking block and its two variables, the body is the live
      // body byte for byte: the winner rule, every ladder check, the COMPLETED
      // exact replay, the payment walk and the receipts.
      const startNew = SETTLE_RAW.indexOf('    /* A BUST IS RANKED BY WHEN IT HAPPENED');
      const startLive = LIVE_SETTLE.indexOf(
        '    IF EXISTS (\n      SELECT 1\n        FROM (\n          SELECT tp.id, tp.position,'
      );
      const tail = '  -- Derive the single pool-funded bubble promise after standings are final.';
      expect(startNew).toBeGreaterThan(0);
      expect(startLive).toBeGreaterThan(0);
      const declared = '  v_unwitnessed_busts integer;\n  v_misplaced_busts integer;\n';
      expect(SETTLE_RAW).toContain(declared);
      expect(SETTLE_RAW.slice(0, startNew).replace(declared, '')).toBe(
        LIVE_SETTLE.slice(0, startLive)
      );
      expect(SETTLE_RAW.slice(SETTLE_RAW.indexOf(tail))).toBe(
        LIVE_SETTLE.slice(LIVE_SETTLE.indexOf(tail))
      );
    });
  });

  describe('2. both doors stamp the bust hand, never the clock', () => {
    for (const [label, body, user] of [
      ['non-bounty', LEGACY, 'p_user_id'],
      ['bounty', BOUNTY_LEGACY, 'p_eliminated_user_id'],
    ] as const) {
      it(`the ${label} write half takes the time from the accepted hand it is bound to`, () => {
        expect(body).not.toMatch(/eliminated_at\s*=\s*now\(\)/);
        expect(body).toContain('eliminated_at=v_bust_at');
        expect(body).toContain('SELECT a.committed_at');
        expect(body).toContain('JOIN public.hand_atomic_commits a');
        expect(body).toMatch(
          /a\.table_id=c\.table_id\s+AND a\.hand_number=c\.hand_number\s+AND a\.hand_id=c\.hand_id/
        );
        expect(body).toMatch(
          /\(s\.stack_before,s\.eliminated_user_id\)\s*<\(c\.stack_before,c\.eliminated_user_id\)/
        );
        expect(body).toContain("* interval '1 microsecond'");
        expect(body).toContain("AND c.state='pending'");
        expect(body).toContain(`AND c.eliminated_user_id=${user}`);
      });

      it(`the ${label} write half refuses what it cannot prove, before it writes anything`, () => {
        const firstWrite = body.indexOf('UPDATE public.tournament_players');
        expect(body.indexOf("'knockout_bust_time_unproven'")).toBeGreaterThan(-1);
        expect(body.indexOf("'knockout_bust_time_unproven'")).toBeLessThan(firstWrite);
        // played on after a rebuy: a posted leg after the bound generation AND a later hand
        const guard = body.slice(body.indexOf('FROM public.chip_ledger l'), firstWrite);
        for (const clause of [
          `l.from_entity_id=${user}`,
          'l.tournament_id=p_tournament_id',
          "l.category='rebuy'",
          "l.from_type='player_wallet'",
          "l.to_type='prize_liability'",
          "l.status='posted'",
          'l.amount>0',
          'FROM public.hand_history h',
          'h.tournament_id=p_tournament_id',
          `'userId',${user}::text`,
          `'user_id',${user}::text`,
          "'detail','played_on_after_a_rebuy'",
        ]) {
          expect(guard, clause).toContain(clause);
        }
        expect(guard).toMatch(/l\.created_at>v_(bust_captured_at|candidate\.created_at)/);
        expect(guard).toMatch(/h\.hand_number>(v_bust_hand|p_hand_number)/);
      });
    }

    it('the non-bounty write half binds the generation the door bound', () => {
      expect(LEGACY).toMatch(
        /c\.id=public\.fn_ca_latest_committed_knockout_candidate\(\s*p_tournament_id,p_user_id\)/
      );
      expect(DOOR).toMatch(
        /c\.id=public\.fn_ca_latest_committed_knockout_candidate\(\s*p_tournament_id,p_user_id\)/
      );
    });

    it('the bounty write half changes nothing but the stamp and its refusals', () => {
      const raw = fnIn(SQL, 'fn_claim_bounty_legacy_candidate_20260907');
      const start = raw.indexOf('  /* A BUST IS RANKED BY WHEN IT HAPPENED');
      const end = raw.indexOf(
        "  UPDATE public.tournament_players tp\n     SET status='eliminated'"
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const restored = (raw.slice(0, start) + raw.slice(end))
        .replace('  v_bust_at timestamptz;\n', '')
        .replace('eliminated_at=v_bust_at', 'eliminated_at=now()');
      expect(restored).toBe(LIVE_BOUNTY_LEGACY);
    });
  });

  describe('3. a moved place is re-priced with the place prepare rule, held only by place money', () => {
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

    it('refuses, and writes nothing, once PLACE money has moved - and only then', () => {
      const refusal = NORMALIZE.indexOf("'moved_places_cannot_be_repriced_after_money_moved'");
      expect(refusal).toBeGreaterThan(-1);
      const scan = NORMALIZE.slice(
        NORMALIZE.lastIndexOf('IF v_reprice_rows > 0 THEN', refusal),
        refusal
      );
      expect(scan).toContain('FROM public.tournament_payouts p');
      expect(scan).toMatch(
        /COALESCE\(p\.source, ''\) NOT IN \('bounty', 'own_bounty', 'mystery_bounty',\s*'mystery_bounty_residual', 'bounty_residual',\s*'satellite_seat'\)/
      );
      expect(scan).toContain('FROM public.tournament_obligations o');
      expect(scan).toContain("AND o.kind IN ('place', 'bubble_protection')");
      expect(scan).toContain('RAISE WARNING');
      expect(refusal).toBeLessThan(NORMALIZE.indexOf('SET position = NULL'));
    });

    it('never guesses a ladder, and never re-prices a satellite or a frozen result', () => {
      expect(NORMALIZE).toContain("'moved_places_cannot_be_priced'");
      expect(NORMALIZE.indexOf("'moved_places_cannot_be_priced'")).toBeLessThan(
        NORMALIZE.indexOf('SET position = NULL')
      );
      expect(NORMALIZE).toMatch(/IF NOT \(lower\(COALESCE\(v_t\.variant, ''\)\) = 'satellite'/);
      expect(NORMALIZE.indexOf("IF v_batch_exists OR v_status = 'COMPLETED' THEN")).toBeLessThan(
        NORMALIZE.indexOf('SELECT round(COALESCE(t.prize_pool, 0), 2) AS prize_pool')
      );
    });
  });

  describe('4. a generation a rebuy paid for is not a live bust, at either door', () => {
    for (const [label, body, user] of [
      ['non-bounty', DOOR, 'p_user_id'],
      ['bounty', BOUNTY_DOOR, 'p_eliminated_user_id'],
    ] as const) {
      const proof = body.slice(
        body.indexOf('INTO v_rebought_generations'),
        body.indexOf("'unresolved_knockout_generation_chain'")
      );

      it(`the ${label} door proves a pending generation bought back only by a posted wallet-to-pool rebuy leg`, () => {
        for (const clause of [
          "AND c.state='pending'",
          'FROM public.chip_ledger l',
          `l.from_entity_id=${user}`,
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
        expect(proof).toMatch(
          /l\.created_at<\(\s*SELECT n\.created_at\s+FROM public\.tournament_knockout_candidates n[\s\S]*?n\.hand_number>c\.hand_number\s+ORDER BY n\.hand_number,n\.id\s+LIMIT 1\)/
        );
      });

      it(`the ${label} door still refuses every older generation it cannot prove`, () => {
        expect(body).toMatch(
          /AND c\.hand_number<v_candidate\.hand_number\s+AND c\.state<>'rebought'\s+AND c\.id<>ALL\(v_rebought_generations\)\s+\) THEN\s+INSERT INTO public\.financial_alerts\(severity,source,message,context\)[\s\S]*?\);\s+RETURN jsonb_build_object\(\s+'ok',false,'reason','unresolved_knockout_generation_chain'\);/
        );
      });

      it(`the ${label} door resolves only the proven rows, only after the bust is recorded`, () => {
        const legacyCall = body.search(
          /fn_(eliminate_player|claim_bounty)_legacy_candidate_20260907\(\s*p_tournament_id/
        );
        const resolve = body.indexOf("SET state='rebought'");
        expect(resolve).toBeGreaterThan(legacyCall);
        expect(body.match(/SET state='rebought'/g) ?? []).toHaveLength(1);
        const block = body.slice(body.lastIndexOf('IF', resolve), body.indexOf('END IF;', resolve));
        expect(block).toContain("coalesce((v_result->>'ok')::boolean,false)");
        expect(block).toContain('c.id=ANY(v_rebought_generations)');
        expect(block).toContain("c.state='pending'");
        expect(body).toContain("'rebought_generations',to_jsonb(v_rebought_generations)");
      });
    }

    it('the bounty door resolves a generation only once its head was collected', () => {
      const proof = BOUNTY_DOOR.slice(
        BOUNTY_DOOR.indexOf('INTO v_rebought_generations'),
        BOUNTY_DOOR.indexOf("'unresolved_knockout_generation_chain'")
      );
      // its own obligation exists: a head no obligation names was never
      // collected, and resolving it would hand it to the next knocker
      expect(proof).toMatch(
        /AND EXISTS \(\s*SELECT 1 FROM public\.tournament_bounty_obligations o\s+WHERE o\.tournament_id=p_tournament_id\s+AND o\.eliminated_user_id=p_eliminated_user_id\s+AND o\.table_id=c\.table_id\s+AND o\.hand_id=c\.hand_id\s+AND o\.hand_number=c\.hand_number\)/
      );
      // ... and every obligation naming its hand or chair is settled and complete
      expect(proof).toMatch(
        /AND NOT EXISTS \(\s*SELECT 1 FROM public\.tournament_bounty_obligations o\s+WHERE o\.tournament_id=p_tournament_id\s+AND o\.eliminated_user_id=p_eliminated_user_id\s+AND \(o\.hand_number=c\.hand_number\s+OR o\.seat_joined_at=c\.seat_joined_at\)\s+AND NOT \(o\.state='settled'\s+AND public\.fn_bounty_obligation_has_complete_marker\(o\.id\)\)\)/
      );
      // and only with a claim that was actually made
      const resolve = BOUNTY_DOOR.indexOf("SET state='rebought'");
      const block = BOUNTY_DOOR.slice(BOUNTY_DOOR.lastIndexOf('IF', resolve), resolve);
      expect(block).toContain("coalesce((v_result->>'claimed')::boolean,false)");
    });
  });

  describe('4b. a refusal that cannot clear by itself raises one alert per player', () => {
    const SOURCE = "'critical','knockout_door.payout_blocked_by_unrecordable_bust'";
    for (const [label, body, user, reason] of [
      ['non-bounty write half', LEGACY, 'p_user_id', 'knockout_bust_time_unproven'],
      ['bounty write half', BOUNTY_LEGACY, 'p_eliminated_user_id', 'knockout_bust_time_unproven'],
      ['non-bounty door', DOOR, 'p_user_id', 'unresolved_knockout_generation_chain'],
      ['bounty door', BOUNTY_DOOR, 'p_eliminated_user_id', 'unresolved_knockout_generation_chain'],
    ] as const) {
      it(`the ${label} names the player it cannot record, once while the alert is open`, () => {
        expect(
          count(body, 'INSERT INTO public.financial_alerts(severity,source,message,context)')
        ).toBe(label === 'bounty write half' ? 2 : 1);
        const at = body.indexOf(SOURCE);
        expect(at).toBeGreaterThan(-1);
        const insert = body.slice(at, body.indexOf('RETURN jsonb_build_object', at));
        expect(insert).toContain(`'reason','${reason}'`);
        expect(insert).toContain(`'tournament_id',p_tournament_id,'user_id',${user}`);
        expect(insert).toMatch(
          new RegExp(
            `WHERE NOT EXISTS \\(\\s*SELECT 1 FROM public\\.financial_alerts fa\\s+WHERE fa\\.source='knockout_door\\.payout_blocked_by_unrecordable_bust'\\s+AND NOT fa\\.resolved\\s+AND fa\\.context->>'tournament_id'=p_tournament_id::text\\s+AND fa\\.context->>'user_id'=${user}::text\\);`
          )
        );
        // the refusal it announces is the very next statement
        expect(
          body.slice(
            body.indexOf('RETURN jsonb_build_object', at),
            body.indexOf(';', body.indexOf('RETURN jsonb_build_object', at))
          )
        ).toContain(`'${reason}'`);
      });
    }
  });

  describe('5. the unfinished-finish alarm counts from when the last bust was recorded', () => {
    it('measures from the latest recording, not the latest bust', () => {
      expect(ALARM).toMatch(
        /GREATEST\(\s*\(SELECT max\(tp\.eliminated_at\) FROM public\.tournament_players tp\s+WHERE tp\.tournament_id = t\.id AND tp\.eliminated_at IS NOT NULL\),\s*\(SELECT max\(c\.resolved_at\) FROM public\.tournament_knockout_candidates c\s+WHERE c\.tournament_id = t\.id AND c\.state = 'eliminated'\)\) AS last_elimination/
      );
      // and nothing else in it changed
      const live = LIVE_ALARM.replace(
        /\(SELECT max\(tp\.eliminated_at\) FROM public\.tournament_players tp\n\s+WHERE tp\.tournament_id = t\.id AND tp\.eliminated_at IS NOT NULL\) AS last_elimination,/,
        'X'
      );
      const mine = fnIn(SQL, 'fn_ca_tournament_finished_but_not_completed').replace(
        /(\s+--[^\n]*\n)+\s+GREATEST\([\s\S]*?\) AS last_elimination,/,
        '\n           X'
      );
      expect(mine).toBe(live);
    });
  });

  describe('6. the engine orders by the generation the door binds, and knows its order is provisional', () => {
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

    it('refuses a generations read PostgREST cut short', () => {
      expect(ELIM).toContain("count: 'exact'");
      expect(ELIM).toContain(
        'if (bustHandsErr || !knockoutCandidateReadIsComplete(bustHands, bustHandsCount))'
      );
      expect(ORDER).toContain('exactCount === rows.length');
    });

    it('says the same thing as the migration about which order decides the place', () => {
      expect(ORDER).toContain('COMMIT TIME');
      expect(ORDER).toContain('PROVISIONAL');
      expect(ORDER).toMatch(/Hand-for-hand play/);
      expect(SQL).toMatch(/Hand-for-hand(\s|--)+play/);
      expect(SQL.slice(0, SQL.indexOf('BEGIN;'))).toContain('hand_atomic_commits.committed_at');
      expect(ELIM).not.toContain(
        'orders eliminated\n               * players by elimination_sequence'
      );
    });
  });

  describe('what it does not cover is said, and it can be undone', () => {
    it('says satellites and final-table deals keep their own recording-order authorities', () => {
      expect(HEADER).toContain('NOT CHANGED HERE: SATELLITES AND FINAL-TABLE DEALS');
      expect(HEADER).toContain('fn_settle_satellite_tournament_pre_money_path_gate');
      expect(HEADER).toContain('fn_settle_tournament_final_table_deal');
      expect(HEADER).not.toMatch(/Every tournament finishes through/);
      expect(count(SQL, 'CREATE OR REPLACE FUNCTION public.fn_settle_satellite')).toBe(0);
      expect(
        count(SQL, 'CREATE OR REPLACE FUNCTION public.fn_settle_tournament_final_table_deal')
      ).toBe(0);
    });

    it('ships a reviewed rollback that restores every live body byte for byte', () => {
      expect(HEADER).toContain(
        'docs/changelog/2026-09-11-a-bust-is-ranked-by-when-it-happened.rollback.sql'
      );
      expect(ROLLBACK.match(/^BEGIN;$/gm) ?? []).toHaveLength(1);
      expect(ROLLBACK.match(/^COMMIT;$/gm) ?? []).toHaveLength(1);
      expect(ROLLBACK).toMatch(/^SET LOCAL lock_timeout = '5s';$/m);
      expect(count(ROLLBACK, 'CREATE OR REPLACE FUNCTION')).toBe(Object.keys(REPLACED).length);
      for (const name of Object.keys(REPLACED)) {
        expect(fnIn(ROLLBACK, name), `${name} is its captured live body`).toBe(
          fnIn(INSTALLED, name)
        );
      }
      // the preflight accepts the migration's result or its own; the postflight only the live body
      const pre = ROLLBACK.slice(
        ROLLBACK.indexOf('$preflight$'),
        ROLLBACK.lastIndexOf('$preflight$')
      );
      const post = ROLLBACK.slice(
        ROLLBACK.indexOf('$postflight$'),
        ROLLBACK.lastIndexOf('$postflight$')
      );
      const migPost = SQL.slice(SQL.indexOf('$postflight$'), SQL.lastIndexOf('$postflight$'));
      for (const [name, md5] of Object.entries(REPLACED)) {
        expect(pre).toContain(`'${md5}'`);
        expect(post).toContain(`'${md5}'`);
        const mine = new RegExp(
          `public\\.${name}\\([^']*'\\)\\n\\s+AND md5\\(p\\.prosrc\\) IN \\('([0-9a-f]{32})'\\)`
        ).exec(migPost);
        expect(mine, `${name} has a postflight md5`).not.toBeNull();
        expect(pre, `${name}: the rollback accepts what the migration leaves`).toContain(
          `'${mine![1]}'`
        );
        expect(post).not.toContain(`'${mine![1]}'`);
      }
      // it writes no data either
      const outside = ROLLBACK.replace(/\$function\$[\s\S]*?\$function\$/g, '')
        .replace(/\$preflight\$[\s\S]*?\$preflight\$/g, '')
        .replace(/\$postflight\$[\s\S]*?\$postflight\$/g, '');
      expect(code(outside)).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE)\b/i
      );
      // and the PostgreSQL 17 probe applies it twice and re-applies the migration
      const probe = readFileSync(PROBE, 'utf8');
      expect(probe.match(/psql_db fx_rolled -f "\$rollback"/g) ?? []).toHaveLength(2);
      expect(probe).toContain('psql_db fx_rolled -f "$root/manifest-check.sql"');
      expect(probe).toContain('psql_db fx_rolled -f "$migration"');
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
      expect(scenarios.length).toBeGreaterThanOrEqual(27);
      for (const s of scenarios) {
        expect(readFileSync(join(FIXTURE, 'scenarios', s), 'utf8'), s).toMatch(
          /^-- (FIXED|KEPT)\./
        );
      }
      // the finish, both doors and the alarm are exercised on their live bodies
      const all = scenarios
        .map((s) => readFileSync(join(FIXTURE, 'scenarios', s), 'utf8'))
        .join('\n');
      expect(all).toContain('probe.settle(');
      expect(all).toContain('probe.claim(');
      expect(all).toContain('fn_ca_tournament_finished_but_not_completed(');
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
