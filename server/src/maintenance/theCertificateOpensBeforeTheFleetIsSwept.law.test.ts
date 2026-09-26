/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LAW: THE CERTIFICATE OPENS BEFORE THE FLEET IS SWEPT (2026-09-25)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-25 the engine cut over at 15:29 UTC after a 6.7-day freeze, and
 * could not be restarted again. Three `auto-deploy-hetzner` runs (36155409978,
 * 36157652866, 36157811057) all died on the same words - "the engine did not
 * present a restart certificate with enough proof time remaining" - and the
 * receipts were IDENTICAL in shape, not alternating, so it was one static
 * defect and not a race against live state.
 *
 * THE ARITHMETIC, MEASURED. The break is `BREAK_DURATION_MS` = 300000ms and
 * `engine-release-transaction.sh` admits a cutover only while 285000ms of it
 * remain (150s candidate proof + 135s rollback reserve). So the certificate
 * has to EXIST within 15000ms of :55:00.000. Every first complete-certificate
 * observation across seven consecutive breaks in those three runs:
 *
 *     15375  15939  16408  18455  19060  19846  76869   (ms after t=0)
 *
 * Seven of seven outside the window. The floor missed it by 375ms. The release
 * was not unlucky, it was arithmetically unreachable.
 *
 * WHY. `beginCountdown()` fired on time, at `announcedAt + LAST_HAND_LEAD_MS`.
 * But before it persisted the countdown row - the write that sets
 * `durableConfirmed`, without which no certificate exists - it ran
 * `parkEveryEngine()` and then the `unparkedTables()` straggler census, both
 * walking every one of ~324 engines on the engine's single core, under a
 * comment calling them "cheap". `breakStartedAt` is correctly pinned to the
 * PROMISED :55 (a slow event loop is never permission to extend a freeze), so
 * all of that cost was charged against the only 15000ms the release had.
 *
 * This is CLAUDE.md 10.86 rule 4 exactly. #5026 found four gates demanding the
 * same 285000ms, budgeted the PUBLISHER's entry cost correctly, and wrote that
 * the remaining headroom was "today 0". Nobody budgeted the ENGINE's own cost
 * of opening the certificate, and it consumed all 15000ms by itself.
 *
 * AND THE 137. The dominant straggler reason was
 * `stopped_bank_custody_unconfirmed`, at 137 of ~324 tables. Those are
 * TERMINAL tournament engines holding a frozen stopped time bank that no path
 * in this process can ever confirm: every `persistPresenceForRestart('parked')`
 * call site is inside the dealing loop, a terminal engine has no dealing loop,
 * and the `'announced'` path it does take passes `timeBanks: undefined` and
 * records no acknowledgement. So the gate answered "not yet" to a question
 * whose true answer was "never" - 10.86 rule 1, and the same shape #4909
 * bounded for the F06 class after it held engine 8825af51 shut for 70 breaks.
 *
 * The fix is the WRITE, never an exemption: a terminal engine now persists the
 * custody it already holds, so `hasUnretiredStoppedTimeBankCustody()` clears on
 * its own arithmetic and the player's bank is genuinely recoverable. What is
 * left is named honestly in three outcomes, and all three still REFUSE.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MaintenanceBreak } from './MaintenanceBreak.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), 'utf8');

const RELEASE_SH = 'release-transaction';

type Engine = {
  isRunning: () => boolean;
  isBetweenHands: () => boolean;
  isParkedBetweenHands: () => boolean;
  pauseForMaintenance: (ms: number) => void;
  resumeFromMaintenance: () => void;
  isMaintenanceStateDurable?: () => boolean;
  maintenanceDurabilityReason?: () => string | null;
  hasUnresolvedF06Preparation?: () => boolean;
  hasUnretiredStoppedTimeBankCustody?: () => boolean;
};

const table = (over: Partial<Engine> = {}): Engine => ({
  isRunning: () => true,
  isBetweenHands: () => true,
  isParkedBetweenHands: () => true,
  pauseForMaintenance: () => {},
  resumeFromMaintenance: () => {},
  isMaintenanceStateDurable: () => true,
  maintenanceDurabilityReason: () => null,
  ...over,
});

const notDurable = (reason: string | null): Partial<Engine> => ({
  isMaintenanceStateDurable: () => false,
  maintenanceDurabilityReason: () => reason,
});

