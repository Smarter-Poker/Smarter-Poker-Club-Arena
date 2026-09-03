/**
 * WHO IS ALLOWED TO CREATE A TOURNAMENT, AND WHAT THEY MUST SUPPLY.
 *
 * The sibling of oneTableWriter.test.ts, and it exists for a sharper reason.
 *
 * A cash table has two writers. A tournament has FOUR, and only ONE of them —
 * `fn_create_tournament` — ever carried the rules. The other three insert rows
 * straight into `tournaments`, so every guard written into that RPC was a
 * guard three quarters of the platform never met:
 *
 *   * heads-up games were charged 10% instead of 5%, because the fee rule
 *     lived in the RPC (18 scheduled rows, measured 2026-08-27);
 *   * 39,046 rows carry a `table_size` no writer ever set, 5,000 of them PLO6
 *     at 9 seats against a deck that can serve 7;
 *   * a schedule row with two seats and a five-place payout preset would have
 *     created a two-handed game paying five places.
 *
 * As of 2026-08-31 the two rules that can be enforced without refusing a live
 * writer are a TRIGGER (`tournaments_creation_guard`), so they bind all four.
 * This file pins the rest: the writer list itself, and the columns each writer
 * must not leave to a default.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOTS = ['src', 'server/src'];

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [full] : [];
  });
}

/** Files chaining `.from('tournaments')` to an `.insert(`, doc comments ignored. */
function tournamentInserters(): string[] {
  const out: string[] = [];
  for (const root of ROOTS) {
    for (const file of filesUnder(path.join(process.cwd(), root))) {
      const code = fs
        .readFileSync(file, 'utf8')
        .replace(/^\s*\*.*$/gm, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\.from\(\s*'tournaments'\s*\)[\s\S]{0,160}?\.insert\(/.test(code)) {
        out.push(path.relative(process.cwd(), file));
      }
    }
  }
  return out.sort();
}

const EXPECTED_WRITERS = [
  'server/src/services/ScheduledTournamentService.ts',
  'server/src/services/TournamentRecurringService.ts',
  'src/services/HorseOrchestrator.ts',
];

describe('the tournament writers are known', () => {
  it('is exactly these three, plus fn_create_tournament in the database', () => {
    // Adding a writer is allowed. Adding one WITHOUT NOTICING is what this
    // stops — because a new writer inherits none of the RPC's rules and the
    // trigger only covers two of them.
    expect(tournamentInserters()).toEqual(EXPECTED_WRITERS);
  });

  it('the owner-facing path still goes through the RPC, not a raw insert', () => {
    const service = fs.readFileSync(
      path.join(process.cwd(), 'src/services/TournamentService.ts'),
      'utf8'
    );
    expect(service).toContain('fn_create_tournament');
    expect(tournamentInserters()).not.toContain('src/services/TournamentService.ts');
  });
});

describe('every writer states the seats rather than inheriting them', () => {
  /**
   * `table_size` is NOT NULL DEFAULT 9. A writer that omits it is not silent —
   * it asserts a nine-handed table. TournamentBrainContext resolves the format
   * from `table_size ?? max_players ?? 9` and `??` only falls through on NULL,
   * so a defaulted 9 meant a two-seat duel could never be recognised as one
   * and the horses played it with ICM and bubble ranges.
   */
  it.each([
    'server/src/services/TournamentRecurringService.ts',
    'server/src/services/ScheduledTournamentService.ts',
  ])('%s writes table_size', (rel) => {
    const code = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    expect(code).toMatch(/^\s*table_size:/m);
  });

  it('the recurring service clamps seats through the seat law, not by hand', () => {
    const code = fs.readFileSync(
      path.join(process.cwd(), 'server/src/services/TournamentRecurringService.ts'),
      'utf8'
    );
    // The engine clamps with this same function at deal time; writing the row
    // through it is what makes the row agree with the felt.
    expect(code).toContain('clampSeatsForVariant');
    const clamped = code.match(/table_size: clampSeatsForVariant\(/g) ?? [];
    expect(clamped.length).toBeGreaterThanOrEqual(2);
  });

  it('one variant map, complete, rather than four hand-kept copies', () => {
    const code = fs.readFileSync(
      path.join(process.cwd(), 'server/src/services/TournamentRecurringService.ts'),
      'utf8'
    );
    // Three of the four copies were missing plo6; none knew flh or flo8; the
    // fallback was a silent `|| 'NLH'`, so the tile advertised one game and
    // the players were dealt another.
    expect(code).not.toMatch(/const gameTypeMap: Record<string, string> = \{/);
    for (const key of ['plo6', 'flh', 'flo8', 'short_deck']) {
      expect(code).toMatch(new RegExp(`^\\s*${key}: '`, 'm'));
    }
  });
});

describe('a realised prize pool is never written as a guarantee', () => {
  it('HorseOrchestrator stops promising whatever it happened to collect', () => {
    // guaranteed_prize drives trg_tournaments_guarantee_affordable and
    // fn_apply_prize_guarantee. Writing the realised pool into it turns an
    // attendance number into a house promise.
    const code = fs.readFileSync(
      path.join(process.cwd(), 'src/services/HorseOrchestrator.ts'),
      'utf8'
    );
    expect(code).not.toMatch(/guaranteed_prize:\s*prizePool/);
  });
});

describe('a writer states its format instead of inheriting MTT', () => {
  it('HorseOrchestrator writes tournament_type on both paths', () => {
    // The column defaults to 'MTT', so an omitted value typed every Sit & Go
    // this path created as a multi-table tournament.
    const code = fs.readFileSync(
      path.join(process.cwd(), 'src/services/HorseOrchestrator.ts'),
      'utf8'
    );
    expect(code).toMatch(/tournament_type: 'SNG'/);
    expect(code).toMatch(/tournament_type: 'MTT'/);
  });

  it('and writes variant in the case every reader compares', () => {
    const code = fs.readFileSync(
      path.join(process.cwd(), 'src/services/HorseOrchestrator.ts'),
      'utf8'
    );
    expect(code).not.toMatch(/variant: 'SNG'/);
    expect(code).toMatch(/variant: 'sng'/);
  });
});

describe('paid places are checked before the row is written', () => {
  it('ScheduledTournamentService refuses more places than seats', () => {
    // The database refuses this too now, but a Postgres error in a background
    // poll names the constraint, not the schedule. This names the schedule.
    const code = fs.readFileSync(
      path.join(process.cwd(), 'server/src/services/ScheduledTournamentService.ts'),
      'utf8'
    );
    expect(code).toMatch(/payouts\.length > maxPlayers/);
    expect(code).toContain('more_paid_places_than_players');
  });
});
