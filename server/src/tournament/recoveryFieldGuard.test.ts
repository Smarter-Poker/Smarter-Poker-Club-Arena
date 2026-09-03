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

  it('still rescues the case this path exists for: 8 stranded rows, 10 paid places', () => {
    // The COMPLETED bounty MTT with 8 players left 'playing' and $60 of a $100
    // pool never paid — the defect that put this rescue here in the first place.
    expect(fieldIsStillLive({ livePlayers: 8, paidPlaces: 10 })).toBe(false);
  });

  it('rescues a normal finish: one winner left, places to pay', () => {
    expect(fieldIsStillLive({ livePlayers: 1, paidPlaces: 9 })).toBe(false);
  });

  it('rescues a fully settled field with nobody left playing', () => {
    expect(fieldIsStillLive({ livePlayers: 0, paidPlaces: 9 })).toBe(false);
  });

  it('treats exactly-as-many-survivors-as-places as a finish, not a live field', () => {
    // The boundary belongs on the permissive side: a heads-up finish paying two
    // is a real ending, and refusing it would strand money this path must pay.
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
    expect(RECOVERY).toMatch(/fieldIsStillLive\(\{\s*livePlayers,\s*paidPlaces\s*\}\)/);
  });

  it('counts live players from the field it just read, and places from the structure', () => {
    expect(RECOVERY).toMatch(
      /const livePlayers = rows\.filter\(\(r\) => r\.status === 'playing'\)\.length/
    );
    expect(RECOVERY).toMatch(/const paidPlaces = payouts\.length/);
  });

  it('refuses by CONTINUING - it must not fall through and pay', () => {
    // The whole failure was paying. A guard that reports and then proceeds is
    // the same bug with better logging.
    const window = sliceEnclosingBlock(RECOVERY, 'fieldIsStillLive({ livePlayers, paidPlaces })');
    expect(window).toMatch(/recoverStuckCompleting_field_still_live/);
    expect(window).toMatch(/continue;/);
  });

  it('decides BEFORE any credit is issued', () => {
    const guard = RECOVERY.indexOf('fieldIsStillLive');
    // 2026-09-02: the credit is settleTournamentObligation (one settle path).
    const credit = RECOVERY.indexOf('settleTournamentObligation(supabase');
    expect(guard).toBeGreaterThan(-1);
    expect(credit).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(credit);
  });
});
