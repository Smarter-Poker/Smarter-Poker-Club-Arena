/**
 * THE SEPTEMBER 8 BUSTS CARRY THEIR STAMP; THE FOUR DUELS ARE REFUNDED (2026-10-02)
 *
 * After #5754 launched the 26 September 8 Spins and heads-up Sit & Gos, the
 * terminal authority refused every one: "no complete durable elimination
 * sequence". Their 37 busts were recorded before the knockout door's
 * elimination stamp existed for them. One file stamps them as the door would
 * (in finishing order) and pays nobody; the engine's finish lane pays. The
 * four duel satellites, whose seat can no longer be delivered, are cancelled
 * through the audited cancellation authority with every entry refunded.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const strip = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');

const STAMP = readFileSync(
  'supabase/migrations/20261002014932_the_september_eight_busts_carry_the_elimination_stamp_their_.sql',
  'utf8'
);
const CANCEL = readFileSync(
  'supabase/migrations/20261002014954_the_four_september_eight_duel_satellites_are_cancelled_and_e.sql',
  'utf8'
);
const stamp = strip(STAMP);
const cancel = strip(CANCEL);

const SATELLITES = ['097e3601', '20c75b67', '92c93927', 'a4262ba0'];

describe('the September 8 busts carry the elimination stamp their door would have given', () => {
  it('declares a live proof and names exactly the 37 unstamped busts of the 26 events', () => {
    expect(STAMP).toMatch(/^-- @live-proof: .+elimination_sequence IS NULL\) = 0$/m);
    const rows = [
      ...stamp.matchAll(
        /\{"t":"([0-9a-f-]{36})","p":"[0-9a-f-]{36}","u":"[0-9a-f-]{36}","pos":[23],"at":"2026-09-08 [0-9:.]+\+00"\}/g
      ),
    ];
    expect(rows).toHaveLength(37);
    expect(new Set(rows.map((m) => m[1])).size).toBe(26);
    for (const satellite of SATELLITES) expect(stamp).not.toContain(satellite);
  });

  it('writes only the stamp, through the acquisition the trigger permits, in finishing order', () => {
    expect(stamp).toContain("md5(p.prosrc) = 'e52754fd9e6368b107afef685e283b37'");
    expect(stamp).toContain("nextval('public.tournament_player_elimination_sequence'::regclass)");
    expect(stamp).toContain('SET elimination_sequence = v_anchor - v_k');
    expect(stamp).toMatch(/ORDER BY \(e->>'at'\)::timestamptz, \(e->>'p'\)::uuid LOOP/);
    const updates = [...stamp.matchAll(/UPDATE public\.tournament_players\s+SET ([a-z_]+)/g)];
    expect(updates.map((m) => m[1])).toEqual(['elimination_sequence', 'elimination_sequence']);
    for (const forbidden of [
      'fn_complete_tournament_terminal(',
      'fn_settle_tournament_places(',
      'INSERT INTO public.tournament_payouts',
      'UPDATE public.tournament_escrow',
      'UPDATE public.tournaments',
      'ca.break_window_migration_override',
      'pg_sleep',
    ]) {
      expect(stamp).not.toContain(forbidden);
    }
    expect(stamp).toContain('SEP8_STAMP_ROW_PREIMAGE');
    expect(stamp).toContain('SEP8_STAMP_POSTIMAGE');
    expect(stamp).toContain('fn_ca_break_window_refuses_migrations(now())');
    expect((stamp.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((stamp.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });
});

describe('the four September 8 duel satellites are cancelled and every entry refunded', () => {
  it('declares a live proof and names exactly the four duels and their eight entries', () => {
    expect(CANCEL).toMatch(/^-- @live-proof: .+\) = 4$/m);
    const rows = [
      ...cancel.matchAll(
        /\{"t":"([0-9a-f]{8})-[0-9a-f-]{27}","p":"[0-9a-f-]{36}","u":"[0-9a-f-]{36}","gross":(150\.00|15\.00),"prize":(142\.50|14\.25),"fee":(7\.50|0\.75)\}/g
      ),
    ];
    expect(rows).toHaveLength(8);
    expect([...new Set(rows.map((m) => m[1]))].sort()).toEqual(SATELLITES);
    expect(cancel).toContain('<> 390.00');
  });

  it('cancels only through the audited authority and writes no money row itself', () => {
    expect(cancel).toContain("md5(p.prosrc) = '0aea21224182e48dc5a466e4592a09e4'");
    expect(cancel).toContain('public.atomic_cancel_tournament(v_ev.tournament_id, NULL)');
    expect(cancel).toContain(`set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    for (const forbidden of [
      'INSERT INTO',
      'UPDATE public.',
      'DELETE FROM',
      'fn_settle_tournament_refund_exact(',
      'FOR UPDATE',
      'ca.break_window_migration_override',
      'pg_sleep',
    ]) {
      expect(cancel).not.toContain(forbidden);
    }
    expect(cancel).toContain('SEP8_DUEL_CANCEL_PREIMAGE');
    expect(cancel).toContain('SEP8_DUEL_CANCEL_POSTIMAGE');
    expect((cancel.match(/^BEGIN;$/gm) ?? []).length).toBe(1);
    expect((cancel.match(/^COMMIT;$/gm) ?? []).length).toBe(1);
  });
});
