/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - THE CHIP ESTATE TAKES ITS LOCKS IN ONE ORDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Production logged 3,605 deadlocks in the 24 hours to 2026-09-30 23:16 UTC.
 * Ranked by what the victim waited for: the commission rollups (cash accrual
 * batch x tournament finish), player_stats (the batch x the hand projection -
 * PR #5542's pair), VIP carry / club wallet / day rake (finish x raked hand),
 * profiles (finish x horse claims, through the player_stats trigger) and the
 * horse-mind flushes. Migration 20261001000000 gives every pair but PR #5542's
 * one order (docs/evidence/chip-deadlocks-2026-10-01.md):
 *
 *   atomic_distribute_rake             the club wallet before the rake record
 *   trg_agent_commission_rollup_insert the club's commission key, in club order,
 *                                      before its rollup rows
 *   fn_credit_agent_commissions_batch, every club's commission key before the
 *   fn_retry_cash_accounting_sources   first item, in club order
 *   fn_sync_profile_total_hands        no profile rewrite when hands_played
 *                                      did not move
 *   upsert_horse_mind_*                rows in key order, repeats in input order
 *
 * scripts/qualification/chip-deadlocks.py reproduces each pair on an isolated
 * cluster with production's bodies (md5-pinned): every one deadlocks before and
 * none after the migration's own substitution block runs. The law pins the
 * asserted substitutions, the order each one establishes, that each only adds
 * (every statement of the old clause survives), the live proofs, the estate
 * checks, and that the harness measures the migration's text and no copy of it.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_the_chip_estate_takes_its_locks_in_one_order.sql'))
  .at(-1);
if (!NAME) throw new Error('the chip lock-order migration is missing');
const MIG = migrationText(NAME);
const REVERT_NAME = migrationNames()
  .filter((n) => n.endsWith('_a_raked_hand_takes_its_club_wallet_where_it_did.sql'))
  .at(-1);
if (!REVERT_NAME) throw new Error('the raked-hand wallet revert is missing');
const REVERT = migrationText(REVERT_NAME);
const QUAL = resolve(__dirname, '..', 'scripts', 'qualification');
const HARNESS = readFileSync(resolve(QUAL, 'chip-deadlocks.py'), 'utf8');
const MANIFEST = JSON.parse(
  readFileSync(resolve(QUAL, 'chip-deadlocks.manifest.json'), 'utf8')
) as {
  functions: Record<string, string>;
};
const SUBS = sliceBetween(MIG, 'DO $subs$', 'END $subs$;');
const FINAL = sliceBetween(MIG, '-- THE ESTATE IS AS IT WAS', 'RAISE NOTICE');

const PINS: Array<[string, string, string]> = [
  [
    'atomic_distribute_rake(uuid,uuid,uuid,integer,numeric,numeric,numeric,integer,jsonb,uuid,jsonb,text)',
    '0ef820b10c57d902b5ab2d5f9e2be8a6',
    'ea7a4a403969a0fbe69f2216d63a0436',
  ],
  [
    'trg_agent_commission_rollup_insert()',
    '50cb43eb54b7924b39c25b9816f450a0',
    'c7e84377219a39d955783d0feae6642b',
  ],
  [
    'fn_credit_agent_commissions_batch(jsonb)',
    '3b9313fc37e62ca2c0b0bbbc7fdc6dc0',
    '5ebf5489eabbe478d393e2e040683fe8',
  ],
  [
    'fn_retry_cash_accounting_sources(integer)',
    'cf43f5cc8e7d47994025cc7682cc18bc',
    '4b62b13c70191e56fe55644070303a97',
  ],
  [
    'fn_sync_profile_total_hands()',
    '918a9211cf484127ab5d326aea1e47b3',
    'f6ee538e4bcfc329dd0e46673b05dc30',
  ],
  [
    'upsert_horse_mind_pairs(jsonb)',
    'c73cb456bd033f8d3f5a03e53b9934b0',
    '389109138a65a4d150b48da5ffa209bb',
  ],
  [
    'upsert_horse_mind_stats(jsonb)',
    '84df6d650c905cedba86f2698f1fbd3d',
    '6802f13c3b1e7b94e62694d1dc1e5fb1',
  ],
  [
    'upsert_horse_mind_stats_scoped(jsonb)',
    '73884faf30f48913dba34053fdd33337',
    '199192476497889e659b8455c38ea631',
  ],
];

