/**
 * A refused guaranteed spawn is asked again when the answer can have changed,
 * not on every 60-second poll (2026-10-02: Deep Stack Society's 2026-10-05
 * 14:00 and 15:00 events were refused ~45 times in 40 minutes against a bank
 * that had not moved). See guaranteeRefusalBackoff.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  GUARANTEE_REFUSAL_FIRST_RECHECK_MS,
  GUARANTEE_REFUSAL_MAX_RECHECK_MS,
  GuaranteeRefusalBackoff,
  guaranteeShortfallFrom,
} from './guaranteeRefusalBackoff.js';

const REFUSAL =
  'Club Deep Stack Society cannot guarantee 100.00 chips: club bank holds 32712.00, floor 0.00, already promised 37327.50 on live events - short by 4715.50. Add chips to the bank to cover the guarantee.';
const CLUB = 'c1';
const MIN = 60 * 1000;

function harness(initialBank: number | null) {
  let nowMs = 1_000_000;
  let bank: number | null = initialBank;
  let reads = 0;
  const backoff = new GuaranteeRefusalBackoff(() => nowMs);
  const read = async () => {
    reads++;
    return bank;
  };
  return {
    backoff,
    read,
    advance: (ms: number) => (nowMs += ms),
    setBank: (b: number | null) => (bank = b),
    reads: () => reads,
  };
}

describe('guaranteeShortfallFrom', () => {
  it('reads both refusal signatures', () => {
    expect(guaranteeShortfallFrom(REFUSAL)).toBe(4715.5);
    expect(
      guaranteeShortfallFrom(
        'Tournament cannot be published because its guarantee is short by 373.47 chips'
      )
    ).toBe(373.47);
    expect(guaranteeShortfallFrom('duplicate key')).toBeNull();
    expect(guaranteeShortfallFrom(undefined)).toBeNull();
  });
});

describe('GuaranteeRefusalBackoff', () => {
  it('a spawn never refused is always attempted, without reading the bank', async () => {
    const h = harness(100);
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(true);
    expect(h.reads()).toBe(0);
  });

  it('an unmoved bank is not asked again every minute', async () => {
    const h = harness(32712);
    await h.backoff.refused('k', CLUB, REFUSAL, h.read);
    let attempts = 0;
    for (let minute = 1; minute < GUARANTEE_REFUSAL_FIRST_RECHECK_MS / MIN; minute++) {
      h.advance(MIN);
      if (await h.backoff.shouldAttempt('k', h.read)) attempts++;
    }
    expect(attempts).toBe(0);
    h.advance(MIN);
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(true);
  });

  it('chips covering the shortfall are noticed on the very next poll', async () => {
    const h = harness(32712);
    await h.backoff.refused('k', CLUB, REFUSAL, h.read);
    h.advance(MIN);
    h.setBank(32712 + 4715.49); // one cent short of the named shortfall
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(false);
    h.setBank(32712 + 4715.5);
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(true);
  });

  it('a falling bank (horse funding, overlays) never triggers an early retry', async () => {
    const h = harness(32712);
    await h.backoff.refused('k', CLUB, REFUSAL, h.read);
    h.advance(MIN);
    h.setBank(30000);
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(false);
  });

  it('repeat refusals double the recheck up to the ceiling', async () => {
    const h = harness(1);
    const delays: number[] = [];
    for (let i = 0; i < 6; i++) {
      await h.backoff.refused('k', CLUB, REFUSAL, h.read);
      let waited = 0;
      while (!(await h.backoff.shouldAttempt('k', h.read))) {
        h.advance(MIN);
        waited += MIN;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([5, 10, 20, 30, 30, 30].map((m) => m * MIN));
    expect(GUARANTEE_REFUSAL_MAX_RECHECK_MS).toBe(30 * MIN);
  });

  it('an unreadable bank means ask, never "nothing changed" (10.86 rule 1)', async () => {
    const h = harness(32712);
    await h.backoff.refused('k', CLUB, REFUSAL, h.read);
    h.advance(MIN);
    h.setBank(null);
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(true);

    const thrower = new GuaranteeRefusalBackoff(() => 0);
    await thrower.refused('k', CLUB, REFUSAL, async () => 1);
    expect(
      await thrower.shouldAttempt('k', async () => {
        throw new Error('read failed');
      })
    ).toBe(true);
  });

  it('a settled spawn forgets its refusal', async () => {
    const h = harness(1);
    await h.backoff.refused('k', CLUB, REFUSAL, h.read);
    h.backoff.settled('k');
    expect(h.backoff.size).toBe(0);
    expect(await h.backoff.shouldAttempt('k', h.read)).toBe(true);
  });
});

describe('the scheduler is wired to it', () => {
  const svc = readFileSync(
    new URL('./ScheduledTournamentService.ts', import.meta.url).pathname,
    'utf8'
  );
  const spawn = svc.slice(svc.indexOf('private async spawnInstance('));

  it('a spawn asks the backoff before it builds, claims or inserts anything', () => {
    const gate = spawn.indexOf('this.guaranteeBackoff.shouldAttempt(deferralKey');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(spawn.indexOf('this.buildInsertRow('));
    expect(gate).toBeLessThan(spawn.indexOf('this.claimSpawn('));
  });

  it('a guarantee refusal is recorded before the owners are notified, in both paths', () => {
    // Three refusal sites: the chip spawn, the restart clone and (2026-10-06)
    // the Diamond Arena door, whose refusal waits on the same backoff.
    expect(svc.match(/this\.guaranteeBackoff\.refused\(/g)).toHaveLength(3);
    expect(svc.match(/this\.guaranteeBackoff\.shouldAttempt\(/g)).toHaveLength(2);
    const refused = spawn.indexOf('this.guaranteeBackoff.refused(');
    expect(refused).toBeLessThan(spawn.indexOf("rpc('fn_notify_guarantee_bank_short'"));
  });

  it('an interval schedule defers on a stable key, not its per-minute spawn key', () => {
    expect(svc).toContain('`${schedule.id}:interval`');
  });
});
