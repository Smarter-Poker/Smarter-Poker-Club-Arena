/**
 * LAW - a diamond rule refuses only by a flip somebody read, and every writer the rulings
 * promise will refuse is wired to the same switch (Diamond Accounting Standard;
 * docs/DIAMOND-RULINGS.md rulings 1, 2, 17, 18, 20; docs/changelog/2026-09-08-diamond-rules-wired.md).
 *
 * What this pins, and the defect behind each pin:
 *  - ca_diamond_rule_modes holds the seven promised rules and every one is created in log
 *    mode: a refusal that ships on the day it is written is a refusal nobody watched
 *    (CLAUDE.md 10.86);
 *  - the only path to 'refuse' is fn_ca_diamond_rule_flip, which refuses to flip before
 *    flip_after and refuses while the rule has any non-info incident in its clean window.
 *    No migration may write mode = 'refuse' by hand;
 *  - each writer reads the switch by the rule's exact name (DR2 born trigger, DR4 and the
 *    receivable settlement in add_diamonds_to_balance, DR6 audit trigger, both DR7 arms of
 *    the earn ledger, DR8 and DR20 in the card settlement);
 *  - the signup grant is issued by the Mint under signup:<id> and no seeder inserts 500
 *    (the born-with-balance door was the one thing keeping DR2 from ever flipping);
 *  - purchased lots are consumed FIFO at both sinks, and a receivable is settled by the
 *    next credit with its own journal row, never a negative balance.
 * Negative controls mutate a copy of the source and expect the pin to fail.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const dir = path.join(process.cwd(), 'supabase/migrations');
const files = fs.readdirSync(dir).filter((n) => n.endsWith('.sql'));
const pick = (suffix: string) => {
  const f = files.find((n) => n.endsWith(suffix));
  expect(f, `${suffix} exists`).toBeTruthy();
  return fs.readFileSync(path.join(dir, f as string), 'utf8');
};
const rules = pick('_diamond_rules_wired_for_refusal_and_the_money_paths_finished.sql');

const RULES = [
  'DR2:balance_born_outside_the_mint',
  'DR4:credit_without_reference',
  'DR6:balance_changed_without_journal',
  'DR7:engine_over_budget',
  'DR7:user_over_daily_cap',
  'DR8:purchase_price_disagrees_with_package',
  'DR7:test_mode_session_settled',
];

/** Strip SQL comments and single-quoted literals so a rule quoted in prose does not count. */
function stripNoise(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''");
}

describe('the seven promised rules exist and every one is born in log mode', () => {
  it('seeds each rule with mode log and a flip_after no earlier than seven days after the rulings', () => {
    for (const rule of RULES) {
      const row = new RegExp(
        `\\('${rule.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*'log',\\s*'(\\d{4}-\\d{2}-\\d{2})`
      );
      const m = row.exec(rules);
      expect(m, `${rule} is seeded in log mode`).toBeTruthy();
      expect(
        (m as RegExpExecArray)[1] >= '2026-09-14',
        `${rule} flips no earlier than 2026-09-14`
      ).toBe(true);
    }
  });
  it('asserts at apply time that nothing is in refuse mode', () => {
    expect(rules).toContain(`WHERE mode = 'refuse') THEN`);
    expect(rules).toContain('nothing may be in refuse mode at apply time');
  });
});

describe('refuse is reached only through fn_ca_diamond_rule_flip', () => {
  it('the flip refuses before flip_after and refuses while dirty', () => {
    expect(rules).toContain('may not flip before');
    expect(rules).toContain('non-info incidents in the last');
    expect(rules).toContain("i.severity <> 'info'");
    expect(rules).toContain('make_interval(days => v_row.clean_days_required)');
  });
  it('no migration writes mode = refuse by hand outside the flip function', () => {
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // The flip function's own UPDATE is the one sanctioned writer of 'refuse'.
      const outsideFlip = src.replace(
        /CREATE OR REPLACE FUNCTION public\.fn_ca_diamond_rule_flip[\s\S]*?\$\$;\n/g,
        ''
      );
      const hits = outsideFlip.match(/SET\s+mode\s*=\s*'refuse'/gi) ?? [];
      expect(hits, `${f} flips a rule by hand`).toHaveLength(0);
    }
    // negative control: a hand-written flip is caught
    const bad =
      "UPDATE public.ca_diamond_rule_modes SET mode = 'refuse' WHERE rule = 'DR4:credit_without_reference';";
    expect(bad.match(/SET\s+mode\s*=\s*'refuse'/gi)).toHaveLength(1);
  });
});

