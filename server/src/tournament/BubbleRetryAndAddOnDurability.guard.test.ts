import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8');
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const base = strip(read('src/tournament/TournamentManagerBase.ts'));

describe('the add-on window follows durable database truth', () => {
  const trigger = sliceMethod(base, 'triggerAddOnPeriod(): Promise<void>');
  const drive = sliceMethod(
    base,
    'drivePersistedAddOnDeadline(rebroadcastAfterThaw: boolean): Promise<void>'
  );
  const finalTail = sliceMethod(
    base,
    'finishAddOnTail(finalPool: number, alreadyRepriced = false): Promise<void>'
  );

  it('reads back after the write even when its response was lost', () => {
    const update = trigger.indexOf('.update({');
    const writeReturning = trigger.indexOf('.select(projection)', update + 1);
    const readback = trigger.indexOf('.select(projection)', writeReturning + 1);
    const proofFailure = trigger.indexOf('if (proofError || !proven)');
    expect(update).toBeGreaterThanOrEqual(0);
    expect(writeReturning).toBeGreaterThan(update);
    expect(readback).toBeGreaterThan(writeReturning);
    expect(proofFailure).toBeGreaterThan(readback);
    expect(trigger.slice(writeReturning, readback)).not.toMatch(/if \(openError\)[\s\S]*?throw/);
    expect(trigger).toMatch(/write response was also lost/);
  });

  it('sets the latch and close timer only after exact persisted proof', () => {
    const validation = trigger.indexOf(
      "throw new Error('the persisted add-on window failed its exact read-back proof')"
    );
    const latch = trigger.indexOf('this.addOnPeriodTriggered = true');
    const closeTimer = trigger.indexOf('this.scheduleAddOnPeriodEnd(endsAt)');
    const broadcast = trigger.indexOf("this.broadcast('ADDON_PERIOD_START'");
    expect(latch).toBeGreaterThan(validation);
    expect(closeTimer).toBeGreaterThan(latch);
    expect(broadcast).toBeGreaterThan(closeTimer);
    expect(trigger).toMatch(/if \(!durableWindowProven\) this\.addOnPeriodTriggered = false/);
  });

  it('adopts concurrent or expired windows without duplicate one-shot effects', () => {
    const schedule = trigger.indexOf('this.scheduleAddOnPeriodEnd(endsAt)');
    const expired = trigger.indexOf('if (durationSeconds <= 0) return;');
    const nonOwner = trigger.indexOf('if (!openedByThisProcess) return;');
    const broadcast = trigger.indexOf("this.broadcast('ADDON_PERIOD_START'");
    expect(expired).toBeGreaterThan(schedule);
    expect(nonOwner).toBeGreaterThan(expired);
    expect(broadcast).toBeGreaterThan(nonOwner);
  });

  it('owns an exact persisted window after a lost write response', () => {
    expect(trigger).toMatch(
      /const openedByThisProcess =[\s\S]*?!!opened[\s\S]*?!!openError[\s\S]*?startMs === requestedStartMs[\s\S]*?endMs === requestedEndMs/
    );
    expect(trigger).toMatch(/if \(!openedByThisProcess\) return;/);
  });

  it('broadcast failures cannot suppress offering or durable closure', () => {
    const broadcastCatch = trigger.indexOf('TournamentManagerBase.addon_period_broadcast');
    const offer = trigger.indexOf('await this.tryTournamentAddOns()');
    expect(broadcastCatch).toBeGreaterThanOrEqual(0);
    expect(offer).toBeGreaterThan(broadcastCatch);
    expect(trigger).toMatch(/Math\.ceil\(\(endMs - Date\.now\(\)\) \/ 1000\)/);
    expect(trigger).toMatch(/durationSeconds,[\s\S]*?endsAt,/);
  });

  it('turns a lost guarantee response into the same idempotent post-finalization tail', () => {
    expect(drive).toMatch(/add_on_available, prize_pool, prize_pool_finalized, status/);
    const durableReceipt = drive.indexOf('if (state.prize_pool_finalized === true)');
    const poolProof = drive.indexOf('Number.isFinite(durablePool)', durableReceipt);
    const tail = drive.indexOf('await this.finishAddOnTail(durablePool)', poolProof);
    expect(durableReceipt).toBeGreaterThanOrEqual(0);
    expect(poolProof).toBeGreaterThan(durableReceipt);
    expect(tail).toBeGreaterThan(poolProof);

    const reprice = finalTail.indexOf('this.recalculateEliminatedPrizes(finalPool)');
    const end = finalTail.indexOf("this.broadcast('ADDON_PERIOD_END'", reprice);
    const clearClose = finalTail.indexOf('clearTimeout(this.addOnPeriodEndTimer)', end);
    const clearThawRetry = finalTail.indexOf(
      'clearTimeout(this.addOnResumeBroadcastRetryTimer)',
      clearClose
    );
    expect(reprice).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(reprice);
    expect(clearClose).toBeGreaterThan(end);
    expect(clearThawRetry).toBeGreaterThan(clearClose);
  });
});
