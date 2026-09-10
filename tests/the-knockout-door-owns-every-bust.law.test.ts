/**
 * THE KNOCKOUT DOOR OWNS EVERY BUST A HAND TOOK (2026-09-10).
 *
 * Twenty RUNNING tournaments stopped recording eliminations because a
 * fifteen-minute pg_cron sweep was writing the roster rows the engine's
 * knockout door was still holding - `eliminated`, chips 0, and no finishing
 * place. `fn_complete_tournament_entry_reprice` counts a placeless eliminated
 * row as an unfinished reprice, so the proof refused for ever, and
 * `runEliminationSweep` returns before its bust stage while that proof is
 * unproven. The sweep then took the next batch of stranded busts, and so on.
 * All 1,270 rows it had taken carried a `pending` knockout candidate: a hand
 * had taken every one of those stacks.
 *
 * The law has three limbs, and this file pins all three:
 *   1. neither sweep may touch a player whose latest knockout candidate is
 *      anything but `rebought`;
 *   2. an eliminated row with no finishing place cannot be written into a
 *      live event - a DEFERRED constraint trigger, so the finish normalizer's
 *      clear-then-assign and a cancellation's flip to CANCELLED both still
 *      pass inside their own transaction;
 *   3. the engine keeps the ordering that made the stall visible rather than
 *      silent: the reprice proof gates the bust stage.
 *
 * docs/changelog/2026-09-10-the-knockout-door-owns-every-bust.md
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

const DOOR = migrationNamed('the_knockout_door_owns_every_bust_a_hand_took');
const PLACE = migrationNamed('an_elimination_without_a_place_cannot_be_written');
const SCHEDULE = migrationNamed('the_retired_sweeps_keep_their_disabled_schedule_rows');
const DEFERRED = migrationNamed('a_deferred_check_reads_the_row_at_commit_not_the_statement');
/** The newest migration that (re)defines a function is the definition that is live. */
const latestDefinitionOf = (fn: string): { file: string; body: string } | null => {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${fn}\\s*\\(`, 'i');
  for (const f of sorted().reverse()) {
    const body = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    if (re.test(body)) return { file: f, body };
  }
  return null;
};
const ELIMINATIONS = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerEliminations.ts'),
  'utf8'
);
const BASE = fs.readFileSync(
  path.join(process.cwd(), 'server/src/tournament/TournamentManagerBase.ts'),
  'utf8'
);

describe('the knockout door owns every bust a hand took', () => {
  it('both sweeps refuse a player whose latest knockout candidate is not rebought', () => {
    // one predicate per sweep, each reading the newest candidate for that
    // player and defaulting to 'rebought' only when no candidate exists
    const predicates = DOOR.match(
      /ORDER BY c\.hand_number DESC, c\.id DESC LIMIT 1\), ''rebought''\) = ''rebought''/g
    );
    expect(predicates?.length, 'one candidate predicate for each of the two sweeps').toBe(2);
    expect(DOOR).toContain('eliminated_user_id = p.user_id');
    expect(DOOR).toContain('eliminated_user_id = tp.user_id');
  });

  it('the patch is asserted onto exactly one anchor in each live function body', () => {
    // an asserted text substitution: if the anchor is not unique the migration
    // aborts rather than editing the wrong clause
    expect(DOOR).toContain("RAISE EXCEPTION 'eliminator anchor appears % times, expected 1'");
    expect(DOOR).toContain("RAISE EXCEPTION 'releaser anchor appears % times, expected 1'");
  });

  it('the returned busts are the ones the door was holding, and nothing else', () => {
    // only rows whose latest candidate is pending; anything else aborts
    expect(DOOR).toContain('this migration only returns busts the door is holding');
    expect(DOOR).toContain("SET status = 'playing', chips = 0, eliminated_at = NULL");
    // a prepared result is immutable
    expect(DOOR).toContain('tournament_place_settlement_batches');
    expect(DOOR).toContain('refusing to touch a prepared result');
    // and the proof must pass afterwards or the whole migration rolls back
    expect(DOOR).toContain('would still fail the reprice proof after the return');
  });

  it('the row return takes the roster trigger locks in the roster trigger order', () => {
    // fn_lock_tournament_launch_proof_parents takes the launch receipt
    // FOR UPDATE NOWAIT and then the tournament; taking them the other way
    // round, per row, deadlocked against a live engine hand commit
    const receipts = DOOR.indexOf('FROM public.tournament_launch_receipts r');
    const tournaments = DOOR.indexOf('PERFORM 1 FROM public.tournaments t');
    const update = DOOR.indexOf('UPDATE public.tournament_players tp');
    expect(receipts).toBeGreaterThan(-1);
    expect(tournaments).toBeGreaterThan(receipts);
    expect(update).toBeGreaterThan(tournaments);
  });

  it('an eliminated row with no finishing place is refused in a live event', () => {
    expect(PLACE).toContain("IF NEW.status = 'eliminated' AND NEW.position IS NULL THEN");
    expect(PLACE).toContain("IF v_status IN ('RUNNING', 'COMPLETING', 'COMPLETED') THEN");
    expect(PLACE).toContain('RAISE EXCEPTION');
  });

  it('the live definition of that check re-reads the row at commit, never NEW', () => {
    // A DEFERRED constraint trigger is handed the tuple its firing statement
    // produced. Judging NEW refused five satellites whose settlement writes the
    // status first and the place second, on rows that were about to be correct.
    const live = latestDefinitionOf('fn_tournament_elimination_has_a_place');
    expect(live, 'the check must exist in a migration').not.toBeNull();
    expect(live!.body).toBe(DEFERRED);
    expect(live!.body).toContain('SELECT tp.status, tp.position INTO v_status, v_position');
    expect(live!.body).toContain('WHERE tp.id = NEW.id');
    expect(live!.body).toContain('IF NOT FOUND THEN RETURN NULL; END IF;');
    // the verdict is taken from the re-read, not from the queued tuple
    expect(live!.body).toContain("IF v_status = 'eliminated' AND v_position IS NULL THEN");
    expect(live!.body).not.toMatch(/IF NEW\.status = 'eliminated' AND NEW\.position IS NULL/);
  });

  it('that trigger is DEFERRED, so the normalizer and a cancellation still pass', () => {
    // fn_normalize_tournament_final_standings clears every eliminated position
    // and reassigns inside one transaction; atomic_cancel_tournament writes the
    // roster and only then flips the event to CANCELLED. An immediate trigger
    // would refuse both.
    expect(PLACE).toContain('CREATE CONSTRAINT TRIGGER tournament_elimination_has_a_place');
    expect(PLACE).toMatch(/DEFERRABLE\s+INITIALLY\s+DEFERRED/);
    expect(PLACE).toMatch(/AFTER INSERT OR UPDATE OF status, "position"/);
  });

  it('the sweeps keep a disabled schedule row rather than none at all', () => {
    // 20260910000850 (unapplied, on main) captures exactly two cron rows into a
    // receipts table whose CHECK demands two. Deleting them would make that
    // chain unappliable for ever.
    expect(SCHEDULE).toContain("cron.schedule('ca-eliminate-absent-players'");
    expect(SCHEDULE).toContain("cron.schedule('ca-release-broke-seats'");
    expect(SCHEDULE).toContain('active => false');
    expect(SCHEDULE).toContain('expected two inactive sweep rows');
  });

  it('the engine still gates the bust stage on the reprice proof', () => {
    // this is what made the stall loud instead of silent, and it must not be
    // "fixed" by letting the sweep proceed on an unproven reprice
    // the block the condition guards, bounded by its own braces
    const guarded = sliceEnclosingBlock(ELIMINATIONS, 'this.tournamentEntryRepricePending ||');
    expect(guarded).toContain("reconcileTournamentEntryWindow('engine.manager_wake')");
    expect(guarded).toMatch(
      /if \(!\(await this\.reconcileTournamentEntryWindow\([^)]*\)\)\) return;/
    );
  });

  it('a refused reprice is reported with its mismatch count, never swallowed', () => {
    expect(BASE).toContain('final-field reprice proof refused');
    expect(BASE).toContain("'Tournament.entry_window_reprice_unproven'");
  });
});
