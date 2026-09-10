/**
 * ONE PLAYER THE DOOR CANNOT ACCEPT IS NOT A REASON TO STOP THE WHOLE EVENT
 * (2026-09-10).
 *
 * The knockout door refuses deterministically for several real reasons -
 * `unresolved_knockout_generation_chain`, `pko_order_already_advanced`,
 * `knockout_generation_has_new_live_seat`, `invalid_claimants`. The bust
 * assignment pass aborted on the FIRST refusal, so any one of them froze the
 * whole event: no other bust could be recorded, the field never shrank, the
 * event never finished, and its escrow was never paid. Seven events were in
 * that state on 2026-09-10, one of them refusing the same player every fifteen
 * seconds since 2026-09-08.
 *
 * Two rules, both pinned here:
 *   1. the abort still stands for a transient refusal (a CAS miss, an evidence
 *      defer) - only a player refused BUST_REFUSAL_SKIP_AFTER times running is
 *      passed over, and the pass says out loud who it could not record;
 *   2. a player id is a UUID, not a UUID of a particular version - 95 of 1,198
 *      accounts (62 horses whose ids are 00000000-...-NN, and 33 humans) were
 *      being refused as `invalid_claimants` by a version-checked pattern
 *      (CLAUDE.md 10.5: horses are players).
 *
 * docs/changelog/2026-09-10-one-refused-bust-does-not-freeze-an-event.md
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceEnclosingBlock } from './helpers/sourceWindow';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const sorted = () =>
  fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
const migrationNamed = (slug: string): string => {
  const hit = sorted().filter((f) => f.endsWith(`_${slug}.sql`));
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const BASE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);
const ELIM = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const UUID = migrationNamed('a_player_id_is_a_uuid_not_a_uuid_version');
const CHAIN = migrationNamed('a_bust_the_player_came_back_from_is_a_rebought_bust');

describe('one refused bust does not freeze an event', () => {
  it('a transient refusal still aborts the pass, and only a standing one is passed over', () => {
    expect(BASE).toMatch(/static readonly BUST_REFUSAL_SKIP_AFTER = 3;/);
    const refusal = sliceEnclosingBlock(ELIM, 'this.bustRefusalStreak.set(refusedId, streak);');
    // the early return is still there for the first refusals
    expect(refusal).toContain(
      'if (streak < TournamentManagerBase.BUST_REFUSAL_SKIP_AFTER) return;'
    );
    // and past that the pass carries on with the rest of the field
    expect(refusal).toContain('continue;');
  });

  it('the skip is never silent', () => {
    const refusal = sliceEnclosingBlock(ELIM, 'this.bustRefusalStreak.set(refusedId, streak);');
    expect(refusal).toContain("'Tournament.bust_blocked_player_skipped'");
    expect(refusal).toContain('requestUrgentEliminationSweepAfter');
  });

  it('the streak counts consecutive refusals of the same player and clears on success', () => {
    expect(ELIM).toContain('const streak = (this.bustRefusalStreak.get(refusedId) ?? 0) + 1;');
    expect(ELIM).toContain('this.bustRefusalStreak.delete(bustedOrdered[i].user_id);');
  });

  it('a player id is validated as a uuid, never as a uuid version', () => {
    expect(UUID).toContain("'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'");
    // both doors, both predicates each, asserted before substitution
    expect(UUID).toContain(
      'bounty claim door carries % version-checked player-id pattern(s), expected 2'
    );
    expect(UUID).toContain(
      'claimant resolver carries % version-checked player-id pattern(s), expected 2'
    );
    // and neither may still carry the version check afterwards
    expect(UUID).toContain('player-id door(s) still carry the version-checked pattern');
  });

  it('the chain correction only touches a bust the player provably came back from', () => {
    expect(CHAIN).toContain('c2.stack_before > 0');
    expect(CHAIN).toContain('that is not proof of a comeback and this correction refuses to guess');
    expect(CHAIN).toContain("SET state = 'rebought'");
    // and it proves the class is empty when it is done
    expect(CHAIN).toContain('unresolved knockout chain(s) remain after the correction');
  });
});
