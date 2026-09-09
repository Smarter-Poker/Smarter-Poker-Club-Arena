/**
 * A LIVE TOURNAMENT MUST NEVER BE PAID OUT BY CHIPSTACK.
 *
 * Every case here is the 2026-08-30 incident or one of the legitimate rescues
 * that must keep working around it. The numbers are the real ones: a 20,880
 * prize pool paid to the top nine by chip count on an event at level 7 of
 * twelve late-registration levels with ninety players still holding 2,730,654
 * chips, because the engine died mid-flight and the boot-time rescue could not
 * tell "finishing" from "still being played".
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fieldIsStillLive } from './recoveryFieldGuard.js';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
/** Strip comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('a field larger than the payout structure is not a finish', () => {
  it('refuses the exact production case: 90 still playing, 18 paid places', () => {
    expect(fieldIsStillLive({ livePlayers: 90, paidPlaces: 18 })).toBe(true);
  });

  it('leaves an inside-payout-depth field to the stricter result-evidence gate', () => {
    // This helper detects only an oversized live field. Normal recovery now
    // independently refuses every multi-survivor snapshot, including this one.
    expect(fieldIsStillLive({ livePlayers: 8, paidPlaces: 10 })).toBe(false);
  });

  it('rescues a normal finish: one winner left, places to pay', () => {
    expect(fieldIsStillLive({ livePlayers: 1, paidPlaces: 9 })).toBe(false);
  });

  it('rescues a fully settled field with nobody left playing', () => {
    expect(fieldIsStillLive({ livePlayers: 0, paidPlaces: 9 })).toBe(false);
  });

  it('treats exactly-as-many-survivors-as-places as not oversized', () => {
    // The recovery's independent result-evidence gate still refuses 2+ alive;
    // this pure helper remains the stale RUNNING sweep's oversized-field test.
    expect(fieldIsStillLive({ livePlayers: 9, paidPlaces: 9 })).toBe(false);
    expect(fieldIsStillLive({ livePlayers: 10, paidPlaces: 9 })).toBe(true);
  });

  it('does NOT refuse when the structure resolved to nothing', () => {
    // An unresolved payout structure is its own failure and the caller handles
    // it. This guard must not swallow it by refusing every tournament.
    expect(fieldIsStillLive({ livePlayers: 90, paidPlaces: 0 })).toBe(false);
  });

  it('is not fooled by junk inputs', () => {
    expect(fieldIsStillLive({ livePlayers: NaN as unknown as number, paidPlaces: 9 })).toBe(false);
    expect(fieldIsStillLive({ livePlayers: -5, paidPlaces: 9 })).toBe(false);
    expect(fieldIsStillLive({ livePlayers: 90, paidPlaces: NaN as unknown as number })).toBe(false);
  });
});

describe('the guard is actually wired into the rescue', () => {
  const RECOVERY = code(read('src/tournament/tournamentRecovery.ts'));

  it('recoverStuckCompletingTournaments consults it', () => {
    expect(RECOVERY).toMatch(/import \{ fieldIsStillLive \} from '\.\/recoveryFieldGuard\.js'/);
    expect(RECOVERY).toMatch(
      /fieldIsStillLive\(\{\s*livePlayers,\s*paidPlaces:\s*structure\?\.length \?\? 0\s*\}\)/
    );
  });

  it('counts live players from the field it just read, and places from the structure', () => {
    expect(RECOVERY).toMatch(
      /const livePlayers = rows\.filter\(\(row\) => row\.status === 'playing'\)\.length/
    );
    expect(RECOVERY).toMatch(
      /const structure = resolvePayoutStructure\(tournament as never, rows\.length\)/
    );
  });

  it('refuses by CONTINUING - it must not fall through and pay', () => {
    // The whole failure was paying. A guard that reports and then proceeds is
    // the same bug with better logging.
    const window = sliceEnclosingBlock(
      RECOVERY,
      'fieldIsStillLive({ livePlayers, paidPlaces: structure?.length ?? 0 })'
    );
    expect(window).toMatch(/recoverStuckCompleting_field_still_live/);
    expect(window).toMatch(/continue;/);
  });

  it('decides BEFORE any credit is issued', () => {
    const guard = RECOVERY.indexOf(
      'fieldIsStillLive({ livePlayers, paidPlaces: structure?.length ?? 0 })'
    );
    const credit = RECOVERY.indexOf('requestTournamentTerminalReceipt(', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(credit).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(credit);
  });

  it('also refuses every field with two or more survivors before requesting a receipt', () => {
    expect(RECOVERY).toMatch(/if \(live\.length > 1\)/);
    const window = sliceEnclosingBlock(RECOVERY, 'if (live.length > 1)', 1);
    expect(window).toMatch(/recoverStuckCompleting_multiple_survivors_unresolved/);
    expect(window).toMatch(/continue;/);

    const guard = RECOVERY.indexOf('if (live.length > 1)', RECOVERY.indexOf('const hasDeal'));
    const receipt = RECOVERY.indexOf('requestTournamentTerminalReceipt(', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(receipt).toBeGreaterThan(guard);
    expect(RECOVERY).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});