/** The old and new text of one substitution, decoded from its E'' pieces. */
const clause = (signature: string): { oldText: string; newText: string } => {
  const head = `    ('${signature}', '`;
  const at = SUBS.indexOf(head);
  if (at < 0) throw new Error(`no substitution for ${signature}`);
  const entry = SUBS.slice(at, SUBS.indexOf("\\n')", at) + 4);
  const groups: string[][] = [[]];
  for (const m of entry.matchAll(/E'((?:[^']|'')*)'(\n|,|\))/g)) {
    groups[groups.length - 1].push(m[1].replace(/''/g, "'").replace(/\\n/g, '\n'));
    if (m[2] !== '\n') groups.push([]);
  }
  return { oldText: groups[0].join(''), newText: groups[1].join('') };
};
const statements = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) => l && !l.startsWith('--') && !l.startsWith('/*') && !/^[A-Za-z' ,.()-]*\*\/$/.test(l)
    );
const before = (text: string, a: string, b: string) => {
  expect(text).toContain(a);
  expect(text).toContain(b);
  expect(text.indexOf(a)).toBeLessThan(text.indexOf(b));
};
const KEY = "pg_advisory_xact_lock(hashtextextended('agent-commission:'||";

describe('LAW: the chip estate takes its locks in one order', () => {
  it('changes eight bodies only by asserted substitution over the pinned live text', () => {
    expect(MIG).toContain("SET LOCAL lock_timeout = '2s';");
    expect(SUBS).toContain('IF md5(v_def) <> s.before_md5 THEN');
    expect(SUBS).toContain('IF v_n <> 1 THEN');
    expect(SUBS).toContain('EXECUTE replace(v_def, s.old_text, s.new_text);');
    expect(SUBS).toContain('IF md5(v_after) <> s.after_md5 THEN');
    expect(SUBS).toContain('IF md5(replace(v_after, s.new_text, s.old_text)) <> s.before_md5 THEN');
    expect(SUBS).toContain("RAISE EXCEPTION '%: owner, security or grants moved', s.signature;");
    for (const [signature, pinned, measured] of PINS) {
      expect(SUBS).toContain(`    ('${signature}', '${pinned}', '${measured}',`);
      const proname = signature.slice(0, signature.indexOf('('));
      expect(MIG).toContain(
        `-- @live-proof: (SELECT md5(pg_get_functiondef(p.oid)) = '${measured}' FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = '${proname}')`
      );
    }
    expect([...MIG.matchAll(/^-- @live-proof: /gm)]).toHaveLength(PINS.length);
  });

  it('the lock moves only add: every statement of each old clause survives, in order', () => {
    const declares = (l: string) => l.startsWith('DECLARE');
    const inOrder = (needle: string[], hay: string[]) => {
      let i = 0;
      for (const l of hay) if (i < needle.length && l === needle[i]) i++;
      return i === needle.length;
    };
    for (const [signature] of PINS.slice(0, 5)) {
      const { oldText, newText } = clause(signature);
      const was = statements(oldText);
      const is = statements(newText);
      expect(
        inOrder(
          was.filter((l) => !declares(l)),
          is.filter((l) => !declares(l))
        )
      ).toBe(true);
      // A declaration only gains a variable: the old line is a prefix of the new one.
      for (const d of was.filter(declares)) {
        expect(is.some((l) => declares(l) && l.startsWith(d))).toBe(true);
      }
    }
  });

  it("20261001000000 moved a raked hand's club wallet before the rake record", () => {
    const { oldText, newText } = clause(PINS[0][0]);
    const wallet =
      'PERFORM 1 FROM public.club_wallets WHERE club_id = p_club_id FOR NO KEY UPDATE;';
    expect(oldText).not.toContain(wallet);
    before(newText, 'fn_lock_cash_bank_accounting_week(', wallet);
    before(newText, wallet, 'INSERT INTO public.rake_records (');
  });

  it('20261001000500 puts it back, byte for byte: a finish must not queue behind raked hands', () => {
    const decode = (name: 'v_old' | 'v_new') =>
      [...sliceBetween(REVERT, `  ${name} := `, ';\n').matchAll(/E'((?:[^']|'')*)'/g)]
        .map((m) => m[1].replace(/''/g, "'").replace(/\\n/g, '\n'))
        .join('');
    const { oldText, newText } = clause(PINS[0][0]);
    expect(decode('v_old')).toBe(newText);
    expect(decode('v_new')).toBe(oldText);
    expect(REVERT).toContain("IF md5(v_def) <> 'ea7a4a403969a0fbe69f2216d63a0436' THEN");
    expect(REVERT).toContain("IF md5(v_after) <> '0ef820b10c57d902b5ab2d5f9e2be8a6' THEN");
    expect(REVERT).toContain(
      "IF md5(replace(v_after, v_new, v_old)) <> 'ea7a4a403969a0fbe69f2216d63a0436' THEN"
    );
    expect(REVERT).toContain('IF v_n <> 1 THEN');
    expect(REVERT).toMatch(
      /^-- @live-proof: \(SELECT md5\(pg_get_functiondef\(p\.oid\)\) = '0ef820b10c57d902b5ab2d5f9e2be8a6'/m
    );
    expect(REVERT).toContain('two hit their 45 s statement timeout');
    expect(HARNESS).toContain(
      "REVERT = ROOT / 'supabase/migrations/20261001000500_a_raked_hand_takes_its_club_wallet_where_it_did.sql'"
    );
    expect(HARNESS).toContain(
      "NOT_FIXED = ('finish-vs-raked-hand', 'finish-vs-two-raked-hands', 'pr5542-player-stats-across-hands')"
    );
    expect(REVERT.replace(/--[^\n]*/g, ' ')).not.toMatch(/\bGRANT\b/i);
  });

  it('every commission writer takes the club key in club order before the rollup rows', () => {
    const trigger = clause(PINS[1][0]).newText;
    before(trigger, KEY, 'INSERT INTO public.agent_commission_unsettled_rollup AS r');
    expect(trigger).toContain(
      'FROM new_rows n WHERE n.club_id IS NOT NULL ORDER BY n.club_id LOOP'
    );
    const batch = clause(PINS[2][0]).newText;
    before(batch, KEY, 'FOR it IN SELECT value FROM jsonb_array_elements(p_items) LOOP');
    expect(batch).toContain('AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP');
    expect(batch).toContain('WHERE a.rake_record_id = ANY (ARRAY(');
    const retry = clause(PINS[3][0]).newText;
    expect(retry).toContain(KEY);
    expect(retry).toContain('AND a.club_id IS NOT NULL ORDER BY a.club_id LOOP');
    expect(retry).toContain('ORDER BY s.next_attempt_at,s.rake_record_id LIMIT p_limit');
  });

  it('a stats write that leaves hands_played alone leaves the profile alone', () => {
    const { newText } = clause(PINS[4][0]);
    expect(newText).toContain(
      "IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id"
    );
    expect(newText).toContain('AND NEW.hands_played IS NOT DISTINCT FROM OLD.hands_played THEN');
  });

  it('the horse-mind flushes take their rows in key order, repeats in input order', () => {
    expect(clause(PINS[5][0]).newText).toContain(
      "ORDER BY e.value->>'attacker_id', e.value->>'victim_id', e.ord LOOP"
    );
    expect(clause(PINS[6][0]).newText).toContain("ORDER BY e.value->>'user_id', e.ord LOOP");
    expect(clause(PINS[7][0]).newText).toContain(
      "order by e.value->>'user_id', e.value->>'scope', e.ord loop"
    );
    // Same rows, same loop body: only the order the input array is walked in changes.
    for (const [signature] of PINS.slice(5)) {
      const { oldText, newText } = clause(signature);
      expect(oldText.toLowerCase().trim()).toBe(
        'for r in select * from jsonb_array_elements(rows) loop'
      );
      expect(newText.toLowerCase()).toContain(
        'select e.value from jsonb_array_elements(rows) with ordinality as e(value, ord)'
      );
      expect(newText.toLowerCase().trimEnd().endsWith('e.ord loop')).toBe(true);
    }
  });

  it('measured the text it ships: the harness executes this file and pins the same bodies', () => {
    expect(HARNESS).toContain(
      "MIGRATION = ROOT / 'supabase/migrations/20261001000000_the_chip_estate_takes_its_locks_in_one_order.sql'"
    );
    expect(HARNESS).toContain(
      "re.search(r'^DO \\$subs\\$\\n.*?^END \\$subs\\$;\\n', text, re.S | re.M)"
    );
    for (const [signature, pinned] of PINS) {
      expect(MANIFEST.functions[signature.slice(0, signature.indexOf('('))]).toBe(pinned);
    }
    expect(HARNESS).toContain('def case_pr5542(');
    expect(HARNESS).toContain('REFUSED: loaded bodies are not production');
  });

  it('leaves the estate as it was', () => {
    expect(FINAL).toContain(
      "has_function_privilege('authenticated', 'public.' || v_sig, 'EXECUTE')"
    );
    expect(FINAL).toContain(
      "NOT has_function_privilege('service_role', 'public.' || v_sig, 'EXECUTE')"
    );
    expect(FINAL).toContain('fn_ca_settlement_lane_doctrine()');
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(FINAL).toContain('fn_ca_diamond_register_vs_supply()');
    expect(FINAL).toContain('watched guards off their baseline');
    const code = MIG.replace(/--[^\n]*/g, ' ');
    expect(code).not.toMatch(/\bGRANT\b/i);
    expect(code).not.toMatch(/SET\s+(?:cash_games_enabled|tournaments_enabled)\s*=\s*true/i);
  });
});
