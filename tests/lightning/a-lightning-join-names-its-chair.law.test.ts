import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { joinGameRefusalText } from '../../src/services/cashGameLobby';

/* Dan 2026-10-24: "WHEN YOU CLICK 'JOIN LIGHTNING' AND CONFIRM YOUR BUY IN
   AMOUNT, YOU ARE 'AUTO ASSIGNED' TO A TABLE AND SEAT, YOU DON'T PICK YOUR
   SEAT ... CURRENTLY WHEN YOU CLICK 'JOIN LIGHTNING' NOTHING HAPPENS". The
   join held a chair but named none, and a Lightning table's felt paints a pool
   room's hand, so the client had no free seat to open a buy-in on. */
const MIGRATION =
  'supabase/migrations/20261024150545_a_lightning_join_names_the_chair_it_holds_and_refuses_when_j.sql';
const sql = readFileSync(MIGRATION, 'utf8');

describe('a Lightning join names the chair it holds', () => {
  it('builds on the no-queue door and refuses a drifted source', () => {
    expect(sql).toContain("IF md5(s) <> '2ab096598d5d2240d546a08dd96094ea' THEN");
    expect(sql).toMatch(/^-- @live-proof: .*LIGHTNING NAMES ITS CHAIR/m);
    expect(sql).toMatch(/position\('LIGHTNING NAMES ITS CHAIR' IN n\) = 0/);
  });

  it('every Lightning seat answer carries seat_number; other modes carry NULL', () => {
    expect(sql).toMatch(
      /'seat_number', CASE WHEN g\.cluster_mode = 'lightning'\s+THEN public\.fn_lightning_join_chair\(h\.table_id, v_uid\) END/
    );
    expect(sql).toMatch(
      /'seat_number', CASE WHEN g\.cluster_mode = 'lightning'\s+THEN public\.fn_lightning_join_chair\(t\.id, v_uid\) END/
    );
    expect(sql).toMatch(
      /'table_opened', true,\s+'seat_number', public\.fn_lightning_join_chair\(t\.id, v_uid\)/
    );
  });

  it('the chair is a physically free one, stepping past earlier holds, and is not a client RPC', () => {
    expect(sql).toMatch(/ts\.left_at IS NULL\s+AND ts\.seat_number = n/);
    expect(sql).toMatch(/WHERE f\.rn = 1 \+ \(SELECT count\(\*\) FROM public\.table_waitlist w/);
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION public.fn_lightning_join_chair(uuid, uuid) FROM PUBLIC, anon, authenticated;'
    );
  });

  it('a stopped Lightning game refuses before any hold, and says so', () => {
    expect(sql).toMatch(
      /IF g\.cluster_mode = 'lightning' AND NOT public\.fn_lightning_joins_enabled\(g\.id\) THEN\s+RAISE EXCEPTION 'LIGHTNING_JOINS_DISABLED/
    );
    expect(joinGameRefusalText(new Error('LIGHTNING_JOINS_DISABLED: stopped'))).toBe(
      'Lightning Is Not Taking New Players Right Now.'
    );
  });

  it('treats horses and humans the same', () => {
    expect(sql).not.toMatch(/is_horse/);
  });
});
