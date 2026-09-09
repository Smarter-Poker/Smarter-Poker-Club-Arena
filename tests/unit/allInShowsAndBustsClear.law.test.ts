/**
 * Dan 2026-08-30, two rulings from the live Sunday $200:
 *
 * 1. "A PLAYER NEVER NEEDS TO 'SHOW HIS CARDS' IN A TOURNAMENT, ANYTIME THERE
 *    IS AN ALL IN, ALL CARDS ARE ALWAYS SHOW[N]... YOU SHOULD NEVER SEE THE
 *    'SHOW CARDS' BUTTON ON AN ALL IN DURING A TOURNAMENT."
 * 2. "ONCE THE HAND IS COMPLETED, THE 0% 100% SHOULD DISAPPEAR AFTER HALF A
 *    SECOND, AND THE PLAYER WITH NO CHIPS INSTANTLY REMOVED... BUSTED PLAYERS
 *    ARE 'LINGERING' WAY TO LONG ON THE TABLE."
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sliceBetween,
  sliceBlockAfter,
  sliceDollarQuoted,
  sliceSqlStatement,
} from '../helpers/sourceWindow';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLE = fs.readFileSync(path.join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
const DEALING = fs.readFileSync(
  path.join(ROOT, 'server/src/engine/ServerTableEngineDealing.ts'),
  'utf8'
);
const MANAGER = fs.readFileSync(
  path.join(ROOT, 'server/src/tournament/TournamentManager.ts'),
  'utf8'
);
const TERMINAL_MIGRATION = fs.readFileSync(
  path.join(
    ROOT,
    'supabase/migrations/20260909215641_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

describe('an all-in tournament showdown never offers the Show Hand button', () => {
  it('the showdown bar condition consults the all-in flag and isTournament', () => {
    const bar = sliceBetween(TABLE, "boardStage === 'showdown' &&", 'Show Hand');
    expect(bar).toMatch(/isTournament && handHadAllInRef\.current/);
  });

  it('the flag survives the post-hand hold and resets only at the next deal', () => {
    // Set on the first all_in_equity broadcast…
    const setSite = sliceBetween(TABLE, "eventType === 'all_in_equity'", 'return;');
    expect(setSite).toMatch(/handHadAllInRef\.current = true/);
    // …cleared where the NEW hand clears its predecessor's state.
    const clearSite = sliceBetween(TABLE, 'setAllInEquities([]);\n        handHadAllInRef', ';');
    expect(clearSite).toMatch(/handHadAllInRef\.current = false/);
  });
});

describe('the equity overlay gets half a second after the hand, no more', () => {
  it('HAND_COMPLETE arms a 500ms clear of the all-in equities', () => {
    const block = sliceBetween(TABLE, 'DISAPPEAR AFTER HALF A SECOND', 'handCompleteResetAtRef');
    expect(block).toMatch(/setTimeout\(\(\) => \{\s*setAllInEquities\(\[\]\);\s*\}, 500\)/);
  });
});

describe('a busted tournament seat is vacated the moment the hand settles', () => {
  it('the atomic hand writer mirrors standings and vacates only its named zero stacks', () => {
    // The process publishes the durable outcome; it is no longer a second
    // table_seats/tournament_players writer that can crash between the two.
    const publish = sliceBlockAfter(DEALING, 'for (const player of justBustedPlayers)');
    expect(publish).toMatch(/type:\s*'seat_left'/);
    expect(publish).not.toMatch(/\.from\('(?:table_seats|tournament_players)'\)/);

    // Read the complete source-controlled definition installed as the
    // canonical hand-stack authority. Both writes and their proof live in one
    // database transaction, keyed by the same v_targets roster.
    const sync = sliceDollarQuoted(
      sliceBetween(
        TERMINAL_MIGRATION,
        'CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute',
        'REVOKE ALL ON FUNCTION public.fn_ca_settle_hand_stacks_absolute'
      ),
      '$function$'
    );
    const standings = sliceSqlStatement(sync, 'UPDATE public.tournament_players');
    const vacate = sliceSqlStatement(
      sync,
      'UPDATE public.table_seats ts\n           SET left_at = v_zero_stack_vacated_at'
    );
    expect(standings).toMatch(/SET chips = target\.stack/);
    expect(standings).toMatch(/tp\.status::text = 'playing'/);
    expect(vacate).toMatch(/SET left_at = v_zero_stack_vacated_at/);
    expect(vacate).toMatch(/ts\.stack = 0/);
    expect(sync.indexOf('UPDATE public.tournament_players')).toBeLessThan(
      sync.indexOf('SET left_at = v_zero_stack_vacated_at')
    );
    expect(TERMINAL_MIGRATION).toMatch(/'tournament_players_synced'/);
    expect(TERMINAL_MIGRATION).toMatch(/'tournament_zero_stack_seats_vacated'/);
    expect(TERMINAL_MIGRATION).toContain('SELECT prosrc INTO v_hand_source FROM pg_proc');
    expect(TERMINAL_MIGRATION).toContain(
      "'public.fn_ca_settle_hand_stacks_absolute(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure"
    );
    expect(TERMINAL_MIGRATION).toContain(
      'hand stack authority lost canonical locks or player-chip sync'
    );
  });

  it('there is no process-side seating sweep that can mint a replacement stack', () => {
    expect(MANAGER).not.toContain('ensureLateRegSeated');
    expect(MANAGER).not.toContain('for (const player of unseated)');
    expect(MANAGER).not.toContain('assignTournamentPlayerSeatAtomically');
    expect(MANAGER).not.toMatch(/<= 0\s*\?\s*startingChips/);
    expect(MANAGER).not.toMatch(/stack:\s*startingChips/);
  });
});
