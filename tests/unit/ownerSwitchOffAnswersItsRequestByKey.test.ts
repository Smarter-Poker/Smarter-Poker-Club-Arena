/**
 * The owner switch-off answers a replayed request id by its own key, never by
 * reading the cash_cluster_events log (2026-10-25). That log holds about five
 * million rows and indexes only (game_id, at): on the Lightning pilot game's
 * 1.3 million events the old read outlived every statement budget under the
 * game's row lock, and the switch-off of the pilot games was refused.
 * See 20261025022742.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '..', '..', 'supabase', 'migrations');
const latest = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) =>
    /CREATE OR REPLACE FUNCTION public\.fn_cash_game_switch_off\(/.test(
      readFileSync(join(dir, f), 'utf8')
    )
  )
  .pop()!;
const sql = readFileSync(join(dir, latest), 'utf8');
const body = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_cash_game_switch_off('));
const fn = body.slice(0, body.indexOf('$fn$;'));

describe('the owner switch-off answers its request id by key', () => {
  it('is defined last by the keyed-request migration', () => {
    expect(latest >= '20261025022742').toBe(true);
  });

  it('reads a replay from cash_game_switch_off_requests by its primary key', () => {
    expect(fn).toMatch(
      /FROM public\.cash_game_switch_off_requests r\s+WHERE r\.request_id = p_request_id/
    );
    expect(sql).toMatch(/request_id uuid PRIMARY KEY/);
  });

  it('never scans the event log for the request', () => {
    expect(fn).not.toMatch(/FROM public\.cash_cluster_events/);
  });

  it('records the request in the same transaction as the switch and its audit event', () => {
    const update = fn.indexOf('UPDATE public.cash_games SET enabled = false');
    const event = fn.indexOf('INSERT INTO public.cash_cluster_events');
    const request = fn.indexOf('INSERT INTO public.cash_game_switch_off_requests');
    expect(update).toBeGreaterThan(0);
    expect(event).toBeGreaterThan(update);
    expect(request).toBeGreaterThan(event);
  });
});
