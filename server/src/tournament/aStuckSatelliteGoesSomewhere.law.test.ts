/**
 * A STUCK SATELLITE GOES SOMEWHERE - ALL THREE SHAPES OF IT.
 *
 * The 2026-08-30 rule resolved the UNDECIDED case (2+ alive -> RUNNING) and
 * left the DECIDED one reported-then-skipped on every recovery cycle, forever.
 * Nothing else drives it: no pg_cron job, no edge function, no workflow, no
 * other caller transitions a COMPLETING satellite. The pool was collected and
 * the seats were never awarded.
 *
 * These pins are textual on purpose. The behaviour lives in a recovery loop
 * that talks to Supabase and to a live manager, so the cheap thing to pin is
 * that the three branches exist, in the right order, with the right guards -
 * the same shape the other law tests in this directory use.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const RECOVERY = fs.readFileSync(path.join(HERE, 'tournamentRecovery.ts'), 'utf8');
const DEALING = fs.readFileSync(path.join(HERE, '../engine/ServerTableEngineDealing.ts'), 'utf8');
const BASE = fs.readFileSync(path.join(HERE, '../engine/ServerTableEngineBase.ts'), 'utf8');

/** The file with `--` line comments removed, so a pin cannot pass on prose. */
function executable(src: string): string {
  return src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
    .join('\n');
}
const CODE = executable(RECOVERY);

describe('every decided satellite takes one of three exits', () => {
  it('an already-awarded satellite is CLOSED, not left spinning', () => {
    expect(CODE).toMatch(/Certified recovered satellite/);
    expect(CODE).toMatch(/certifyTournamentFinish\(/);
    expect(CODE).toMatch(/satellite_completion_failed/);
  });

  it('it decides "already awarded" from the payout record AND from a seat', () => {
    // Phase 3's record is what makes the question answerable at all. The seat
    // arm covers satellites that ran before the record existed.
    expect(CODE).toMatch(/from\('tournament_payouts'\)/);
    expect(CODE).toMatch(/eq\('source_satellite_id', t\.id\)/);
    expect(CODE).toMatch(/alreadyAwarded/);
  });

  it('a lone survivor is flipped to RUNNING so the awards pass can claim it', () => {
    expect(CODE).toMatch(/aliveCount === 1/);
    expect(CODE).toMatch(/recoverStuckCompleting_satellite_revived_decided/);
  });

  it('the revive is a compare-and-set, so two servers cannot both flip it', () => {
    const revive = CODE.slice(CODE.indexOf('aliveCount === 1'));
    expect(revive).toMatch(/\.eq\('status', 'COMPLETING'\)/);
  });

  it('no survivor and nothing awarded raises a CRITICAL alert and moves no money', () => {
    expect(CODE).toMatch(/Satellite\.stuck_completing_unawarded/);
    expect(CODE).toMatch(/'critical'/);
    // It must still fall through to the skip, not to the structure-cash path.
    expect(CODE).toMatch(/recoverStuckCompleting_satellite_skipped/);
  });

  it('the ambiguous case is never auto-paid on a guessed winner', () => {
    // The engine's fallback treats the LAST ELIMINATED player as the winner,
    // which in a normal finish is second place. That guess must not move money.
    const tail = CODE.slice(CODE.indexOf('Satellite.stuck_completing_unawarded'));
    const untilSkip = tail.slice(0, tail.indexOf('recoverStuckCompleting_satellite_skipped'));
    expect(untilSkip).not.toMatch(/fn_credit_and_log/);
    expect(untilSkip).not.toMatch(/status:\s*'RUNNING'/);
  });
});

describe('the undecided rule from 2026-08-30 still stands', () => {
  it('2+ alive is still flipped back to RUNNING', () => {
    expect(CODE).toMatch(/aliveCount >= 2/);
    expect(CODE).toMatch(/recoverStuckCompleting_satellite_revived/);
  });
});

describe('reviving a decided satellite cannot deal a card', () => {
  it('a tournament table refuses to deal below two players', () => {
    expect(BASE).toMatch(/minPlayersToDeal\(\)/);
    expect(BASE).toMatch(/isTournamentTable\(\)/);
    expect(DEALING).toMatch(/activePlayers\.length < this\.minPlayersToDeal\(\)/);
  });

  it('and parks the loop instead of proceeding', () => {
    expect(DEALING).toMatch(/idle_not_enough_players/);
  });
});

describe('the satellite branch never reaches the structure-cash rescue', () => {
  it('every satellite exit is a continue', () => {
    // Bound the slice at the LAST satellite exit, not at whatever comes next
    // in the file - the structure-cash rescue below is exactly what must stay
    // outside this window.
    const start = CODE.indexOf("'satellite'");
    const skip = CODE.indexOf('recoverStuckCompleting_satellite_skipped', start);
    expect(start).toBeGreaterThan(-1);
    expect(skip).toBeGreaterThan(start);
    const branch = CODE.slice(start, CODE.indexOf('continue;', skip) + 'continue;'.length);
    // Four exits: undecided revive, closed, decided revive, alerted skip.
    expect((branch.match(/continue;/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(branch).not.toMatch(/computePlacePrize/);
  });
});
