/**
 * A MYSTERY REBUY BEFORE THE MONEY HAS NO HEAD TO SETTLE (2026-10-24)
 *
 * Before a mystery-bounty event activates, the bounty claim records a bust and
 * writes no obligation: the head stays in the pool as residual. The rebuy step
 * and the rebuy door both demanded a settled obligation anyway, so no player
 * could rebuy a pre-money mystery event: eight events, 1,172 busts in the
 * rebuy window, zero rebuys (22-23 October).
 *
 * This pins that only the exact pre-money mystery answer stands in for an
 * obligation, that a live head is still refused, and that every other bounty
 * rebuy still needs its settled, marked obligation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(
    __dirname,
    '..',
    'supabase',
    'migrations',
    '20261024075911_a_mystery_rebuy_before_the_money_has_no_head_to_settle.sql'
  ),
  'utf8'
);
const code = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n');

describe('a mystery rebuy before the money has no head to settle', () => {
  it('is one transaction that requires the place fix first', () => {
    expect(code.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(code.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(code).toContain("'A BOUNTY REBUY NEVER BORROWS A HELD FINISHING PLACE'");
  });

  it('accepts only the exact pre-money mystery claim, and never with a live head', () => {
    const step = sql.slice(
      sql.indexOf('1. The bounty rebuy step'),
      sql.indexOf('2. The rebuy door')
    );
    for (const condition of [
      "COALESCE((v_claim->>'ok')::boolean,false)",
      "COALESCE((v_claim->>'claimed')::boolean,false)",
      "COALESCE(v_claim->>'obligation_id','')=''",
      "v_claim->>'mode'='mystery_pre'",
      "v_claim->>'bounty_blocked'='mystery_bounties_start_in_the_money'",
      'COALESCE(v_t.is_mystery_bounty,false)',
    ]) {
      expect(step).toContain(condition);
    }
    expect(step).toContain("'Pre-money mystery rebuy found a live bounty head'");
    // The original refusal still follows for every other shape.
    expect(step).toMatch(/\$new\$ \|\| v_old;/);
  });

  it('lets the door skip the obligation only on that exact answer', () => {
    const door = sql.slice(sql.indexOf('2. The rebuy door'));
    expect(door).toMatch(/md5\(v_src\) <> '19c487be1cc3564421751e4a6cace2a4'/);
    expect(door).toContain('v_no_bounty_head boolean:=false;');
    expect(door).toMatch(
      /v_no_bounty_head:=\s*COALESCE\(v_t\.is_mystery_bounty,false\)\s*AND COALESCE\(v_bounty_settlement->>'no_bounty_head','false'\)='true'\s*AND v_bounty_settlement->>'mode'='mystery_pre'\s*AND COALESCE\(v_bounty_settlement->>'obligation_id',''\)='';/
    );
    expect(door.match(/OR NOT v_no_bounty_head AND NOT EXISTS \(/g)?.length).toBe(2);
    expect(door).toContain('(v_bounty_obligation_id IS NULL AND NOT v_no_bounty_head)');
  });

  it('keeps both functions security definer with their grants', () => {
    expect(code).toContain("NOT has_function_privilege('anon', p.oid, 'EXECUTE')");
    expect(code).toContain("AND has_function_privilege('authenticated', p.oid, 'EXECUTE')");
    expect(code).toContain("AND has_function_privilege('service_role', p.oid, 'EXECUTE')");
  });
});
