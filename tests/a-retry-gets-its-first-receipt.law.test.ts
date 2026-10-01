/**
 * ═══════════════════════════════════════════════════════════
 *  LAW - A RETRY GETS ITS FIRST RECEIPT
 * ═══════════════════════════════════════════════════════════
 *
 * Phase 11 of the Diamond Arena programme, line 2 (concurrency, duplicate
 * delivery and crash recovery). Decided by Claude on Dan's delegation of
 * 2026-09-30 (docs/DIAMOND-RULINGS.md): every Diamond money door answers a
 * retry of the same request with its first receipt, word for word, with no
 * replay marker; and a retry that reuses a key with different parameters is
 * refused by name at every door, the prize payer included.
 *
 * 20260930235000 redefines three Diamond doors from production's own text -
 * the store (fn_purchase_feature_v2), the withdrawal
 * (fn_poker_diamond_tournament_unregister) and the prize payer
 * (fn_poker_diamond_tournament_pay) - and edits the payer's one caller,
 * fn_credit_and_log, by asserted substitution, so that it still answers true
 * for the call that paid and false for a verified retry. This pins each door's
 * retry answer, the payer's refusal, the key the payer names and
 * fn_credit_and_log reads, the kept grants, the closing assertions, and the
 * concurrency suite's replay rules that prove it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';
import { sliceBetween } from './helpers/sourceWindow';

const NAME = migrationNames()
  .filter((n) => n.endsWith('_a_retry_gets_its_first_receipt.sql'))
  .at(-1);
if (!NAME) throw new Error('the a-retry-gets-its-first-receipt migration is missing');
const MIG = migrationText(NAME);
const RUNNER = readFileSync(join(__dirname, 'sql', 'run-diamond-concurrency.py'), 'utf8');

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
const STORE = sliceBetween(MIG, '-- 1. THE STORE ANSWERS A RETRY', '-- 2. A WITHDRAWAL');
const WITHDRAWAL = sliceBetween(MIG, '-- 2. A WITHDRAWAL ANSWERS A RETRY', '-- 3. THE PRIZE PAYER');
const PAYER = sliceBetween(MIG, '-- 3. THE PRIZE PAYER ANSWERS A RETRY', '-- 4. THE CREDIT DOOR');
const CREDIT = sliceBetween(
  MIG,
  '-- 4. THE CREDIT DOOR STILL TELLS',
  '-- 5. THE ESTATE IS AS IT WAS'
);
const FINAL = sliceBetween(MIG, '-- 5. THE ESTATE IS AS IT WAS', 'COMMIT;');
const between = (src: string, from: string, to: string) =>
  sliceBetween(src, from, to).slice(from.length);
const OLD = between(CREDIT, 'v_old CONSTANT text := $old$', '$old$;');
const NEW = between(CREDIT, 'v_new CONSTANT text := $new$', '$new$;');
const PAY = 'public.fn_poker_diamond_tournament_pay(uuid,numeric,text,text,uuid,text)';
const UNR = 'public.fn_poker_diamond_tournament_unregister(uuid,uuid,uuid)';
const PUR = 'public.fn_purchase_feature_v2(uuid,text,uuid)';
const CAL =
  'public.fn_credit_and_log(uuid,numeric,text,text,text,uuid,text,uuid,uuid,integer,text)';

describe('LAW: a retry gets its first receipt', () => {
  it('opens nothing, creates nothing, and declares its own proof of being live', () => {
    expect(code(MIG)).not.toMatch(/(cash_games_enabled|tournaments_enabled)\s*:?=\s*true/i);
    expect(code(MIG)).not.toMatch(/CREATE\s+(TABLE|INDEX|UNIQUE|TRIGGER|POLICY|VIEW|SEQUENCE)\b/i);
    expect(code(MIG).match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(3);
    const proofs = MIG.match(/^-- @live-proof: .+$/gm) ?? [];
    expect(proofs).toHaveLength(4);
    expect(proofs.join('\n')).toContain("position('diamond_tournament_pay_key_reused' in");
    expect(proofs.join('\n')).toContain("position('app.diamond_tournament_pay_claimed' in");
    expect(proofs.join('\n')).toContain("position('v_prior_after' in");
    expect(proofs.join('\n')).toContain("position('RETURN v_cached_result;' in");
  });

  it('the store answers a retry with its stored receipt, word for word, and still refuses a reused request id', () => {
    expect(STORE).toContain("IF v_md5 <> 'f16cefd4ad43466df06c7150440c3e16' THEN");
    expect(code(STORE)).toContain('RETURN v_cached_result;');
    expect(code(STORE)).not.toContain('RETURN v_cached_result ||');
    expect(code(STORE)).toContain("'code', 'REQUEST_ID_REUSED'");
    expect(STORE).toContain(`REVOKE ALL ON FUNCTION ${PUR} FROM PUBLIC, anon;`);
    expect(STORE).toContain(`GRANT EXECUTE ON FUNCTION ${PUR} TO authenticated, service_role;`);
  });

  it('the withdrawal answers a retry with its first receipt: no marker, and the balance the refund left', () => {
    expect(WITHDRAWAL).toContain("IF v_md5 <> '39f95b499619cab7a1eb65ff583aa638' THEN");
    expect(code(WITHDRAWAL)).not.toContain("'idempotent'");
    expect(code(WITHDRAWAL)).not.toContain("'replayed'");
    expect(code(WITHDRAWAL)).not.toContain('FROM public.profiles p WHERE p.id=p_user_id');
    expect(code(WITHDRAWAL)).toContain(
      "WHERE m.request_id=p_request_id AND m.custody_id=v_prior.custody_id AND m.action='release';"
    );
    expect(code(WITHDRAWAL)).toContain("'asset','diamonds','diamonds_after',v_prior_after);");
    expect(code(WITHDRAWAL)).toContain(
      "'asset','diamonds','diamonds_after',(v_refund->>'available_balance')::bigint);"
    );
    expect(WITHDRAWAL).toContain(
      `REVOKE ALL ON FUNCTION ${UNR} FROM PUBLIC, anon, authenticated, service_role;`
    );
    expect(WITHDRAWAL).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_unregister', 'migration a_retry_gets_its_first_receipt');"
    );
  });

  it('the prize payer answers a retry true and refuses any other use of its key by name', () => {
    expect(PAYER).toContain("IF v_md5 <> 'e246c03b5a6d2aff690d227912ff7e82' THEN");
    const body = code(PAYER);
    expect(body).not.toContain('RETURN false');
    expect(body).toContain("WHERE l.idempotency_key='poker-tournament-pay:'||p_idempotency_key;");
    for (const same of [
      'v_prior.kind IS DISTINCT FROM v_kind',
      'v_prior.tournament_id IS DISTINCT FROM p_tournament_id',
      'v_prior.user_id IS DISTINCT FROM p_user_id',
      'v_prior.amount IS DISTINCT FROM p_amount',
    ]) {
      expect(body).toContain(same);
    }
    expect(body).toContain(
      "RAISE EXCEPTION 'diamond_tournament_pay_key_reused' USING ERRCODE='22023';"
    );
    // The key is named only by the call that paid: after every check, just before its answer.
    expect(body).toMatch(
      /PERFORM set_config\('app\.diamond_tournament_pay_claimed', p_idempotency_key, true\);\s+RETURN true;\s+END \$function\$;/
    );
    expect(body.match(/app\.diamond_tournament_pay_claimed/g)).toHaveLength(1);
    expect(PAYER).toContain(
      `REVOKE ALL ON FUNCTION ${PAY} FROM PUBLIC, anon, authenticated, service_role;`
    );
    expect(PAYER).toContain(
      "SELECT public.fn_ca_declare_guard_redefinition('fn_poker_diamond_tournament_pay', 'migration a_retry_gets_its_first_receipt');"
    );
  });

  it('fn_credit_and_log still tells the call that paid from its retry, edited by asserted substitution', () => {
    expect(CREDIT).toContain("IF md5(v_def) <> 'e1c4ca5fd66536cc90adc9af106e3068' THEN");
    expect(CREDIT).toContain(
      "IF md5(replace(v_after, v_new, v_old)) <> 'e1c4ca5fd66536cc90adc9af106e3068' THEN"
    );
    expect(CREDIT).toContain(
      "RAISE EXCEPTION 'the Diamond branch of fn_credit_and_log found % time(s), expected 1', v_hits;"
    );
    expect(CREDIT).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(CREDIT).toContain("RAISE EXCEPTION 'the prize payer does not name the key it paid';");
    expect(OLD).toContain('v_credited := public.fn_poker_diamond_tournament_pay(');
    expect(OLD.trim().startsWith('IF v_diamond THEN')).toBe(true);
    expect(OLD.trim().endsWith('ELSE')).toBe(true);
    const n = code(NEW).replace(/\s+/g, ' ').trim();
    expect(n).toBe(
      "IF v_diamond THEN PERFORM set_config('app.diamond_tournament_pay_claimed', '', true); " +
        'IF public.fn_poker_diamond_tournament_pay( p_user_id, p_amount, p_idempotency_key, p_category, p_related_entity_id, p_description) IS NOT TRUE THEN ' +
        "RAISE EXCEPTION 'diamond tournament payment % answered no receipt', p_idempotency_key USING ERRCODE = 'P0404'; END IF; " +
        "v_credited := current_setting('app.diamond_tournament_pay_claimed', true) IS NOT DISTINCT FROM p_idempotency_key; ELSE"
    );
  });

  it('asserts at the end that every edit landed byte for byte, the grants are kept, nothing opened, the identity is whole and every watched guard is on its baseline', () => {
    const resulting = sliceBetween(
      MIG,
      '-- RESULTING md5(pg_get_functiondef(oid))',
      '-- The migration creates no object'
    );
    for (const [name, sig] of [
      ['fn_purchase_feature_v2', PUR],
      ['fn_poker_diamond_tournament_unregister', UNR],
      ['fn_poker_diamond_tournament_pay', PAY],
      ['fn_credit_and_log', CAL],
    ]) {
      const md5 = new RegExp(`--\\s+${name}\\s+([0-9a-f]{32})`).exec(resulting)?.[1];
      expect(md5, `${name} has no resulting md5 in the header`).toBeTruthy();
      expect(FINAL).toContain(`md5(pg_get_functiondef('${sig}'::regprocedure)) <> '${md5}'`);
    }
    expect(FINAL).toContain(`IF has_function_privilege('anon', '${PUR}', 'EXECUTE')`);
    expect(FINAL).toContain("CROSS JOIN unnest(ARRAY['" + UNR);
    expect(FINAL).toContain("RAISE EXCEPTION 'a money door''s grants changed';");
    expect(FINAL).toContain('this migration must not open an arena switch');
    expect(FINAL).toContain(
      'IF (SELECT difference FROM public.fn_ca_diamond_register_vs_supply()) <> 0 THEN'
    );
    expect(FINAL).toContain("RAISE EXCEPTION 'watched guards off their baseline: %', v_bad;");
  });

  it('the concurrency suite proves it: every door but the shared rebuy core answers a retry with its first receipt after the wallet moved, and every door refuses a changed payload by name', () => {
    const rows = [
      ...RUNNER.matchAll(
        /^ {4}Replayable\('([a-z-]+)', prep_\w+, (True|False), \[([^\]]*)\]\),$/gm
      ),
    ];
    expect(rows.map((r) => r[1])).toEqual([
      'transfer',
      'purchase',
      'buy-in',
      'top-up',
      'cash-out',
      'register',
      'unregister',
      'rebuy',
      'payout',
    ]);
    for (const [, door, same, names] of rows) {
      expect(same, `${door} must answer a retry with its first receipt`).toBe(
        door === 'rebuy' ? 'False' : 'True'
      );
      expect(
        names.trim().length,
        `${door} must name its refusal of a changed payload`
      ).toBeGreaterThan(2);
    }
    expect(RUNNER).toContain(
      "Replayable('payout', prep_payout, True, ['diamond_tournament_pay_key_reused']),"
    );
    const replay = sliceBetween(
      RUNNER,
      'def replay_variant(suite, spec, variant):',
      'def run_replay(suite):'
    );
    expect(replay.indexOf('move_wallet(suite, spec, door.actor, label)')).toBeGreaterThan(0);
    expect(replay.indexOf('move_wallet(suite, spec, door.actor, label)')).toBeLessThan(
      replay.indexOf('third = suite.result(b.step(door.sql))')
    );
    expect(replay).toContain('all(r == first for r in replays)');
  });
});