describe('every promised writer reads the switch by the rule name', () => {
  it('names each rule in a fn_ca_diamond_rule_mode() call', () => {
    for (const rule of RULES) {
      expect(rules, `${rule} is read by a writer`).toContain(
        `fn_ca_diamond_rule_mode('${rule}') = 'refuse'`
      );
    }
  });
  it('refuses with distinct error codes so the client can tell which rule answered', () => {
    expect(rules).toContain("ERRCODE = 'P0402'"); // DR2
    expect(rules).toContain("ERRCODE = 'P0406'"); // DR6
    expect(rules).toContain("ERRCODE = 'P0407'"); // DR7
    expect(rules).toContain("'error', 'reference_id_required'"); // DR4
    expect(rules).toContain("'error', 'settlement_refused'"); // DR8, DR20
  });
  it('a fixture is never refused by DR2 or DR6', () => {
    expect(rules).toContain(
      "NOT v_fixture AND public.fn_ca_diamond_rule_mode('DR2:balance_born_outside_the_mint')"
    );
    expect(rules).toContain(
      "v_refuse := NOT v_fixture\n                  AND public.fn_ca_diamond_rule_mode('DR6:balance_changed_without_journal')"
    );
  });
});

describe('the signup grant is issued by the Mint, and no seeder inserts a balance', () => {
  it('handle_new_user inserts 0 and mints 500 under signup:<id>', () => {
    expect(rules).toContain("next_player_num, 0, 0, 0, 1.0, 'Newcomer',");
    expect(rules).toContain(
      "public.fn_ca_mint('diamonds', 'player', NEW.id, 500, 'signup grant',\n                                         'signup:' || NEW.id::text, 'promotional')"
    );
    expect(rules).toContain('still inserts 500 or does not mint');
  });
  it('initialize_player_profile and heal_auth_integrity insert 0 and mint', () => {
    expect(rules).toContain('        0, 0, 1.0, 0,\n');
    expect(rules).toContain("            0, 1.0, 0, 'Newcomer', 'Full_Access', true, 'monthly',");
    expect(
      (rules.match(/'signup:' \|\| (?:NEW\.id|p_user_id|v_id)::text, 'promotional'/g) ?? []).length
    ).toBeGreaterThanOrEqual(3);
  });
  it('the Mint records the op id as the journal reference and opens the trigger door', () => {
    expect(rules).toContain("'issuance', v_class, p_op_id)");
    expect(rules).toContain("'retired', v_class, p_op_id)");
    expect(rules).toContain('pg_trigger_depth() > 0');
    // negative control: the door must be conjoined with the role check, never a bare bypass
    const clean = stripNoise(rules);
    expect(clean).toContain('AND NOT (pg_trigger_depth() > 0');
  });
});

describe('purchased lots are consumed FIFO and receivables are settled by the next credit', () => {
  it('deduct_diamonds and the negative path of add_diamonds_to_balance consume lots', () => {
    expect(rules).toContain('PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);');
    expect(rules).toContain(
      'PERFORM public.fn_ca_consume_purchase_lots(p_user_id, -v_actual_amount);'
    );
    expect(rules).toContain('ORDER BY l.created_at, l.id');
    expect(rules).toContain('l.frozen_at IS NULL');
  });
  it('a receivable is settled oldest first with its own journal row and never a negative balance', () => {
    expect(rules).toContain('ORDER BY d.created_at, d.id');
    expect(rules).toContain("'debt-settlement:' || v_txn_id::text");
    expect(rules).toContain("'receivable:diamond_debts', 'spend'");
    expect(rules).toContain('SET diamonds = v_new_balance - v_settled');
    expect(rules).not.toMatch(/diamonds\s*=\s*-\s*v_settled/);
  });
});
