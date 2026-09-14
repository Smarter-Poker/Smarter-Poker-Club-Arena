/**
 * LAW: an alert must not have to wait for the failure it watches for.
 *
 * A Prometheus counter has no series until something increments it, and a rule
 * whose metric has no series evaluates to an EMPTY VECTOR - not zero. Empty is
 * not greater than a threshold and not less than one, so the rule cannot fire.
 * It reads, on every dashboard, exactly like health.
 *
 * That is how an alert ends up catching a decline and missing an outage:
 *
 *   HorseCashActionsStopped (critical, page: sms)
 *     sum(rate(poker_actions_fleet_total{audience="horse",format="cash"}[10m])) * 60 < 150
 *
 * On an engine that started and never got a single horse cash action onto the
 * felt - the total failure this alert is named for - that series does not
 * exist. rate() is empty, sum() of empty is empty, `empty < 150` is empty, and
 * the page never goes out. Once horses HAVE acted the series exists and the
 * alert works, so it is at its blindest in exactly the worst case.
 *
 * This is the fourth shape of one bug found on 2026-09-11:
 *
 *   - thirteen metric names with no producer at all, behind fifteen rules
 *     including three SMS pages, green for seven days;
 *   - `poker_hands_total` on a flag-gated registry enabled nowhere in this
 *     estate, leaving SLOHandsAreNotBeingDealt (critical, sms) unable to fire;
 *   - twenty-three dashboard panels reading metrics that never existed, four
 *     of them error-budget panels that render a FULL budget rather than no
 *     data;
 *   - and this: a producer that exists but has not run yet.
 *
 * check-monitoring-drift.mjs catches the first three by asking whether anything
 * EMITS the name. It cannot catch this one, because something does. Only
 * running the code answers it, so this law runs the code: it imports the
 * instruments exactly as the engine does at boot, renders the always-on
 * registry, and asks whether the series a rule needs is there before any
 * gameplay has happened.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alwaysOnRegistry } from './engineInstruments.js';

const here = dirname(fileURLToPath(import.meta.url));
const MON = resolve(here, '../../../infra/monitoring');

/** Metric names an alert or recording rule reads, comment-stripped. */
function metricsNamedByRules(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(MON)) return out;
  const files = readdirSync(MON).filter(
    (f) => /(-rules|-alerts)\.ya?ml$/.test(f) && !f.includes('QUARANTINED')
  );
  for (const f of files) {
    const body = readFileSync(resolve(MON, f), 'utf8');
    let current = '(unnamed)';
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const named = /^\s*-\s*(?:alert|record):\s*['"]?([\w:.-]+)/.exec(lines[i]);
      if (named) current = named[1];
      const bare = lines[i].replace(/#.*$/, '').replace(/"[^"]*"|'[^']*'/g, ' ');
      for (const m of bare.matchAll(/\bpoker_[a-z0-9_]+/g)) {
        if (!out.has(m[0])) out.set(m[0], []);
        const rules = out.get(m[0])!;
        if (!rules.includes(current)) rules.push(current);
      }
    }
  }
  return out;
}

/**
 * Base names the always-on registry publishes at import, before any gameplay.
 * Histograms render as _bucket/_sum/_count, so compare on the family.
 */
function seriesPublishedAtBoot(): Set<string> {
  const out = new Set<string>();
  for (const line of alwaysOnRegistry.renderPrometheus().split('\n')) {
    const m = /^([a-z_][a-z0-9_]*)(\{|\s)/.exec(line.trim());
    if (!m) continue;
    out.add(m[1]);
    out.add(m[1].replace(/_(bucket|sum|count)$/, ''));
  }
  return out;
}

describe('an alert cannot wait for a failure to exist', () => {
  it('the always-on registry publishes something before any gameplay', () => {
    const published = seriesPublishedAtBoot();
    expect(published.size).toBeGreaterThan(10);
  });

  it('the horse cash-action series exists on a cold engine', () => {
    // The specific case this law was written for. HorseCashActionsStopped is a
    // critical SMS page and its whole purpose is the case where this number is
    // zero, which is the case where an unseeded counter does not exist.
    const rendered = alwaysOnRegistry.renderPrometheus();
    expect(rendered).toMatch(
      /poker_actions_fleet_total\{[^}]*audience="horse"[^}]*format="cash"[^}]*\} 0/
    );
  });

  it('every COUNTER this module owns that a rule reads is published before it is needed', () => {
    const named = metricsNamedByRules();
    expect(named.size).toBeGreaterThan(20);

    /* COUNTERS ONLY, and the exclusion is reasoned rather than convenient.
       A counter has no series until an EVENT increments it, so the event it
       counts is the thing that makes it visible - which is why a failure
       counter is invisible in exactly the outage it exists for.
       A gauge here is set unconditionally on every sampler pass in
       GameServer (`horseDecisionWorkerReady.set(worker.phase === 'ready' ? 1 : 0)`
       and its neighbours), so it has a series within one tick of boot whether
       or not anything has gone wrong. That block's own comment states the
       contract: "absence is represented by worker_ready=0, not a fake healthy
       scale". A gauge that went missing would mean the sampler itself had
       stopped, which is a different failure with its own rules.
       Six gauges sit in that category - poker_event_loop_delay_p50_ms,
       poker_main_event_loop_governor_scale and friends - and all six were
       verified present on the live engine before being excluded here. */
    const src = readFileSync(resolve(here, 'engineInstruments.ts'), 'utf8');
    const owned = new Set(
      [...src.matchAll(/\.counter\(\s*'(poker_[a-z0-9_]+)'/g)].map((m) => m[1])
    );
    expect(owned.size).toBeGreaterThan(5);

    const published = seriesPublishedAtBoot();
    const blind: string[] = [];
    for (const [metric, rules] of named) {
      if (!owned.has(metric)) continue; // another module's to answer for
      if (published.has(metric)) continue;
      blind.push(`${metric} (read by ${rules.join(', ')})`);
    }
    expect(
      blind,
      'these counters are declared here and read by a rule, but publish no ' +
        'series until something increments them - so the rule evaluates to an ' +
        'empty vector and cannot fire:\n  ' +
        blind.join('\n  ')
    ).toEqual([]);
  });
});
