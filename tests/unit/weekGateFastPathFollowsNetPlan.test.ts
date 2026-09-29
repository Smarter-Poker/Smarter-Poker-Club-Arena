import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Since 20260925205938 fn_accounting_tournament_week_quality proves an event with
// no refund reversal in one set pass, reproducing what
// fn_accounting_tournament_fee_net_plan would return for it, and does not call
// net_plan. That is only correct while net_plan says what it said when the
// equivalence was proven (the migration pins its md5(prosrc) before it installs
// anything). A later migration that changes net_plan without re-deriving the
// gate's set pass would leave the two disagreeing with nothing to say so.
// So: any migration after it that redefines net_plan must redefine the gate too.

const REWRITE = '20260925205938';
const NET_PLAN = /FUNCTION\s+public\.fn_accounting_tournament_fee_net_plan\s*\(/i;
const GATE = /FUNCTION\s+public\.fn_accounting_tournament_week_quality\s*\(/i;

describe('the weekly tournament gate fast path follows net_plan', () => {
  it('the rewrite pins net_plan before installing the fast path', () => {
    const file = readdirSync('supabase/migrations').find((f) => f.startsWith(REWRITE + '_'));
    expect(file).toBeDefined();
    const sql = readFileSync(join('supabase/migrations', file as string), 'utf8');
    expect(sql).toContain("('public.fn_accounting_tournament_fee_net_plan(uuid)',");
    expect(sql).toContain('086848bc23bc2a8f89da6732d2da80c1');
    expect(sql).toMatch(GATE);
  });

  it('no later migration changes net_plan without re-deriving the gate', () => {
    const later = readdirSync('supabase/migrations')
      .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f) && f.slice(0, 14) > REWRITE)
      .filter((f) => NET_PLAN.test(readFileSync(join('supabase/migrations', f), 'utf8')));
    const orphaned = later.filter(
      (f) => !GATE.test(readFileSync(join('supabase/migrations', f), 'utf8'))
    );
    expect(
      orphaned,
      `these change fn_accounting_tournament_fee_net_plan but not the week gate's set pass: ${orphaned.join(', ')}`
    ).toEqual([]);
  });
});
