import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sliceCall, sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (file: string): string => readFileSync(path.join(process.cwd(), file), 'utf8');
const base = read('src/engine/ServerTableEngineBase.ts');
const dealing = read('src/engine/ServerTableEngineDealing.ts');
const settlement = read('src/engine/ServerTableEngineSettlement.ts');
const turns = read('src/engine/ServerTableEngineTurns.ts');
const handHistory = read('src/services/supabase/handHistory.ts');
const gameServer = read('src/GameServer.ts');
const managerBase = read('src/tournament/TournamentManagerBase.ts');
const manager = read('src/tournament/TournamentManager.ts');

describe('every live dealer carries and re-checks distributed authority', () => {
  it('checks the monotonic proof at the sole new-hand edge', () => {
    expect(dealing.match(/await this\.dealHand\(/g) ?? []).toHaveLength(1);
    const edge = dealing.indexOf('await this.dealHand(activePlayers)');
    const gate = dealing.lastIndexOf('if (!this.lifecycleCanMutate()) return;', edge);
    expect(gate).toBeGreaterThan(-1);
    expect(edge - gate).toBeLessThan(500);
  });

  it('checks authority before every authoritative settlement retry', () => {
    const postHand = sliceMethod(settlement, 'protected async postHandTasks(');
    expect(postHand).toContain('assertLeaseAuthority: () => {');
    expect(postHand).toContain('if (!this.hasCurrentEngineLeaseAuthority())');

    const writer = sliceMethod(handHistory, 'async function insertHandHistoryRow(');
    const rpc = writer.indexOf("supabase.rpc('fn_ca_commit_hand_settlement'");
    const proof = writer.lastIndexOf('atomicCommit.assertLeaseAuthority?.()', rpc);
    expect(proof).toBeGreaterThan(-1);
    expect(rpc).toBeGreaterThan(proof);
    expect(writer).toContain('p_instance_id: atomicCommit.leaseInstanceId!');
    expect(writer).toContain('p_lease_generation: atomicCommit.leaseGeneration!');
    expect(postHand).toContain('leaseInstanceId: INSTANCE_ID');
    expect(postHand).toContain('leaseGeneration: leaseAuthority.generation');
  });

  it('refuses human, horse, and deadline actions after local authority expires', () => {
    const human = sliceMethod(turns, '  handlePlayerAction(');
    expect(human).toContain('if (!this.lifecycleCanMutate())');
    expect(human).toContain("code: 'TABLE_LEASE_EXPIRED'");

    const horse = sliceMethod(turns, '  protected scheduleHorseAction(');
    expect(horse).toContain('const fenceIsCurrent = (): boolean =>');
    expect(horse).toContain('!this.lifecycleCanMutate()');
    expect(horse).toContain('currentLease.generation === leaseGeneration');
    const horseActionTimer = sliceCall(horse, 'this.horseActionTimer = setTimeout(');
    expect(horseActionTimer).toContain('if (!fenceIsCurrent()) return;');

    const timer = sliceMethod(turns, '  protected startTurnTimer(');
    expect(timer).toMatch(
      /this\.preciseTimer\.startTimer[\s\S]{0,220}!this\.lifecycleCanMutate\(\)/
    );
    const bankExpiry = timer.slice(
      timer.indexOf('Time bank itself expired'),
      timer.indexOf('const tbState = this.handController.getState()')
    );
    expect(bankExpiry).toContain('!this.lifecycleCanMutate()');

    const timeBank = sliceMethod(turns, '  public async activateTimeBank(');
    const refresh = timeBank.indexOf('await this.refreshTimeBankFromDb(userId)');
    const postAwaitFence = timeBank.indexOf('if (!this.lifecycleCanMutate())', refresh);
    expect(refresh).toBeGreaterThan(-1);
    expect(postAwaitFence).toBeGreaterThan(refresh);

    const preAction = sliceMethod(turns, '  public setPreAction(');
    expect(preAction).toContain('if (!this.lifecycleCanMutate())');
  });

  it('heartbeats only verified cash authorities and fences all losses before teardown', () => {
    const renewal = sliceMethod(gameServer, 'private async renewVerifiedCashTableLeaseProofs(');
    expect(renewal).toContain("authority?.scope === 'cash' && authority.verified");
    expect(renewal).toContain('return { tableId, leaseGeneration: authority.generation };');
    expect(renewal).toContain('captured.renewEngineLeaseProof({');
    expect(renewal).toContain('!engine.hasCurrentEngineLeaseAuthority()');

    const coordinator = sliceMethod(gameServer, 'private renewOwnedEngineLeaseProofs()');
    expect(coordinator).toContain('const existing = this.ownershipLeaseRenewalOperation;');
    expect(coordinator).toContain('if (existing) return existing;');
    expect(coordinator).toContain('this.performOwnedEngineLeaseProofRenewal()');
    expect(coordinator).toContain('this.ownershipLeaseRenewalOperation = tracked;');

    const renewalPass = sliceMethod(
      gameServer,
      'private async performOwnedEngineLeaseProofRenewal()'
    );
    expect(renewalPass).toContain('await Promise.allSettled([');
    const firstFence = renewalPass.indexOf('engine.fenceForEngineLeaseLoss(');
    const teardownLoop = renewalPass.indexOf('for (const [tableId, engine] of lostCashEngines)');
    expect(firstFence).toBeGreaterThan(-1);
    expect(teardownLoop).toBeGreaterThan(firstFence);
    expect(renewalPass.slice(teardownLoop)).toContain(
      "this.recoverDirectTableEngine(tableId, engine, 'cash_table_lease_lost')"
    );
  });

  it('routes every manager-owned tournament dealer through the parent generation', () => {
    expect(manager).not.toContain('new ServerTableEngine(');
    expect(managerBase.match(/this\.createManagedTableEngine\(/g)?.length ?? 0).toBe(5);
    expect(manager.match(/this\.createManagedTableEngine\(/g)?.length ?? 0).toBe(1);
    const factory = sliceMethod(managerBase, 'protected createManagedTableEngine(');
    expect(factory).toContain("scope: 'tournament'");
    expect(factory).toContain('generation: this.tournamentLeaseGeneration');
    expect(factory).toContain('tournamentId: this.tournamentId');

    const renew = sliceMethod(managerBase, 'renewTournamentLeaseProof(');
    expect(renew).toContain('engine.renewEngineLeaseProof(authority)');
    const fence = sliceMethod(managerBase, '  fenceForTournamentLeaseLoss(): void {');
    expect(fence).toContain('engine.fenceForEngineLeaseLoss(');
  });

  it('makes expiry part of every engine lifecycle check', () => {
    const lifecycle = sliceMethod(base, 'protected lifecycleCanMutate()');
    expect(lifecycle).toContain('this.engineLeaseAuthorityIsCurrent()');
    expect(lifecycle).toContain('this.expireEngineLeaseAuthority()');
  });
});
