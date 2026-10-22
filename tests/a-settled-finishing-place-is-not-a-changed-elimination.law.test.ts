/**
 * LAW: A SETTLED FINISHING PLACE IS NOT A CHANGED ELIMINATION (2026-10-22).
 *
 * Prime Time Free Buy table 38 (3c76327d) was refused re-admission for 35
 * minutes, F06_MOVEMENT_ELIMINATION_CHANGED, because a busted player's place
 * was settled from 307 to 309 after the table's movement proof was taken.
 *
 * What this pins: an eliminated player's position, prize and
 * terminal_closed_at are ignored like the bounty fields; everything else
 * about the bust, and every living player, is still compared exactly.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIG = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20261022032302_a_settled_finishing_place_is_not_a_changed_elimination.sql'
  ),
  'utf8'
);

describe('a settled finishing place is not a changed elimination', () => {
  it('is one guarded transaction', () => {
    expect(MIG.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(MIG.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(MIG).toContain('SETTLED_PLACE_PREIMAGE_CHANGED');
    expect(MIG).toContain('SETTLED_PLACE_RESULT_CHANGED');
  });

  it('ignores only the settled ranking of an eliminated player', () => {
    const elim = MIG.slice(MIG.indexOf("jsonb_array_elements(a.proof->'eliminated')"));
    expect(elim).toContain(
      "'{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value,position,prize,terminal_closed_at}'::text[]"
    );
    expect(elim).toContain("RAISE EXCEPTION 'F06_MOVEMENT_ELIMINATION_CHANGED'");
  });

  it('still compares every living player exactly as before', () => {
    expect(MIG).toContain(
      "strip text[]:='{current_bounty,bounty_winnings,bounties_collected,mystery_bounty_value}';"
    );
    expect(MIG).toContain("RAISE EXCEPTION 'F06_MOVEMENT_ROSTER_CHANGED'");
    expect(MIG).toContain("RAISE EXCEPTION 'F06_MOVEMENT_WHOLE_ROSTER_REQUIRED'");
  });
});
