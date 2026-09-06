/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE DETECTOR THAT WOULD HAVE NAMED THE 16:04 STALL
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * On 2026-09-06 the fleet fell from ~450 hands a minute to 6 while the engine
 * was alive and dealing and the database was idle. The cause was 133
 * reload-triggering DDL statements applied through the pooler in the single
 * minute 16:14, against a database where ONE PostgREST schema-cache reload
 * takes ~28 seconds.
 *
 * THE DANGEROUS DIRECTION for this check is crying wolf, not missing one.
 * Correctly-written migrations are large: the biggest minute in seven days was
 * a `mgmt-api` migration with **147** reload-triggering statements and THREE
 * distinct query texts - one transaction, coalesced, harmless. A detector that
 * counted statements would page on that and shrug at the incident. So most of
 * what is pinned here is what it must NOT report.
 *
 * The numbers in these cases are the real ones, read from `ca_ddl_events`.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

type Row = { occurred_at: string; query_snippet: string; application_name?: string };
type Minute = {
  minute: string;
  distinct: number;
  statements: number;
  apps: string[];
  storm: boolean;
};

let stormsByMinute: (rows: Row[], threshold?: number) => Minute[];
let DEFAULT_THRESHOLD: number;
let DEFAULT_HOURS: number;
let CONTEXT_FLOOR: number;

beforeAll(async () => {
  const href = pathToFileURL(
    resolve(__dirname, '..', 'scripts/ci/check-ddl-reload-storms.mjs')
  ).href;
  const mod = await import(/* @vite-ignore */ href);
  stormsByMinute = mod.stormsByMinute;
  DEFAULT_THRESHOLD = mod.DEFAULT_THRESHOLD;
  DEFAULT_HOURS = mod.DEFAULT_HOURS;
  CONTEXT_FLOOR = mod.CONTEXT_FLOOR;
});

/** `n` statements in one minute, each with its own query text. */
const distinctRows = (minute: string, n: number, app = 'Supavisor'): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    occurred_at: `${minute}:0${i % 10}.000+00:00`,
    query_snippet: `ALTER TABLE public.t_${i} ENABLE ROW LEVEL SECURITY;`,
    application_name: app,
  }));

/** `n` statements in one minute that all share ONE query text - one migration. */
const oneTransactionRows = (minute: string, n: number, app = 'mgmt-api'): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    occurred_at: `${minute}:0${i % 10}.000+00:00`,
    query_snippet: 'begin;\n\n-- apply sql from post body\n-- one migration, many statements',
    application_name: app,
  }));

describe('the minute that stopped the platform', () => {
  it('reports 121 distinct statements in one minute as a storm', () => {
    const out = stormsByMinute(distinctRows('2026-09-06T16:14', 121));
    expect(out).toHaveLength(1);
    expect(out[0].minute).toBe('2026-09-06T16:14');
    expect(out[0].distinct).toBe(121);
    expect(out[0].storm).toBe(true);
    expect(out[0].apps).toEqual(['Supavisor']);
  });

  it('does NOT report the 147-statement migration that was one transaction', () => {
    // The real 2026-08-31 20:27 minute: more statements than the incident, and
    // three distinct texts. This is the case that decides the whole design.
    const out = stormsByMinute(oneTransactionRows('2026-08-31T20:27', 147));
    expect(out).toEqual([]);
  });

  it('separates the two when they are read together', () => {
    const out = stormsByMinute([
      ...oneTransactionRows('2026-08-31T20:27', 147),
      ...distinctRows('2026-09-06T16:14', 121),
    ]);
    expect(out.map((m) => m.minute)).toEqual(['2026-09-06T16:14']);
  });
});

describe('what it must not fire on', () => {
  it('ignores the ordinary rhythm - p90 across seven days is four', () => {
    expect(stormsByMinute(distinctRows('2026-09-06T09:00', 4))).toEqual([]);
  });

  it('ignores a minute just under the context floor', () => {
    expect(stormsByMinute(distinctRows('2026-09-06T09:00', CONTEXT_FLOOR - 1))).toEqual([]);
  });

  it('reports the 15-to-29 band as context WITHOUT calling it a storm', () => {
    // The real 11:48 minute: 27 distinct. Worth seeing, not worth stopping for.
    const out = stormsByMinute(distinctRows('2026-09-06T11:48', 27));
    expect(out).toHaveLength(1);
    expect(out[0].storm).toBe(false);
  });

  it('does not merge two separate minutes into one verdict', () => {
    const out = stormsByMinute([
      ...distinctRows('2026-09-06T16:14', 20),
      ...distinctRows('2026-09-06T16:21', 20),
    ]);
    expect(out.map((m) => m.minute).sort()).toEqual(['2026-09-06T16:14', '2026-09-06T16:21']);
    expect(out.every((m) => m.storm === false)).toBe(true);
  });
});

describe('the boundary is where it says it is', () => {
  it('fires at exactly the threshold, not one past it', () => {
    const at = stormsByMinute(distinctRows('2026-09-06T12:00', DEFAULT_THRESHOLD));
    expect(at[0].storm).toBe(true);
    const below = stormsByMinute(distinctRows('2026-09-06T12:00', DEFAULT_THRESHOLD - 1));
    expect(below[0].storm).toBe(false);
  });

  it('honours an explicit threshold', () => {
    const out = stormsByMinute(distinctRows('2026-09-06T12:00', 20), 20);
    expect(out[0].storm).toBe(true);
  });
});

describe('the constants are the measured ones', () => {
  it('keeps the threshold above the seven-day p99 of 25', () => {
    // Raising it silences real storms; lowering it below p99 pages on ordinary
    // work. If the platform's rhythm genuinely changes, re-measure and move
    // this pin in the same commit - do not edit one of the two.
    expect(DEFAULT_THRESHOLD).toBe(30);
    expect(DEFAULT_THRESHOLD).toBeGreaterThan(25);
  });

  it('keeps the window short enough that the alarm can clear', () => {
    // The watchdog runs every 15 minutes. A 2-hour window is seen by eight
    // consecutive runs, so nothing slips through, and it stops re-reporting a
    // past storm two hours later instead of for a whole day.
    expect(DEFAULT_HOURS).toBe(2);
    expect(DEFAULT_HOURS * 60).toBeGreaterThan(15 * 4);
  });

  it('keeps the context floor below the threshold', () => {
    expect(CONTEXT_FLOOR).toBeLessThan(DEFAULT_THRESHOLD);
  });
});

describe('rows it cannot read do not become rows that are fine', () => {
  it('skips a row with no usable timestamp rather than inventing a minute', () => {
    const out = stormsByMinute([
      { occurred_at: '', query_snippet: 'x' },
      { occurred_at: 'not-a-timestamp', query_snippet: 'y' },
    ]);
    expect(out).toEqual([]);
  });

  it('counts a row with a missing application_name without dropping it', () => {
    const rows = distinctRows('2026-09-06T16:14', 30).map((r) => ({
      ...r,
      application_name: undefined,
    }));
    const out = stormsByMinute(rows);
    expect(out[0].distinct).toBe(30);
    expect(out[0].storm).toBe(true);
    expect(out[0].apps).toEqual([]);
  });
});

describe('the gate is actually wired to something', () => {
  it('runs in the watchdog, which is its reader', async () => {
    const { readFileSync } = await import('fs');
    const wf = readFileSync(
      resolve(__dirname, '..', '.github/workflows/publish-watchdog.yml'),
      'utf8'
    );
    expect(wf).toContain('scripts/ci/check-ddl-reload-storms.mjs');
  });
});