function countingDown(engines: Array<[string, Engine]>): MaintenanceBreak {
  const mb = new MaintenanceBreak({
    engines: () => new Map(engines) as never,
    isRunning: () => true,
  } as never);
  Object.assign(mb as never, { phase: 'counting_down', durableConfirmed: true });
  return mb;
}

const reasons = (mb: MaintenanceBreak): Record<string, number> =>
  (mb.snapshot().unparkedReasons ?? {}) as Record<string, number>;

describe('the certificate opens before the fleet is swept', () => {
  // ── 1. THE WINDOW EXISTS AT ALL ──────────────────────────────────────────
  //
  // The release's admission threshold and the engine's break duration live in
  // two different files and no single test read them together. If the
  // threshold ever reaches the duration the window is zero and NO release can
  // ever land, which is the state production was in for 6.7 days.
  it('leaves a positive admission window between the break and the reserve', () => {
    const sh = read(`../../scripts/engine-${RELEASE_SH}.sh`);
    const num = (name: string) => {
      const m = sh.match(new RegExp(`^${name}=([0-9]+)$`, 'm'));
      expect(m, `${name} must be a literal in engine-${RELEASE_SH}.sh`).toBeTruthy();
      return Number(m![1]);
    };
    const reserveMs =
      (num('BREAK_CUTOVER_PROOF_SECONDS') +
        num('BREAK_ROLLBACK_RESERVE_SECONDS') +
        num('BREAK_DEADLINE_SLACK_SECONDS')) *
      1000;
    const windowMs = num('BREAK_WINDOW_MS');
    const breakMs = MaintenanceBreak.BREAK_DURATION_MS as unknown as number;

    // The script's own copy of the duration must still be the engine's.
    expect(windowMs).toBe(breakMs);
    // And the admission window must be real. 15000ms today. If a future change
    // narrows this, the measurement above says what it costs: the engine's own
    // certificate open was observed at 15375ms after t=0 at its FASTEST.
    expect(breakMs - reserveMs).toBeGreaterThanOrEqual(15000);
  });

  // ── 2. NOTHING WALKS THE FLEET BEFORE THE ROW IS DURABLE ─────────────────
  //
  // The regression was an ORDERING, so this pin is about ordering. Neither the
  // second park pass nor the straggler census may sit between the countdown's
  // first statement and its durable save.
  it('persists the countdown before it parks or censuses the fleet', () => {
    const src = read('./MaintenanceBreak.ts');
    const begin = src.slice(src.indexOf('async beginCountdown(): Promise<void> {'));
    const body = begin.slice(0, begin.indexOf('\n  private armRecoveryRetry('));
    const persistAt = body.indexOf('await this.persistWithRetry(');
    expect(persistAt, 'beginCountdown must persist the countdown').toBeGreaterThan(-1);

    const before = body.slice(0, persistAt);
    // The fleet fan-out and the census are the two ~15s costs that regressed.
    expect(before).not.toContain('this.parkEveryEngine()');
    expect(before).not.toContain('this.unparkedTables()');
    // They must still happen - just after the certificate exists.
    expect(body.slice(persistAt)).toContain('this.sweepStragglersAfterCertificate()');
    const sweep = src.slice(src.indexOf('private sweepStragglersAfterCertificate('));
    expect(sweep).toContain('this.parkEveryEngine()');
    expect(sweep).toContain('this.unparkedTables()');
  });

  // ── 3. THE STOPPED-CUSTODY REFUSAL HAS THREE NAMED OUTCOMES ──────────────
  it('counts the two refusing stopped-custody outcomes under their own names', () => {
    const mb = countingDown([
      ['a', table(notDurable('stopped_bank_custody_unwritten'))],
      ['b', table(notDurable('stopped_bank_custody_unwritten'))],
      ['c', table(notDurable('stopped_bank_custody_unreadable'))],
      ['d', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(3);
    expect(reasons(mb)).toMatchObject({
      stopped_bank_custody_unwritten: 2,
      stopped_bank_custody_unreadable: 1,
    });
  });

  it('does not count a table whose stopped custody is durable', () => {
    // The third outcome. Durable custody is not a reason for anything: the
    // bank is on disk and the next process reads it, so the table simply is
    // not a straggler. This is the pin that turns 137 into 0 - by the WRITE,
    // never by an allow-list.
    const mb = countingDown([
      ['a', table()],
      ['b', table()],
    ]);
    expect(mb.snapshot().unparkedTables).toBe(0);
    expect(reasons(mb)).toEqual({});
  });

  it('names all three outcomes in the engine, and keeps the old two-way answer gone', () => {
    const src = read('../engine/ServerTableEngineBase.ts');
    expect(src).toContain("return 'stopped_bank_custody_unreadable';");
    expect(src).toContain("return 'stopped_bank_custody_unwritten';");
    // The conflated single answer is what refused 137 tables for ever.
    expect(src).not.toContain("'stopped_bank_custody_unconfirmed'");
  });

  // ── 4. A TERMINAL ENGINE WRITES THE BANK IT IS HOLDING ───────────────────
  it('makes a terminal engine persist its frozen custody, acknowledged only on a real write', () => {
    const src = read('../engine/ServerTableEngineBase.ts');
    const fn = src.slice(src.indexOf('private shouldPersistStoppedCustody('));
    const body = fn.slice(0, fn.indexOf('\n  protected async persistPresenceForRestart('));

    // It writes the custody's OWN banks at the custody's OWN hand number -
    // the shape loadTimeBanksFromPark(tableId, handCount) reads back.
    expect(body).toContain('savePresenceAtPark(');
    expect(body).toContain('handNumber: custody.handNumber');
    expect(body).toContain('timeBanks: banks');

    // Never while an accounting outcome is unknown: a debit we cannot confirm
    // must not be frozen into a snapshot.
    expect(body).toContain('this.timeBankAccountingUnconfirmed');
    expect(body).toContain('this.timeBankAccountingPending.size');
    // Never over a live engine's newer row - the upsert is keyed on table_id.
    expect(body).toContain('ServerTableEngineBase.liveEngines.has(this.tableId)');
    // A refused write records NO acknowledgement, so the gate stays shut, and
    // it falls through so nothing that used to be written stops being written.
    expect(body).toContain('if (!saved) return false;');
    // And it runs before the ordinary live-engine park path.
    const persist = src.slice(src.indexOf('protected async persistPresenceForRestart('));
    const guardAt = persist.indexOf('this.shouldPersistStoppedCustody()');
    const parkedAt = persist.indexOf("if (when === 'parked') {");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(parkedAt);
    // Scoped to the announcement, so it can never stand in for the 'parked'
    // path's accounting work - it did, and it broke 9 ParkedTimeBank pins.
    expect(persist).toContain("when === 'announced' && this.shouldPersistStoppedCustody()");
    // The decision is synchronous, so an engine with no stopped custody keeps
    // the exact microtask ordering it had. A fix must not shift the timing of
    // the paths it is not fixing (10.86 rule 4).
    expect(persist).not.toContain('await this.shouldPersistStoppedCustody');
  });

  // ── 5. THE RELEASE GATE NEVER PASSES OVER A BANK ─────────────────────────
  it('keeps every stopped-custody reason out of the release allow-list', () => {
    const sh = read(`../../scripts/engine-${RELEASE_SH}.sh`);
    const allow = sh.match(/^BOUNDED_ONLY=\{(.*)\}$/m);
    expect(allow, 'the allow-list must stay a literal set').toBeTruthy();
    // An ALLOW-list, never a deny-list (the script says so itself). A bank
    // class must never be admitted into it: `bank_park_write_incomplete` was
    // deliberately kept fatal because passing it over can cost a player their
    // time bank, and every custody name is the same class - including
    // `stopped_bank_custody_stuck`, which #5266 admitted on 2026-09-25 and
    // #5267 took back out on 2026-09-26: on a build with this law's own
    // announcement write, custody past the bound is a bank still not on disk.
    expect(allow![1]).not.toContain('bank');
    expect(allow![1]).not.toContain('custody');
  });

  // ── 6. THE SCRAPE CARRIES THEM ZERO-SEEDED ───────────────────────────────
  it('zero-seeds both new reasons on /metrics', () => {
    const src = read('../GameServer.ts');
    // stopped_bank_custody_unconfirmed was NEVER in this seed list - it only
    // reached /metrics through the dynamic extension, so no rule could read it
    // before it had already wedged the fleet. That is why 8 breaks went by.
    expect(src).toContain("'stopped_bank_custody_unwritten',");
    expect(src).toContain("'stopped_bank_custody_unreadable',");
  });
});
