/**
 * A SNAPSHOT-EXCLUDED CHAIR WITHOUT A CARD DOES NOT HOLD AN ABANDONED HAND
 * (2026-10-04)
 *
 * A balancing chair can be durably seated before an incomplete preflop
 * snapshot while still being excluded from that saved hand. The exact-hand
 * hole-card row is the durable inclusion witness: an excluded chair with no
 * card and unchanged registration chips is outside the hand; an excluded
 * chair with a card remains a refusal.
 *
 * docs/changelog/2026-10-04-a-snapshot-excluded-chair-without-a-card-does-not-hold-an-abandoned-hand.md
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = join(__dirname, '..', 'supabase', 'migrations');
const PRIOR_SQL = readFileSync(
  join(
    MIGRATIONS,
    '20261003051223_an_abandoned_first_hand_of_an_event_that_never_dealt_is_a_mi.sql'
  ),
  'utf8'
);
const SQL = readFileSync(
  join(
    MIGRATIONS,
    '20261004010539_a_snapshot_excluded_chair_without_a_card_does_not_hold_an_ab.sql'
  ),
  'utf8'
);

const PRE_MD5 = '06d5804f17044e8a2b98c827bc251f0c';
const POST_MD5 = '31d28b982250f2997856743f5155e1b4';

const OLD_BLOCK = `         -- A live chair the snapshot does not name sat down after the snapshot
         -- was written (a late registration or a balancing move): it was never
         -- dealt in and holds only its own registration chips.
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
                                        WHERE x->>'user_id' = r->>'user_id')
                       AND NOT EXISTS (SELECT 1 FROM public.table_seats ls
                                        WHERE ls.id = (r->>'seat_id')::uuid
                                          AND ls.joined_at > snap.created_at))
`;

const NEW_BLOCK = `         -- A live chair absent from the saved snapshot is outside this hand
         -- when it joined after the snapshot, OR no durable hole card names it
         -- for this exact table and hand. The roster proof above still requires
         -- its exact playing registration and unchanged chips. A before-snapshot
         -- excluded chair with any exact-hand card continues to refuse.
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(roster) r
                     WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(snap.state_json->'players') x
                                        WHERE x->>'user_id' = r->>'user_id')
                       AND EXISTS (SELECT 1 FROM public.table_hole_cards c
                                    WHERE c.table_id = h.table_id
                                      AND c.hand_number = h.hand_number
                                      AND c.user_id = (r->>'user_id')::uuid)
                       AND NOT EXISTS (SELECT 1 FROM public.table_seats ls
                                        WHERE ls.id = (r->>'seat_id')::uuid
                                          AND ls.joined_at > snap.created_at))
`;

const md5 = (value: string) => createHash('md5').update(value, 'utf8').digest('hex');

function body(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_f06_abort_abandoned_generation(');
  expect(start, 'the migration defines the F06 door').toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  const close = sql.indexOf('$function$', open);
  expect(close).toBeGreaterThan(open);
  return sql.slice(open, close);
}

function excludedChairRefuses(input: {
  snapshotMember: boolean;
  joinedAfterSnapshot: boolean;
  hasExactHandCard: boolean;
}): boolean {
  return !input.snapshotMember && input.hasExactHandCard && !input.joinedAfterSnapshot;
}

describe('a snapshot-excluded chair without a card does not hold an abandoned hand', () => {
  const prior = body(PRIOR_SQL);
  const candidate = body(SQL);

  it('installs one exact reviewed successor over the live pre-image', () => {
    expect(md5(prior)).toBe(PRE_MD5);
    expect(md5(candidate)).toBe(POST_MD5);
    expect(SQL).toContain("md5(p.prosrc) = '" + PRE_MD5 + "'");
    expect(SQL).toContain("md5(p.prosrc) = '" + POST_MD5 + "'");
    expect(SQL).toMatch(/^-- @live-proof: .*'31d28b982250f2997856743f5155e1b4'$/m);
    expect(SQL.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(SQL.match(/^COMMIT;$/gm)).toHaveLength(1);
  });

  it('changes only the excluded-chair proof', () => {
    expect(prior.split(OLD_BLOCK)).toHaveLength(2);
    expect(candidate.split(NEW_BLOCK)).toHaveLength(2);
    expect(candidate.replace(NEW_BLOCK, OLD_BLOCK)).toBe(prior);
  });

  it('admits a before-snapshot excluded chair only when no exact-hand card names it', () => {
    expect(
      excludedChairRefuses({
        snapshotMember: false,
        joinedAfterSnapshot: false,
        hasExactHandCard: false,
      })
    ).toBe(false);
    expect(
      excludedChairRefuses({
        snapshotMember: false,
        joinedAfterSnapshot: false,
        hasExactHandCard: true,
      })
    ).toBe(true);
  });

  it('preserves the existing late-chair exemption and never judges a snapshot member here', () => {
    expect(
      excludedChairRefuses({
        snapshotMember: false,
        joinedAfterSnapshot: true,
        hasExactHandCard: true,
      })
    ).toBe(false);
    expect(
      excludedChairRefuses({
        snapshotMember: true,
        joinedAfterSnapshot: false,
        hasExactHandCard: true,
      })
    ).toBe(false);
  });

  it('binds the card witness to the exact table, hand and user', () => {
    expect(NEW_BLOCK).toContain('FROM public.table_hole_cards c');
    expect(NEW_BLOCK).toContain('c.table_id = h.table_id');
    expect(NEW_BLOCK).toContain('c.hand_number = h.hand_number');
    expect(NEW_BLOCK).toContain("c.user_id = (r->>'user_id')::uuid");
  });

  it('keeps registration, saved-stack, pot and privilege refusals unchanged', () => {
    expect(candidate).toContain(
      "OR (r->>'stack')::numeric IS DISTINCT FROM (r->>'chips')::numeric)"
    );
    expect(candidate).toContain("= (x->>'stack')::numeric + (x->>'totalInvested')::numeric");
    expect(candidate).toContain("(snap.state_json->>'pot')::numeric IS DISTINCT FROM");
    expect(candidate).toContain("RAISE EXCEPTION 'F06_ABORT_SAVED_STACKS_CHANGED'");
    expect(candidate).toContain("'credit', 0);");
    expect(candidate).not.toMatch(/UPDATE public\.(table_seats|tournament_players)\b/);
    expect(candidate).not.toMatch(/INSERT INTO public\.(chip_ledger|wallet_transactions)\b/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.fn_f06_abort_abandoned_generation[^;]*FROM PUBLIC, anon, authenticated;/
    );
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.fn_f06_abort_abandoned_generation[^;]*TO service_role;/
    );
  });
});
