/**
 * A SEAT-EXIT GUARD WITHOUT ITS CONSUMER REFUSES NOTHING (2026-09-11).
 *
 * fn_ca_close_tournament_seat_exit_authority(token, require_consumed) raises
 * P0404 when authorization rows are left behind. The only thing that ever
 * consumes a row is the trigger zy_tournament_live_seat_exit_requires_authority
 * on public.table_seats, and production does not have it (the cutover that
 * installs it, 20260909014545, was never applied; 20260910051125 explains
 * why it must not be installed alone).
 *
 * From 05:05 UTC a wrapper that required consumption on success sat in front
 * of fn_complete_tournament_terminal, and no tournament with a seated winner
 * could finish: 532 refusals in 75 minutes, each replayed five times under
 * the settlement lane's global lock. 20260911081910 fixed the guard where it
 * lives: it raises only while its consumer exists and is enabled.
 *
 * This law keeps the newest definition of the close honest: its raise must
 * stay conditional on the consumer, so no future wrapper, from any branch,
 * can turn a missing trigger back into a refused finish.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = resolve(__dirname, '..', 'supabase', 'migrations');
const DEFINES_CLOSE =
  /CREATE OR REPLACE FUNCTION public\.fn_ca_close_tournament_seat_exit_authority\(/;

function newestCloseDefinition(): { file: string; body: string } {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; body: string } | null = null;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const at = sql.search(DEFINES_CLOSE);
    if (at < 0) continue;
    // The function body runs to the closing dollar-quote tag it opened with.
    const rest = sql.slice(at);
    const tag = /AS (\$[A-Za-z_]*\$)/.exec(rest);
    expect(tag, `${file}: the close has a dollar-quoted body`).not.toBeNull();
    const open = rest.indexOf(tag![1]) + tag![1].length;
    const close = rest.indexOf(tag![1], open);
    found = { file, body: rest.slice(open, close) };
  }
  expect(found, 'some migration defines the close').not.toBeNull();
  return found!;
}

describe('the seat-exit authority close', () => {
  it('the newest definition is the one that knows about its consumer', () => {
    const { file } = newestCloseDefinition();
    expect(file >= '20260911081910').toBe(true);
  });

  it('raises only while zy_tournament_live_seat_exit_requires_authority exists and is enabled', () => {
    const { body } = newestCloseDefinition();
    const guard = body.indexOf('IF COALESCE(p_require_consumed,true) AND v_remaining<>0');
    const consumer = body.indexOf("t.tgname='zy_tournament_live_seat_exit_requires_authority'");
    const enabled = body.indexOf("t.tgenabled IN ('O','A')");
    const onSeats = body.indexOf("t.tgrelid='public.table_seats'::regclass");
    const raise = body.indexOf('RAISE EXCEPTION');
    expect(guard).toBeGreaterThan(-1);
    for (const part of [consumer, enabled, onSeats]) {
      expect(part).toBeGreaterThan(guard);
      expect(part).toBeLessThan(raise);
    }
    // Exactly one raise, and it is the guarded one.
    expect(body.split('RAISE EXCEPTION').length - 1).toBe(1);
  });

  it('still deletes the rows and clears the session scope before deciding anything', () => {
    const { body } = newestCloseDefinition();
    const del = body.indexOf('DELETE FROM public.tournament_seat_exit_authorizations');
    const token = body.indexOf("set_config('app.tournament_seat_exit_token','',true)");
    const op = body.indexOf("set_config('app.tournament_seat_exit_operation','',true)");
    const guard = body.indexOf('IF COALESCE(p_require_consumed,true)');
    for (const part of [del, token, op]) {
      expect(part).toBeGreaterThan(-1);
      expect(part).toBeLessThan(guard);
    }
  });
});
