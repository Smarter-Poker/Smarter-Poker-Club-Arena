/**
 * LAW: a bust is recorded through the knockout door, and the door assigns the
 * place. The retired absent-player sweep is not the way back.
 * ═══════════════════════════════════════════════════════════════════════════
 * Written 2026-09-21 after seven knockout candidates sat in state `pending`
 * for 57 to 82 hours - the only seven on a platform holding 150,378 of them -
 * freezing five events and 884.00 of prize escrow that could not be paid to
 * anyone, because an unranked player keeps an event from finishing.
 *
 * Every one was a real bust with complete evidence: stack_before > 0,
 * stack_after = 0, a matching hand_atomic_commits receipt, a matching
 * hand_history row, no live seat. `fn_eliminate_tournament_player_atomic`
 * accepted all of them when finally asked. THE DOOR WAS NEVER REFUSING. It
 * has exactly one caller - the live engine that owns the tournament - and
 * that caller did not call.
 *
 * The obvious-looking fix is to bring back `fn_ca_eliminate_absent_tournament_
 * players`, whose whole purpose was to catch busts the door never reached.
 * IT IS NOT THE FIX, and this law exists to stop the next agent spending a day
 * discovering that:
 *
 *   - its cron row was deliberately set inactive on 2026-09-10 (20260910073355)
 *     as part of the staged seat-authority retirement, and that migration says
 *     in terms that "re-enabling the schedule by hand cannot bring the loop
 *     back";
 *   - both its predicates refuse any candidate whose state is not `rebought`,
 *     which is every candidate it would now need to act on;
 *   - the shape it writes - status 'eliminated' with a NULL position - is
 *     refused outright in a live event by the constraint trigger
 *     `tournament_elimination_has_a_place` (20260910072351). A revived sweep
 *     would fail at commit, every time.
 *
 * So: the place comes from the door. If a bust needs recording outside the
 * engine's own sweep, it goes through the door too - which is what the
 * settlement migration in this pull request does.
 *
 * Full reasoning and every measurement:
 * docs/changelog/2026-09-21-the-knockout-door-has-a-second-caller.md
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
}

function read(file: string): string {
  return readFileSync(join(MIGRATIONS, file), 'utf8');
}

describe('a bust is recorded through the knockout door', () => {
  it('still demands a finishing place for an elimination in a live event', () => {
    const declaring = migrationFiles().filter((f) =>
      read(f).includes('tournament_elimination_has_a_place')
    );
    expect(declaring.length).toBeGreaterThan(0);

    // Nothing may quietly drop the trigger that makes the door the only way to
    // record a bust. Dropping it is what would let a NULL-place write back in.
    // `DROP TRIGGER IF EXISTS ... ; CREATE TRIGGER ...` in one file is the
    // ordinary idempotent restatement and is not a removal - the trigger is
    // still there when the migration ends. Only a drop with no matching create
    // in the same file takes the guard away.
    for (const file of migrationFiles()) {
      const sql = read(file);
      const drops = /DROP\s+TRIGGER(?:\s+IF\s+EXISTS)?\s+tournament_elimination_has_a_place/i.test(
        sql
      );
      if (!drops) continue;
      const recreates =
        /CREATE\s+(?:OR\s+REPLACE\s+)?CONSTRAINT\s+TRIGGER\s+tournament_elimination_has_a_place/i.test(
          sql
        );
      expect(
        recreates,
        `${file} drops tournament_elimination_has_a_place without recreating it; an elimination in a live event must always carry a place`
      ).toBe(true);
    }
  });

  it('never re-activates the retired absent-player sweep schedule', () => {
    for (const file of migrationFiles()) {
      const sql = read(file);
      if (!sql.includes('ca-eliminate-absent-players')) continue;
      // The row exists only so the staged retirement chain can still find it.
      // It must stay inactive: its predicates and its write shape are both
      // incompatible with the law above.
      expect(
        /active\s*=>\s*true/i.test(sql),
        `${file} re-activates ca-eliminate-absent-players; it is retired, and a revived sweep writes a NULL place that tournament_elimination_has_a_place refuses at commit`
      ).toBe(false);
    }
  });

  it('settles stranded busts through the door, never by writing the roster directly', () => {
    const settlement = migrationFiles().find((f) =>
      f.includes('the_knockout_door_has_a_second_caller')
    );
    expect(settlement, 'the 2026-09-21 settlement migration is missing').toBeTruthy();

    const sql = read(settlement as string);
    expect(sql).toContain('fn_eliminate_tournament_player_atomic');

    // A settlement that sets the status itself skips the place, the candidate
    // close and every guard the door runs.
    expect(
      /UPDATE\s+public\.tournament_players[\s\S]{0,400}?SET[\s\S]{0,200}?status\s*=\s*'eliminated'/i.test(
        sql
      ),
      'the settlement writes tournament_players.status directly; a bust is recorded through the door, which assigns the place'
    ).toBe(false);

    // It must assert its own numbers, so it aborts if the board moved.
    expect(sql).toContain('the board moved');
    expect(sql).toContain('this settlement must move no money');
  });
});
