/**
 * LAW: the one loop that renews every lease cannot stop without saying so.
 *
 * `runOwnershipLeaseRenewalLoop` renews every cash lease and every tournament
 * lease in the process. `launchServerLifecycleJob` does not relaunch, so both
 * of its exits were permanent, and both were silent:
 *
 *   1. `renewOwnedEngineLeaseProofs` serialises on
 *      `ownershipLeaseRenewalOperation` and hands the in-flight promise to any
 *      later caller. A pass that never settles never clears the slot, so every
 *      later tick awaits the same hung promise forever.
 *   2. The `while (directAdmissionIsCurrent(generation))` condition going false
 *      returns cleanly, and nothing starts it again.
 *
 * On 2026-09-12 one of them stopped every renewal in the platform for at least
 * two hours. Measured at the database, 73 seconds apart:
 *
 *   heartbeat_table_leases_v4        27,886 -> 27,886    (+0)
 *   heartbeat_tournament_leases_v4   27,765 -> 27,765    (+0)
 *   claim_table_lease_v2            103,562 -> 103,845   (+283 = 233/min)
 *
 * Not one lease renewed. Every one of the 78 cash tables was killed by its own
 * twenty second proof watchdog and re-claimed, 26,129 times in 2h10m, three
 * quarters of those engine lives dealing no hands, at tables the log shows
 * holding 9 of 9 seats, with 1,483 hands abandoned mid-play.
 *
 * There was no log line, no `reportError` and no metric, because nothing
 * FAILED. It was not running. An engine that is not doing a thing looks exactly
 * like an engine with nothing to do, which is the same blindness as an alert on
 * a metric with no series, and it is why the counter below is a rate that must
 * keep moving rather than an error that must appear.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alwaysOnRegistry } from './engineInstruments.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const read = (p: string): string => readFileSync(resolve(ROOT, p), 'utf8');
/** A law a `prettier` run can break is not a law. */
const flat = (s: string): string => s.replace(/\s+/g, ' ');

const gameServer = read('server/src/GameServer.ts');
const alerts = read('infra/monitoring/alert-rules.yml');

describe('the loop that renews every lease cannot stop silently', () => {
  it('both instruments exist on the always-on registry before anything has run', () => {
    const rendered = alwaysOnRegistry.renderPrometheus();
    expect(rendered).toContain('poker_lease_renewal_passes_total');
    expect(rendered).toContain('poker_lease_renewal_loop_running');
  });

  it('the completed-pass counter is seeded, so its rule is never an empty vector', () => {
    // This is the whole point: the failure is ABSENCE of passes. A counter with
    // no series makes `rate(...) == 0` an empty vector, which never fires.
    const rendered = alwaysOnRegistry.renderPrometheus();
    for (const outcome of ['completed', 'threw', 'abandoned']) {
      expect(rendered, outcome).toMatch(
        new RegExp(`poker_lease_renewal_passes_total\\{[^}]*outcome="${outcome}"[^}]*\\}`)
      );
    }
  });

  it('a pass that never settles is abandoned instead of poisoning every later pass', () => {
    const f = flat(gameServer);
    expect(f).toContain('OWNERSHIP_LEASE_RENEWAL_ABANDON_MS');
    // The slot must be released by the timer, not only by settlement.
    expect(f).toMatch(
      /if \(this\.ownershipLeaseRenewalOperation !== tracked\) return; this\.ownershipLeaseRenewalOperation = null;/
    );
    expect(f).toContain("leaseRenewalPassesTotal.inc(1, { outcome: 'abandoned' })");
    expect(f).toContain('GameServer.ownership_lease_renewal_pass_abandoned');
  });

  it('the abandon budget never outlives the proof window it defends', () => {
    // Past the proof window the answer cannot renew anything anyway:
    // renewEngineLeaseProof refuses a deadline that has already passed.
    expect(flat(gameServer)).toMatch(
      /OWNERSHIP_LEASE_RENEWAL_ABANDON_MS = Number\( process\.env\.OWNERSHIP_LEASE_RENEWAL_ABANDON_MS \?\? Math\.min\(TABLE_LEASE_PROOF_WINDOW_MS, TOURNAMENT_LEASE_PROOF_WINDOW_MS\) \)/
    );
  });

  it('the loop leaving while its generation is live is reported, not shrugged off', () => {
    const f = flat(gameServer);
    expect(f).toContain('GameServer.ownership_lease_renewal_loop_left_early');
    expect(f).toContain('leaseRenewalLoopRunning.set(0)');
    expect(f).toContain('leaseRenewalLoopRunning.set(1)');
    // It has to be a finally, or a throw leaves without recording.
    expect(f).toMatch(/\} finally \{ leaseRenewalLoopRunning\.set\(0\);/);
  });

  it('every completed and thrown pass is counted, so silence is measurable', () => {
    const f = flat(gameServer);
    expect(f).toContain("leaseRenewalPassesTotal.inc(1, { outcome: 'completed' })");
    expect(f).toContain("leaseRenewalPassesTotal.inc(1, { outcome: 'threw' })");
  });

  it('an alert reads the completed rate and pages', () => {
    expect(alerts).toContain('LeaseRenewalLoopStopped');
    expect(alerts).toMatch(
      /poker_lease_renewal_passes_total\{outcome="completed"\}\[5m\]\)\)\s*==\s*0/
    );
    const window = alerts.slice(
      alerts.indexOf('- alert: LeaseRenewalLoopStopped'),
      alerts.indexOf('- alert: LeaseHeartbeatsNotBeingKept')
    );
    expect(window).toContain('severity: critical');
    expect(window).toContain('page: sms');
    expect(window).toContain('runbook:');
  });
});
