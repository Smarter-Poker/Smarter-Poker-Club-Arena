/**
 * A CLUB BANK CLAIM IS NOT A PLAYER-TO-PLAYER TRANSFER (2026-10-12).
 *
 * Pinned on migration 20261012114304_a_club_bank_claim_is_not_a_player_transfer.sql.
 * A deleted account's wallet closed into its club bank is a club_bank_claim
 * row whose to_user_id is the club owner, the face of the bank. The union
 * integrity sweep read 62 of them as player transfers to one user.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(
    process.cwd(),
    'supabase/migrations/20261012114304_a_club_bank_claim_is_not_a_player_transfer.sql'
  ),
  'utf8'
);

describe('a club bank claim is not a player transfer', () => {
  it('is one transaction with a live proof and a pinned preimage', () => {
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql.trim().endsWith('COMMIT;')).toBe(true);
    expect(sql.match(/^-- @live-proof: /gm)?.length).toBe(1);
    expect(sql).toContain("'96d7eff01edb51381bcec29486081704'");
  });

  it('adds club_bank_claim to the movement types that are not player-to-player, and only that', () => {
    expect(sql).toContain(
      "v_old text := $a$AND ct.transaction_type NOT IN ('agent_to_player_transfer','rakeback','buyin','cashout')$a$;"
    );
    expect(sql).toContain("         'club_bank_claim')$a$;");
    expect(sql).not.toMatch(/is_horse/);
  });
});
