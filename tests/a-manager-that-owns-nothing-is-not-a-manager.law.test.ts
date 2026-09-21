/**
 * ===========================================================================
 *  LAW: A MANAGER THAT OWNS NOTHING IS NOT A MANAGER
 * ===========================================================================
 *
 * On 2026-09-21 six RUNNING tournaments - 49 live seats, 4,908,000 tournament
 * chips, 1,613.80 in six finalized and wholly undisbursed prize pools, the
 * oldest stranded since 2026-09-14 - held no row in engine_tournament_leases
 * and were not being dealt. The engine was healthy and had been up 58 hours.
 *
 * EVERY NUMBER AN OPERATOR COULD READ SAID THE BOARD WAS CLEAN:
 *   /health  tournamentResumesFailing: 0, tournamentResumesInFlight: 0,
 *            tournamentResumeBudget: 25 (the maximum)
 *   and, unremarked, activeTournaments: 472 against 465 lease rows and 471
 *   RUNNING tournaments. Nothing compared those two numbers.
 *
 * THE CHAIN, every link a correct component doing its job:
 *
 *  1. Each manager lost its lease and was asked to retire.
 *  2. `stopOwnedTournamentManager` could not stop it, so it returned false
 *     WITHOUT deleting the map entry - on purpose, and it says so: "A failed
 *     teardown is still the owner ... Keep it quarantined for the next
 *     cleanup pass."
 *  3. The custody-transfer fallback threw `f06_drained_custody_unproven`.
 *  4. The manager stayed in `GameServer.tournamentEngines`: owning no lease,
 *     not running, unable to deal and unable to leave.
 *  5. `discoverRunningResumes` asks `tournamentEngines.has(id)` and skips
 *     anything that answers yes. A corpse answers yes. For seven days.
 *
 * THERE WAS NO NEXT CLEANUP PASS. That is the defect: step 2 is right and is
 * NOT changed by this law - a slot whose table engines may still be live is
 * exactly the slot you do not hand to a replacement - but the other half of
 * its sentence was never written, so a restart was the only thing that ever
 * cleared a quarantine.
 *
 * WHAT THIS LAW PINS
 *  A. The quarantine still holds the slot (no "release it anyway" shortcut).
 *  B. A stop that leaves the slot occupied is RECORDED, including one that
 *     threw - on 2026-09-21 it was the throw that stranded all six.
 *  C. The pass that re-offers it exists, runs only on a board that was read,
 *     and is identity-exact about which manager it retries.
 *  D. The three numbers exist, are zero-seeded, and are published.
 *  E. A custody read reports WHICH refusal it got (CLAUDE.md 10.86 rules 1
 *     and 2): a database refusal, an unreachable database and an unreadable
 *     reply are three outcomes, not one token with the reason thrown away.
 *  F. The alerts exist, carry the section 13 rule 6 break guard, and page on
 *     the condition that ran unseen for a week.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceBetween, sliceMethod, sliceYamlEntry } from './helpers/sourceWindow';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const OWNERSHIP = read('server/src/tournament/TournamentManagerOwnership.ts');
const GAME_SERVER = read('server/src/GameServer.ts');
const CUSTODY = read('server/src/tournament/drainedF06Custody.ts');
const INSTRUMENTS = read('server/src/observability/engineInstruments.ts');
const QUARANTINE = read('server/src/tournament/quarantinedTournamentManagers.ts');
const ALERTS = read('infra/monitoring/alert-rules.yml');

describe('A. a failed teardown keeps its slot - the quarantine itself is not the bug', () => {
  it('stopOwnedTournamentManager still refuses to release a slot it could not stop', () => {
    const fn = sliceMethod(OWNERSHIP, 'export async function stopOwnedTournamentManager');
    // The catch returns false and must NOT delete. Releasing here is the one
    // "fix" that would trade a stalled tournament for two dealers on a table.
    const catchBlock = sliceBetween(
      fn,
      '} catch (error) {',
      'if (managers.get(tournamentId) !== expected) return false;'
    );
    expect(catchBlock).toContain('return false;');
    expect(catchBlock).not.toContain('managers.delete(');
    // The single deletion is the success path, behind a re-check of identity.
    expect(fn).toMatch(
      /if \(managers\.get\(tournamentId\) !== expected\) return false;\s*managers\.delete\(tournamentId\);/
    );
    expect(fn.match(/managers\.delete\(/g) ?? []).toHaveLength(1);
  });
});

describe('B. a stop that leaves the slot occupied is recorded, throw included', () => {
  const stop = sliceMethod(GAME_SERVER, 'private async stopTournamentManagerIfOwned(');

  it('records in the finally, so a stop that THREW is quarantined too', () => {
    // 2026-09-21: the six were stranded by a throw out of
    // transferDrainedF06Custody, not by a false return. A record placed beside
    // `return stopped` would have missed every one of them.
    const finallyBlock = stop.slice(stop.indexOf('} finally {'));
    expect(finallyBlock).toMatch(
      /if \(this\.tournamentEngines\.get\(tournamentId\) === manager\) \{\s*quarantine\.record\(/
    );
    expect(finallyBlock).toMatch(/\} else \{\s*quarantine\.forget\(tournamentId\);/);
    // And it can never replace the physical stop result a caller is awaiting.
    expect(finallyBlock).toMatch(/\} catch \{[\s\S]*tournamentQuarantineBookkeepingFailures/);
  });

  it('the map is the authority for whether the slot was released', () => {
    expect(stop).toContain('this.tournamentEngines.get(tournamentId) === manager');
  });
});

describe('C. the cleanup pass that stopOwnedTournamentManager was written to depend on', () => {
  const pass = sliceMethod(GAME_SERVER, 'private settleQuarantinedTournamentManagers(');
  const lane = sliceMethod(GAME_SERVER, 'private async discoverRunningResumes(');

  it('exists and is driven by the RUNNING lane', () => {
    expect(lane).toContain('this.settleQuarantinedTournamentManagers(running, generation)');
  });

  it('runs ONLY where the board was actually read', () => {
    // An unreadable board says nothing about who is still stuck. The refusal
    // branch must not settle, exactly as the resume cooldowns must not.
    const refusal = sliceBetween(lane, 'if (runningErr) {', '} else {');
    expect(refusal).toContain('GameServer.running_board_read_failed');
    expect(refusal).not.toContain('settleQuarantinedTournamentManagers');
    expect(lane).toMatch(
      /this\.tournamentResumeCooldowns\.settle\(running, \(id\) => this\.tournamentEngines\.has\(id\)\);\s*this\.settleQuarantinedTournamentManagers\(running, generation\);/
    );
  });

  it('re-offers the SAME stop and never releases a slot or claims a lease', () => {
    expect(pass).toContain('this.retireTournamentManagerInDiscovery(');
    // The two things this pass must never do.
    expect(pass).not.toContain('this.tournamentEngines.delete(');
    expect(pass).not.toContain('claimTournamentLease');
    expect(pass).not.toContain('ensureTournamentManagerAdmission');
  });

  it('is identity-exact and charges the attempt before the retry', () => {
    expect(pass).toContain(
      'if (!manager || manager !== quarantine.heldBy(tournamentId)) continue;'
    );
    expect(pass).toContain(
      'quarantine.settle((id) => this.tournamentEngines.get(id) === quarantine.heldBy(id));'
    );
    // Charged first, or a permanently stuck stop is re-offered every 5s.
    const recordAt = pass.indexOf('quarantine.record(');
    const retireAt = pass.indexOf('this.retireTournamentManagerInDiscovery(');
    expect(recordAt).toBeGreaterThan(-1);
    expect(retireAt).toBeGreaterThan(recordAt);
  });

  it('honours shutdown like every other discovery pass', () => {
    expect(pass).toContain('this.directAdmissionIsCurrent(generation)');
  });

  it('is a retry of a live path, never a scheduled repair job (CLAUDE.md 10.12)', () => {
    // It runs inside the existing five-second discovery lane. A cron, a timer
    // or a scheduled task here would be the banned shape.
    expect(pass).not.toMatch(/setInterval|setTimeout|cron/i);
  });
});

describe('D. the numbers that did not exist', () => {
  it('declares all three, and zero-seeds them so an alert has a baseline', () => {
    for (const metric of [
      'poker_tournaments_running_without_owner',
      'poker_tournament_managers_quarantined',
      'poker_tournament_manager_quarantine_oldest_seconds',
    ]) {
      expect(INSTRUMENTS).toContain(metric);
    }
    expect(INSTRUMENTS).toContain('tournamentsRunningWithoutOwner.set(0);');
    expect(INSTRUMENTS).toContain('tournamentManagersQuarantined.set(0);');
    expect(INSTRUMENTS).toContain('tournamentManagerQuarantineOldestSeconds.set(0);');
    expect(INSTRUMENTS).toContain('poker_f06_drained_custody_outcomes_total');
    expect(INSTRUMENTS).toMatch(
      /for \(const outcome of \['refused', 'unreadable', 'malformed'\]\) \{\s*f06DrainedCustodyOutcomesTotal\.inc\(0, \{ outcome \}\);/
    );
  });

  it('counts a quarantined slot as without an owner, not merely an empty one', () => {
    const pass = sliceMethod(GAME_SERVER, 'private settleQuarantinedTournamentManagers(');
    expect(pass).toMatch(/if \(!this\.tournamentEngines\.has\(id\) \|\| quarantine\.has\(id\)\)/);
    expect(pass).toContain('tournamentsRunningWithoutOwner.set(withoutOwner)');
  });

  it('publishes the quarantine on /health beside the resume numbers that lied', () => {
    // Matched across line breaks: Prettier decides where these wrap, and a
    // pin that a reformat can break is a pin that teaches people to delete it.
    expect(GAME_SERVER).toMatch(
      /tournamentManagersQuarantined:\s*this\.tournamentManagerQuarantine\?\.size \?\? 0/
    );
    expect(GAME_SERVER).toMatch(
      /quarantinedTournamentManagers:\s*this\.tournamentManagerQuarantine\?\.snapshot\(/
    );
  });

  it('a metric failure can never change a retirement decision', () => {
    const pass = sliceMethod(GAME_SERVER, 'private settleQuarantinedTournamentManagers(');
    expect(pass).toMatch(/try \{[\s\S]*tournamentsRunningWithoutOwner\.set[\s\S]*\} catch \{/);
  });
});

describe('E. a custody read says WHICH refusal it got (CLAUDE.md 10.86)', () => {
  it('no longer folds an RPC error into the same branch as a malformed reply', () => {
    // This was one `if (error || !data || ...)` ending in one bare
    // `throw new Error('f06_drained_custody_unproven')`. Production logged it
    // 1,551 times in ninety minutes and no reader could tell which of the six
    // named SQL refusals fired, or whether the database was reached at all.
    expect(CUSTODY).not.toMatch(/if \(\s*error \|\|\s*!data \|\|/);
    expect(CUSTODY).not.toContain("throw new Error('f06_drained_custody_unproven')");
    expect(CUSTODY).toMatch(/if \(error\) \{[\s\S]*classifyF06CustodyError\(error\)/);
  });

  it('names the three outcomes and keeps them distinct', () => {
    expect(CUSTODY).toContain(
      "export type F06DrainedCustodyOutcome = 'refused' | 'unreadable' | 'malformed';"
    );
    // A database that could not be reached is UNKNOWN. Reporting it as a
    // refusal would claim the database made a decision it never made.
    expect(CUSTODY).toMatch(/return \{\s*outcome: 'unreadable',/);
    expect(CUSTODY).toMatch(/outcome: 'refused', code: named\[0\]/);
  });

  it('keeps the legacy token at the head of the message for existing readers', () => {
    expect(CUSTODY).toContain('f06_drained_custody_unproven [${outcome}:${code}] ${detail}');
  });

  it('counts every outcome, so a refusal storm moves a series', () => {
    expect(CUSTODY).toContain('countF06CustodyOutcome');
    expect(CUSTODY).toMatch(/countF06CustodyOutcome\('malformed'\)/);
    // Metrics must never decide custody.
    expect(CUSTODY).toMatch(
      /try \{\s*f06DrainedCustodyOutcomesTotal\.inc\(1, \{ outcome \}\);\s*\} catch \{/
    );
  });
});

describe('F. the alarm that should have fired on 2026-09-14', () => {
  it('pages on a RUNNING tournament nobody is dealing, at warning and critical', () => {
    expect(ALERTS).toContain('alert: TournamentRunningWithNoOwner');
    expect(ALERTS).toContain('alert: TournamentRunningWithNoOwnerCritical');
    expect(ALERTS).toContain('alert: TournamentManagerQuarantineStuck');
    expect(ALERTS).toContain('alert: F06DrainedCustodyRefused');
  });

  it('every one carries the section 13 rule 6 maintenance-break guard', () => {
    for (const name of [
      'TournamentRunningWithNoOwner',
      'TournamentRunningWithNoOwnerCritical',
      'TournamentManagerQuarantineStuck',
      'F06DrainedCustodyRefused',
    ]) {
      // The alert's own list entry, and within it the expression up to `for:`.
      const guard = sliceBetween(sliceYamlEntry(ALERTS, `alert: ${name}`), 'expr:', 'for:');
      expect(guard, `${name} has no break guard`).toContain(
        'max_over_time(poker_maintenance_break_active[6m]) == 1'
      );
    }
  });

  it('the threshold is written down with the measurement beside it (10.84)', () => {
    // Everything between the banner comment and the alert it introduces.
    const preamble = sliceBetween(
      ALERTS,
      '# \u2500\u2500 A TOURNAMENT NOBODY IS DEALING',
      'alert: TournamentRunningWithNoOwner'
    );
    expect(preamble).toMatch(/2026-09-21/);
    expect(preamble).toMatch(/471 RUNNING/);
    expect(preamble).toMatch(/RESUME_COOLDOWN_CAP_MS|5 minutes/);
  });
});

describe('the quarantine module keeps the shape the incident needs', () => {
  it('is import-free, so its law is arithmetic and needs no database client', () => {
    expect(QUARANTINE).not.toMatch(/^\s*import\s/m);
  });

  it('records the incident that produced it, for the next agent', () => {
    expect(QUARANTINE).toContain('4,908,000');
    expect(QUARANTINE).toContain('Keep it quarantined for');
  });
});
