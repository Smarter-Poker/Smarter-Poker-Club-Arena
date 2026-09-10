/**
 * THE LEASE IS NOT HELD AGAINST ITS HEARTBEAT (2026-09-10).
 *
 * Every reader that pins a tournament's engine_tournament_leases row for the
 * life of its transaction - the PostgREST pre-request hook, the hand-commit
 * settlement, the empty-table close - takes FOR KEY SHARE, never FOR SHARE.
 * FOR SHARE conflicts with the heartbeat's FOR NO KEY UPDATE renewal; a
 * manager committing hands on many tables read as busy four passes running
 * and expired itself. FOR KEY SHARE conflicts with FOR UPDATE only, which is
 * exactly what a takeover (claim_tournament_lease_v2) now takes.
 *
 * Also pins: the satellite settlement gate accepts a ticket at any member
 * club of a union-hosted target (redemption already did), and the satellite
 * conservation audit counts a cash delivery as cash, not as a funded seat.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const MIGRATIONS = path.join(process.cwd(), 'supabase/migrations');
const migrationNamed = (slug: string): string => {
  const hit = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(`_${slug}.sql`))
    .sort();
  expect(hit.length, `exactly one migration should carry the slug ${slug}`).toBe(1);
  return fs.readFileSync(path.join(MIGRATIONS, hit[0]), 'utf8');
};

const HAND = migrationNamed('a_hand_commit_does_not_hold_the_lease_against_its_own_heartb');
const TICKET = migrationNamed('a_union_ticket_is_issued_at_the_club_the_winner_plays_from');

describe('the lease is not held against its heartbeat', () => {
  it('the hand commit and the empty-table close take FOR KEY SHARE on the lease row', () => {
    expect(HAND).toContain("WHERE l.tournament_id = v_tournament_id\\n     FOR SHARE;'");
    expect(HAND).toContain("FOR KEY SHARE;'");
    expect(HAND).toContain("interval ''30 seconds''\\n   FOR SHARE;'");
  });

  it('proves no protocol-2 reader still takes FOR SHARE on engine_tournament_leases', () => {
    expect(HAND).toContain("engine_tournament_leases l\\s[^;]*FOR SHARE;'");
    expect(HAND).toContain('still take FOR SHARE on engine_tournament_leases');
  });

  it('refuses to leave FOR KEY SHARE fencing nothing: the takeover must lock FOR UPDATE', () => {
    expect(HAND).toContain(
      'the takeover no longer locks FOR UPDATE; FOR KEY SHARE would fence nothing'
    );
  });
});

describe('a union ticket is issued at the club the winner plays from', () => {
  it('the gate accepts any member club of the union the target is hosted by', () => {
    expect(TICKET).toContain('JOIN public.union_clubs uc ON uc.union_id = tt.union_id');
    expect(TICKET).toContain('uc.club_id = v_ticket_club_id');
  });

  it('a cash delivery is not a seat in the conservation audit', () => {
    expect(TICKET).toContain("a.delivery_kind IN (''seat'', ''ticket'')");
    expect(TICKET).toContain('the satellite audit still reports % finding(s) over 24h');
  });

  it('closes the refusal incidents only after reading the events as settled', () => {
    expect(TICKET).toContain("a.place = 1 AND a.delivery_kind = 'seat'");
    expect(TICKET).toContain('expected the three refused satellites to be settled, found %');
  });
});
