/**
 * A CLOSED WEEK'S PAGE IS ITS CLOSE'S WORK (2026-10-12)
 *
 * The rakeback settler held its watermark at 2026-10-12T06:51:48Z because its
 * page straddled the week boundary and every page recompute of the closed week
 * ran into the database's 300 s statement_timeout. The weekly close recomputes
 * every club-week of its scope from source, so the settler no longer sends a
 * page of a closed week: it counts it as deferred and moves on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./supabase.js', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn(), reportWarning: vi.fn() }));

import { periodWeekHasClosed } from './RakebackSettlerService.js';

describe("a closed week's page is its close's work", () => {
  it('the live boundary: the week of 2026-10-05 closed at 07:00 UTC on 2026-10-12 (daylight time)', () => {
    expect(periodWeekHasClosed('2026-10-11', Date.parse('2026-10-12T06:59:59.999Z'))).toBe(false);
    expect(periodWeekHasClosed('2026-10-11', Date.parse('2026-10-12T07:00:00.000Z'))).toBe(true);
    expect(periodWeekHasClosed('2026-10-11', Date.parse('2026-10-12T11:37:18.000Z'))).toBe(true);
  });

  it('a standard-time week closes at 08:00 UTC', () => {
    expect(periodWeekHasClosed('2026-11-15', Date.parse('2026-11-16T07:59:59.999Z'))).toBe(false);
    expect(periodWeekHasClosed('2026-11-15', Date.parse('2026-11-16T08:00:00.000Z'))).toBe(true);
  });

  it('the week that spans the change back to standard time closes at its own midnight', () => {
    // 2026-11-01 is the first Sunday of November: the week of 10-26 ends 11-01
    // and closes at 2026-11-02 00:00 PST = 08:00 UTC.
    expect(periodWeekHasClosed('2026-11-01', Date.parse('2026-11-02T07:30:00.000Z'))).toBe(false);
    expect(periodWeekHasClosed('2026-11-01', Date.parse('2026-11-02T08:00:00.000Z'))).toBe(true);
  });

  it('an open week and an unreadable period_end are sent as before', () => {
    expect(periodWeekHasClosed('2026-10-18', Date.parse('2026-10-12T12:00:00.000Z'))).toBe(false);
    expect(periodWeekHasClosed('', Date.parse('2026-10-12T12:00:00.000Z'))).toBe(false);
    expect(periodWeekHasClosed('2026/10/11', Date.parse('2026-10-12T12:00:00.000Z'))).toBe(false);
  });

  it('the settler asks before it sends, and the page recompute is still the only call', () => {
    const src = readFileSync(join(__dirname, 'RakebackSettlerService.ts'), 'utf8');
    const loop = src.indexOf('for (const g of groups.values()) {');
    const ask = src.indexOf('if (periodWeekHasClosed(g.period_end, Date.now())) {', loop);
    const send = src.indexOf("supabase.rpc('fn_rakeback_recompute_periods'", loop);
    expect(loop).toBeGreaterThan(0);
    expect(ask).toBeGreaterThan(loop);
    expect(send).toBeGreaterThan(ask);
    expect(src.slice(ask, send)).toContain('deferredPeriods++;');
    expect(src.slice(ask, send)).toContain('continue;');
  });
});
