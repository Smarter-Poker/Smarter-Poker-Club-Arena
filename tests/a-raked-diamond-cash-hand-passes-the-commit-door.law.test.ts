/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW - A RAKED DIAMOND CASH HAND PASSES THE COMMIT DOOR (2026-10-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 12-argument door fn_ca_commit_hand_settlement had two rules that
 * contradicted each other for every raked Diamond cash hand:
 *
 *   - its Diamond refusal requires a Diamond cash hand's chip rake object
 *     (p_post_commit_obligations->'rake') to be null, because that object
 *     drives the CHIP rake leg a Diamond must never reach;
 *   - its fee binding required (p_rake > 0) to equal "a chip rake object is
 *     present".
 *
 * Since the engine prices a Diamond hand by the owner's settings (#6288),
 * every Diamond hand reaching a flop with a rakeable pot has p_rake > 0, so
 * the door refused it as post_commit_fee_mismatch after the hand had been
 * played. Proved on production in a rolled-back rehearsal with the engine's
 * own request (pot 400, rake 15) before the Diamond cash switch reopened.
 *
 * Migration 20261006154344 scopes the seven chip-rake clauses to chip hands
 * (NOT v_diamond) and states the Diamond rule - the null chip object - in the
 * same check. A Diamond hand's rake is bound where it is settled:
 * fn_poker_diamond_settle_cash_hand recomputes it from the owner's settings,
 * refuses any other number, and accrues it per payer in the same transaction.
 *
 * This pins all three halves: the chip binding is byte-for-byte what it was,
 * a Diamond hand still cannot carry a chip rake object, and the settler the
 * Diamond rake now relies on still recomputes and accrues it.
 */
import { describe, expect, it } from 'vitest';
import { migrationNames, migrationText } from './helpers/migrationCorpus';

const FIX = '20261006154344_a_raked_diamond_cash_hand_passes_the_commit_door.sql';
const DOOR =
  'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)';
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The body of the newest migration that CREATEs public.<fn> in full. */
function latestDeclaring(fn: string): { name: string; body: string } {
  const declares = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\s*\\(`,
    'g'
  );
  for (const name of [...migrationNames()].reverse()) {
    const sql = migrationText(name);
    const starts = [...sql.matchAll(declares)].map((m) => m.index ?? -1);
    if (starts.length === 0) continue;
    const at = starts[starts.length - 1];
    const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(sql.slice(at));
    if (!tag) throw new Error(`${fn} in ${name} has no dollar-quoted body`);
    const open = at + tag.index + tag[0].length;
    const close = sql.indexOf(tag[1], open);
    if (close < 0) throw new Error(`${fn} in ${name} has no closing ${tag[1]}`);
    return { name, body: sql.slice(open, close) };
  }
  throw new Error(`no migration declares public.${fn}`);
}

describe('LAW: a raked Diamond cash hand passes the commit door', () => {
  const sql = migrationText(FIX);
  const olds = [...sql.matchAll(/\$o\$([\s\S]*?)\$o\$/g)].map((m) => m[1]);
  const news = [...sql.matchAll(/\$n\$([\s\S]*?)\$n\$/g)].map((m) => m[1]);

  it('edits the commit door alone, at two pinned anchors, and moves no switch', () => {
    const calls = [
      ...sql.matchAll(
        /SELECT pg_temp\.ca_audit_subst\(\s*'([^']+)',\s*'([0-9a-f]{32})', '([0-9a-f]{32})'/g
      ),
    ];
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe(DOOR);
    expect(calls[0][2]).not.toBe(calls[0][3]);
    expect(olds).toHaveLength(2);
    expect(news).toHaveLength(2);
    // Nothing here opens or closes the arena: that is a person's own migration.
    expect(sql).not.toMatch(/\bupdate\s+(?:public\.)?ca_arena_settings\b/i);
  });

  it('binds a chip hand’s rake exactly as before, now only for a chip hand', () => {
    // Anchor 1: the old opening of the fee binding survives verbatim, guarded.
    expect(olds[0].startsWith('  IF (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM\n')).toBe(true);
    expect(news[0]).toBe('  IF (NOT v_diamond AND (\n       ' + olds[0].slice('  IF '.length));
    // Anchor 2: the last chip-rake clause closes the guard; the BBJ binding
    // that follows is untouched and still binds every hand.
    const lastRakeLine =
      "             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'\n";
    const bbjLine = '     OR (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM\n';
    expect(olds[1]).toBe(lastRakeLine + '     )\n' + bbjLine);
    expect(news[1].startsWith(lastRakeLine + '     )))\n')).toBe(true);
    expect(news[1].endsWith(bbjLine)).toBe(true);
    // The chip binding text the fee-door law reads is still whole.
    expect(flat(news[0])).toContain(
      "(COALESCE(p_rake, 0) > 0) IS DISTINCT FROM (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')"
    );
  });

  it('still refuses a Diamond hand that carries a chip rake object', () => {
    expect(flat(news[1])).toContain(
      "OR (v_diamond AND jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null')"
    );
    const door = latestDeclaring('fn_ca_commit_hand_settlement');
    const code = flat(door.body);
    // v_diamond is a Diamond CASH table: asset diamonds and no tournament.
    expect(code).toContain(
      "WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond"
    );
    // The door's own Diamond refusal keeps the chip rake object null.
    const refusal = code.slice(code.indexOf('IF v_diamond AND ('));
    expect(refusal.slice(0, refusal.indexOf('END IF'))).toContain(
      "jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'"
    );
    expect(refusal.slice(0, refusal.indexOf('END IF'))).toContain(
      'diamond_chip_obligation_or_fractional_fact'
    );
  });

  it('leaves the Diamond rake to the settler that recomputes it and accrues it', () => {
    const settler = flat(latestDeclaring('fn_poker_diamond_settle_cash_hand').body);
    // Refuses a hand without its facts, and any rake that is not the settings' number.
    expect(settler).toContain('diamond_cash_rake_facts_required');
    expect(settler).toContain('diamond_cash_rake_disagrees');
    // Conservation: the stacks are short by exactly the rake.
    expect(settler).toContain('<> -(v_rake + COALESCE(p_bbj,0))');
    // Accrued per payer, in the same transaction, and proved to sum.
    expect(settler).toContain('INSERT INTO public.ca_diamond_rake_accrual');
    expect(settler).toContain('diamond_cash_rake_attribution_does_not_sum');
  });
});
