/**
 * EIGHT SOURCES, AND UNTIL NOW NO DATA ON ANY OF THEM
 *
 * The rail carries eight sources, each with an operator switch, and nothing
 * has ever measured one. Every decision about what the bar says has been taste
 * - including the ones this programme made: reordered severities, rewritten
 * copy for a seated player, a widened last call for a major. None of it was
 * checked against a number, because there was no number.
 *
 * The property that matters most here is that an impression is counted ONCE
 * per announcement. The strip repaints every second while a clock runs, and a
 * counter that follows repaints measures the renderer, not the player.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }));

import { tickerTelemetry } from '../../src/services/TickerTelemetry';

beforeEach(() => {
  tickerTelemetry.reset();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ data: { ok: true }, error: null });
});

const sent = () => mocks.rpc.mock.calls[0]?.[1]?.p_counts;

describe('an impression is a player being told a thing, not a repaint', () => {
  it('counts the same announcement once however often it is shown', async () => {
    for (let i = 0; i < 60; i += 1) tickerTelemetry.shown('starting_soon', 'soon-t1');
    await tickerTelemetry.flushNow();
    expect(sent()).toEqual({ starting_soon: { shown: 1 } });
  });

  it('counts a different announcement separately', async () => {
    tickerTelemetry.shown('starting_soon', 'soon-t1');
    tickerTelemetry.shown('starting_soon', 'soon-t2');
    tickerTelemetry.shown('overlays', 'overlay-o1');
    await tickerTelemetry.flushNow();
    expect(sent()).toEqual({ starting_soon: { shown: 2 }, overlays: { shown: 1 } });
  });

  it('ignores an announcement with no id rather than counting a blank', async () => {
    tickerTelemetry.shown('guarantees', '');
    await tickerTelemetry.flushNow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not grow without bound on a tab left open all night', async () => {
    for (let i = 0; i < 1200; i += 1) tickerTelemetry.shown('table_openings', `table-${i}`);
    await tickerTelemetry.flushNow();
    expect(sent().table_openings.shown).toBe(1200);
    // The seen-set is bounded, so the earliest ids have been forgotten and
    // would count again. That is the intended trade - see SEEN_LIMIT.
    tickerTelemetry.shown('table_openings', 'table-0');
    await tickerTelemetry.flushNow();
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
});

describe('the two counters that make the ratio', () => {
  it('records an open against the source that earned it', async () => {
    tickerTelemetry.opened('overlays');
    await tickerTelemetry.flushNow();
    expect(sent()).toEqual({ overlays: { opened: 1 } });
  });

  it('records a dismissal against the source that provoked it', async () => {
    tickerTelemetry.dismissed('table_openings');
    tickerTelemetry.dismissed('table_openings');
    await tickerTelemetry.flushNow();
    expect(sent()).toEqual({ table_openings: { dismissed: 2 } });
  });

  it('batches everything into one call rather than one call per event', async () => {
    tickerTelemetry.shown('starting_soon', 'soon-t1');
    tickerTelemetry.opened('starting_soon');
    tickerTelemetry.dismissed('overlays');
    await tickerTelemetry.flushNow();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual({
      starting_soon: { shown: 1, opened: 1 },
      overlays: { dismissed: 1 },
    });
  });
});

describe('a metric never becomes the player problem', () => {
  it('swallows a failed write', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('network'));
    tickerTelemetry.shown('starting_soon', 'soon-t1');
    await expect(tickerTelemetry.flushNow()).resolves.toBeUndefined();
  });

  it('writes nothing when there is nothing to say', async () => {
    await tickerTelemetry.flushNow();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it('does not re-send a batch it has already flushed', async () => {
    tickerTelemetry.shown('starting_soon', 'soon-t1');
    await tickerTelemetry.flushNow();
    await tickerTelemetry.flushNow();
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
});

describe('the rail is actually wired to it', () => {
  const TICKER = readFileSync(
    resolve(__dirname, '../../src/components/tournament/TournamentStartingTicker.tsx'),
    'utf8'
  );

  it('counts the impression from an effect, not from the render body', () => {
    /* The strip repaints every second while a clock runs, and a side effect in
       a render is double-invoked under StrictMode. */
    expect(TICKER).toContain('tickerTelemetry.shown(speakingKind, speakingId)');
    expect(TICKER).toMatch(/useEffect\(\(\) => \{\s*if \(!speakingId \|\| !speakingKind\) return;/);
  });

  it('counts an open and a dismissal where they happen', () => {
    expect(TICKER).toContain('tickerTelemetry.opened(entry.kind)');
    expect(TICKER).toContain('tickerTelemetry.dismissed(entry.kind)');
  });
});

describe('the migration behind it', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../supabase/migrations/20260914095526_the_rail_reports_which_source_earns_its_pixels.sql'
    ),
    'utf8'
  );

  it('pins the row to the caller rather than trusting a user id argument', () => {
    expect(SQL).toContain('v_uid uuid := auth.uid()');
    expect(SQL).not.toMatch(/fn_record_ticker_usage\(p_user_id/);
  });

  it('is additive, so a retry double-counts at worst', () => {
    expect(SQL).toContain('ON CONFLICT (day, user_id, source) DO UPDATE');
    expect(SQL).toContain('u.shown + EXCLUDED.shown');
  });

  it('ignores an unknown source instead of raising inside a metric', () => {
    expect(SQL).toContain('CONTINUE WHEN v_source NOT IN');
  });

  it('lets no player read another player reading habits', () => {
    expect(SQL).toContain('REVOKE ALL ON public.ca_ticker_usage_daily');
    expect(SQL).not.toMatch(/CREATE POLICY[^;]*TO authenticated/);
  });

  it('proves the behaviour and leaves the table as it found it', () => {
    expect(SQL).toContain('counters are not additive');
    expect(SQL).toContain('DELETE FROM public.ca_ticker_usage_daily');
  });

  it('is one transaction, per the production DDL policy', () => {
    expect((SQL.match(/^BEGIN;/gm) || []).length).toBe(1);
    expect(SQL).toContain('COMMIT;');
  });
});
