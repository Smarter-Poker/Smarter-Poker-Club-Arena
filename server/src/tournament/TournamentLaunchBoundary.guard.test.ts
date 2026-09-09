import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sliceMethod, sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'TournamentManagerBase.ts'), 'utf8');
const start = sliceMethod(source, 'private async startLifecycle(');
const begin = sliceMethod(source, 'private async beginTournamentLaunch(');
const complete = sliceMethod(source, 'private async completeTournamentLaunch(');
const prove = sliceMethod(source, 'private async proveTournamentLaunchSetup(');
const tableBuild = sliceMethod(source, 'createTablesAndSeatPlayers(tournament: any)');

describe('a tournament launch crosses maintenance exactly once', () => {
  it('claims after field/payment preconditions and before every launch mutation', () => {
    const paidEvidence = start.indexOf(".eq('category', 'tournament_buyin')");
    const claim = start.indexOf('await this.beginTournamentLaunch(');

    expect(paidEvidence).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(paidEvidence);
    for (const mutation of [
      "supabase.rpc('fn_spin_draw_and_settle_atomic'",
      ".update({ status: 'playing'",
      'await this.creditSeatStacks(tournament)',
      'await this.createTablesAndSeatPlayers(tournament)',
    ]) {
      const mutationAt = start.indexOf(mutation);
      expect(mutationAt, `${mutation} moved or disappeared`).toBeGreaterThan(-1);
      expect(claim, `launch claim must precede ${mutation}`).toBeLessThan(mutationAt);
    }
  });

  it('mints one request id and reuses it for every ambiguous claim retry', () => {
    expect(start.match(/nodeCrypto\.randomUUID\(\)/g) ?? []).toHaveLength(1);
    expect(begin).toContain('p_launch_id: requestedLaunchId');
    expect(begin).not.toContain('randomUUID');
    expect(begin).toContain('launchId: returnedLaunchId');
    expect(begin).toContain('requestedStartedAtIso === null');
  });

  it('binds both durable launch edges to the manager lease generation', () => {
    expect(source).toContain('protected readonly tournamentLeaseGeneration: string | null;');
    expect(source).toContain('getTournamentLeaseGeneration(): string | null');
    expect(begin).toContain('p_lease_generation: this.tournamentLeaseGeneration');
    expect(begin).toContain(
      'result.lease_generation.toLowerCase() === this.tournamentLeaseGeneration.toLowerCase()'
    );
    expect(complete).toContain('p_lease_generation: this.tournamentLeaseGeneration');
    expect(complete).toContain(
      'result.lease_generation.toLowerCase() === this.tournamentLeaseGeneration.toLowerCase()'
    );
    expect(begin).toContain("'Tournament.launch_lease_generation_missing'");
    expect(complete).toContain("'Tournament.launch_lease_generation_missing'");
  });

  it('adopts an incomplete T1 receipt after the schedule drifts to T2', () => {
    expect(begin).toContain('const adoptsExistingReceipt =');
    expect(begin).toContain('result.replay === true');
    expect(begin).toContain('returnedLaunchId.toLowerCase() !== requestedLaunchId.toLowerCase()');
    expect(begin).toMatch(
      /launchTimestampMatches\(result\.started_at, requestedStartedAtIso\)[\s\S]*?\|\|\s*adoptsExistingReceipt/
    );

    const adoptedStart = start.indexOf('const launchStartMs = Date.parse(startedAtIso)');
    const lead = start.indexOf('this.preStartLeadMs =', adoptedStart);
    const hold = start.indexOf('engine.holdDealingUntil(launchStartMs)', lead);
    expect(adoptedStart).toBeGreaterThan(-1);
    expect(lead).toBeGreaterThan(adoptedStart);
    expect(hold).toBeGreaterThan(lead);
    expect(start).not.toContain('engine.holdDealingUntil(scheduledStartMs)');
  });

  it('stands down on a freeze or any unproven claim', () => {
    expect(begin).toContain("result.reason === 'platform_frozen'");
    expect(begin).toContain('return null;');

    const refusal = start.indexOf('if (!launchClaim || launchClaim.completed)');
    const firstMutation = start.indexOf("supabase.rpc('fn_spin_draw_and_settle_atomic'");
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(firstMutation);
    expect(start.slice(refusal, firstMutation)).toMatch(
      /this\.running\s*=\s*false;[\s\S]*?return;/
    );
  });

  it('hands a completed receipt back to RUNNING discovery without rebuilding or dealing', () => {
    expect(begin).toContain("result.completed === true && result.status === 'RUNNING'");

    const completedReceipt = start.indexOf('if (!launchClaim || launchClaim.completed)');
    const firstSetupMutation = start.indexOf("supabase.rpc('fn_spin_draw_and_settle_atomic'");
    const firstDealerAdmission = start.indexOf('this.admitManagedTableEngine(');

    expect(completedReceipt).toBeGreaterThan(-1);
    expect(completedReceipt).toBeLessThan(firstSetupMutation);
    expect(completedReceipt).toBeLessThan(firstDealerAdmission);
    expect(start.slice(completedReceipt, firstSetupMutation)).toMatch(
      /this\.running\s*=\s*false;[\s\S]*?return;/
    );
  });

  it('completes only after durable launch work and before dealer admission', () => {
    const tableCreation = start.indexOf('await this.createTablesAndSeatPlayers(tournament)');
    const setupProof = start.indexOf('await this.proveTournamentLaunchSetup(');
    const completion = start.indexOf('await this.completeTournamentLaunch(');
    const admission = start.indexOf('this.admitManagedTableEngine(', completion);
    const dealerStart = start.indexOf('this.startManagedTableEngine(', completion);

    expect(setupProof).toBeGreaterThan(tableCreation);
    expect(completion).toBeGreaterThan(setupProof);
    expect(admission).toBeGreaterThan(completion);
    expect(dealerStart).toBeGreaterThan(completion);
    expect(complete).toContain('result.completed === true');
    expect(complete).toContain("result.status === 'RUNNING'");
    expect(complete).toContain('this.launchTimestampMatches(result.started_at, startedAtIso)');
    expect(complete).toContain("'Tournament.launch_completion_unproven'");
  });

  it('proves roster migration, stack funding, seating, linkage and table counts', () => {
    expect(start).toContain('if (regRowsErr)');
    expect(start).toContain('const migrationFailure = migrationResults.find');
    expect(prove).toContain("tournamentProof.status !== 'REGISTERING'");
    expect(prove).toContain("row.status !== 'playing'");
    expect(prove).toContain('the active roster changed after launch migration began');
    // STACK FUNDING IS PROVEN BY CONSERVATION, NOT PER SEAT (2026-09-09).
    // `chips <= 0` on every row could not tell "the stacks were never credited"
    // from "they were credited and then played for", and it wedged eight Spins
    // in REGISTERING - one for ten hours - after their tables dealt before the
    // launch was proven. The funding claim this test exists to pin is intact and
    // stronger: the roster and the felt must each hold what the seats were bought
    // for. See TheSweepReachesTheTable.test.ts.
    expect(prove).toContain('Number(row.chips) < 0');
    expect(prove).toContain('const expectedFloor = roster.length * startingChips;');
    expect(prove).toContain('the playing roster holds no chips at all');
    expect(prove).toContain('durableTables.length !== this.tableEngines.size');
    expect(prove).toContain('ownedSeats.length !== 1');
    expect(prove).toContain('seat.table_id !== player.table_id');
    expect(prove).toContain('Number(seat.stack) < 0');
    expect(prove).toContain('const seatChips = seats.reduce(');
    expect(prove).toContain('occupiedCoordinates.has(coordinate)');
    expect(prove).toContain('Number(durableTable.current_players) !== liveCount');
    expect(prove).toContain('!this.tableEngines.has(tableId)');
  });

  it('proves a paid Spin row against its atomic reserve settlement', () => {
    expect(prove).toContain(".eq('kind', 'jackpot_draw')");
    expect(prove).toContain('bookedRows?.length !== 1');
    expect(prove).toContain('bookedMultiplier !== Number(tournament.spin_multiplier)');
    expect(prove).toContain('rowMultiplier !== bookedMultiplier');
    expect(prove).toContain('Number(tournamentProof.prize_pool) !== expectedPrizePool');
  });

  it('uses the incomplete receipt retry path instead of delayed repair work', () => {
    const refusedDraw = sliceEnclosingBlock(start, 'if (!fundedSpin)');
    expect(refusedDraw).toContain('this.running = false;');
    expect(refusedDraw).toContain('return;');
    expect(start).toMatch(/if \(!spinRowWritten\) \{\s*this\.running = false;\s*return;/);
    expect(source).not.toContain('scheduleSpinRowRepair');
    expect(source).not.toContain('spin_row_repair_exhausted');
  });

  it('never starts an adopted engine inside table construction', () => {
    expect(tableBuild).not.toContain('this.admitManagedTableEngine(');
    expect(tableBuild).not.toContain('this.startManagedTableEngine(');
  });

  it('fails table construction closed instead of leaving work to a sweep', () => {
    expect(tableBuild).toContain('if (playersErr) throw');
    expect(tableBuild).toContain('if (existingTablesErr)');
    expect(tableBuild).toContain('if (liveSeatRowsErr)');
    expect(tableBuild).toMatch(
      /throw new Error\(\s*`Tournament table \$\{i \+ 1\} was not created:/
    );
    expect(tableBuild).toMatch(/throw new Error\(\s*`Tournament seat insert failed:/);
    expect(tableBuild).toMatch(/throw new Error\(\s*`Tournament roster seat linkage failed:/);
    expect(tableBuild).toContain('if (countErr || count == null)');
    expect(tableBuild).toContain('if (countWriteErr)');
  });

  it('has no client-side RUNNING mutation left in start', () => {
    expect(start).not.toMatch(/\.update\(\{\s*status:\s*'RUNNING'/);
  });
});
