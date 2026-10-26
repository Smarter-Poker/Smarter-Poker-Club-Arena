/**
 * THE ASSIGNED AGENT HEARS THE DECISION (Dan 2026-10-24, binding)
 *
 * "WHO EVER APPROVES THE CASH OUT, THOSE CHIPS ARE CREDITED TO THAT PERSONS
 * AGENT WALLET", and then, on the follow-ups: "FULLY BUILD, FIX AND ENHANCE ALL
 * OF THESE". A cash-out request is sent to the player's agent; since
 * 2026-10-23 any owner, co-owner or admin may accept or cancel it instead. The
 * agent who was asked to decide must then be told it was decided, by whom, and
 * that the chips did not come to him.
 *
 * Pins migration 20261024220301 and its fixture twin:
 *   - for an approval or a decline the audience adds the assigned agent;
 *   - only when he is not null and still has a profile, so a removed agent can
 *     never be the reason a payout cannot be accepted;
 *   - the hold audience (player + agent) and the copy function are untouched;
 *   - the fixture installs the identical line and asserts the exact recipients.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const migration = read(
  'supabase/migrations/20261024220301_cashout_decision_tells_the_assigned_agent.sql'
);
const fixture = read('tests/fixtures/cashier-document-authority/regression.sql');

const ADDED =
  "||CASE WHEN kind IN(''approval'',''decline'') AND assigned IS NOT NULL\\n        AND EXISTS(SELECT 1 FROM public.profiles ap WHERE ap.id=assigned)\\n      THEN ARRAY[assigned] ELSE ARRAY[]::uuid[] END) x;";

describe('the assigned agent hears the decision', () => {
  it('adds the assigned agent to an approval or decline audience, guarded by a live profile', () => {
    expect(migration).toContain(ADDED);
    expect(migration).toContain('EXECUTE replace(v_def, v_old, v_new);');
    expect(migration).toContain('refusing to guess');
  });

  it('starts from the 2026-10-23 line, so the hold audience stays player and agent', () => {
    expect(migration).toContain(
      "CASE WHEN kind=''hold'' THEN ARRAY[r.player_id] ELSE ARRAY[club.owner_id,r.player_id] END"
    );
  });

  it('is one transaction, replaces one function and leaves the copy alone', () => {
    expect(migration.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(migration.match(/^COMMIT;$/gm)).toHaveLength(1);
    expect(migration).not.toMatch(/fn_cashier_notice_copy\s*\(/);
    expect(migration).toContain('-- @live-proof:');
  });

  it('is mirrored in the fixture, which asserts the exact recipients', () => {
    expect(fixture).toContain('DO $decision_audience$');
    expect(fixture).toContain(ADDED);
    expect(fixture).toContain(
      "'an admin acceptance reaches owner, player, accepter and the assigned agent'"
    );
    expect(fixture).toContain("'an admin cancellation reaches the assigned agent'");
    expect(fixture.indexOf('END $request_audience$;')).toBeLessThan(
      fixture.indexOf('DO $decision_audience$')
    );
  });
});
