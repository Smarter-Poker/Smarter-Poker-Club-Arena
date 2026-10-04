/**
 * A DEAD ORIGIN'S ORIGINALS ARE DISPOSED BY THE SUCCESSOR THAT HOLDS THE EVENT (2026-10-04)
 *
 * Fifteen RUNNING events dealt nothing after 23:43Z on 2026-10-03. Each mixed
 * custody transfer was prepared during a database stall with one original
 * hand in the air, and the process holding the originals was replaced before
 * any reached a terminal disposition. Twelve originals were reserved, dealt
 * and never committed; three had no permit row at all (their begin never
 * reached the database). Every successor admission was refused
 * F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED (engine:
 * f06_mixed_successor_custody_unproven) because only the dead origin could
 * dispose them, and nothing in the live path ever did: each previous
 * occurrence (09-26, 09-28, 10-01) was cleared by an operator migration.
 *
 * 20261004125152 lets the snapshot witness a never-begun permit by its
 * recorded absence, lets the reviewed stranded void count that absence, and
 * gives the successor (live protocol-2 lease at the transfer's successor
 * generation) one door that records absences and runs the void.
 * GameServer.performTournamentManagerAdmission asks it before admission on
 * the durable path. This law pins each change to exactly what it says.
 *
 * docs/changelog/2026-10-04-a-dead-origins-originals-are-disposed-by-the-successor-that-holds-the-event.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261004125152_a_dead_origins_originals_are_disposed_by_the_successor_that_.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const SNAP_PRIOR = readFileSync(
  join(
    MIGRATIONS,
    '20260924225647_an_epoch_that_never_reserved_a_hand_is_witnessed_by_its_abse.sql'
  ),
  'utf8'
);
const VOID_PRIOR = readFileSync(
  join(MIGRATIONS, '20260928041447_the_last_stranded_transfers_of_the_0926_collapse_complete.sql'),
  'utf8'
);
const SNAP_SIG = 'smarter_private.f06_mixed_custody_snapshot(uuid,uuid,jsonb)';
const SNAP_PRE = '5422e7f73fdbdd34bf73d46e514e844e';
const SNAP_POST = 'c0d85cbbd162a208efe73855374e2518';
const SNAP_POST_DEF = '4a960ad8ba45a470d23b84b84a60d65f';
const VOID_PRE = '92466252b142a745157d2ba69c1aa35b';
const VOID_POST = 'f9a4e4187953347b613ac505d9828127';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function body(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  const tag = /AS (\$\w*\$)/.exec(sql.slice(start));
  expect(tag).not.toBeNull();
  const open = start + tag!.index + tag![0].length;
  return sql.slice(open, sql.indexOf(tag![1], open));
}
const SNAP = body(SQL, 'smarter_private.f06_mixed_custody_snapshot');
const VOID = body(SQL, 'public.fn_f06_void_stranded_mixed_original');
const DOOR = body(SQL, 'public.fn_f06_dispose_dead_origin_originals');
const DISPOSE = body(SQL, 'smarter_private.f06_dispose_dead_origin');

const SNAP_ADDED = ` ELSIF original_row.permit_id IS NULL THEN
 -- A permit that never reached the database is witnessed by its recorded
 -- absence (20261004125152): the f06_absent_permit_releases row fn_f06_begin_hand
 -- reads, so a begin that arrives later is refused for ever.
 SELECT jsonb_build_object('absent_release',to_jsonb(apr)) INTO witness FROM smarter_private.f06_absent_permit_releases apr
 WHERE (apr.permit_id,apr.tournament_id,apr.generation,apr.table_id,apr.hand_number)=
 ((b->>'permit_id')::uuid,t,g,(b->>'table_id')::uuid,(b->>'hand_number')::bigint);
`;
const VOID_OLD = `     OR (SELECT count(*) FROM smarter_private.f06_hand_permits o
          WHERE o.permit_id = ANY (original_ids)) <> cardinality(original_ids)`;
const VOID_NEW = `     OR (SELECT count(*) FROM smarter_private.f06_hand_permits o
          WHERE o.permit_id = ANY (original_ids))
        -- An original whose permit never reached the database counts once its
        -- absence is recorded for the origin (20261004125152); it has no hand.
        + (SELECT count(*) FROM smarter_private.f06_absent_permit_releases r
            WHERE r.permit_id = ANY (original_ids) AND r.tournament_id = t
              AND r.generation = xfer.origin_generation
              AND NOT EXISTS (SELECT 1 FROM smarter_private.f06_hand_permits o
                               WHERE o.permit_id = r.permit_id)) <> cardinality(original_ids)`;

describe("a dead origin's originals are disposed by the successor that holds the event", () => {
  it('changes the snapshot by exactly one ELSIF over exactly the live pre-image', () => {
    expect(md5(body(SNAP_PRIOR, 'smarter_private.f06_mixed_custody_snapshot'))).toBe(SNAP_PRE);
    expect(md5(SNAP)).toBe(SNAP_POST);
    expect(SNAP.split(SNAP_ADDED)).toHaveLength(2);
    expect(md5(SNAP.replace(SNAP_ADDED, ''))).toBe(SNAP_PRE);
    expect(SQL).toContain(`md5(p.prosrc) = '${SNAP_PRE}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${SNAP_POST}'`);
    // Without a recorded absence the original stays pending, as before.
    expect(SNAP).toContain(
      "IF witness IS NULL THEN pending:=pending||jsonb_build_array(x->>'table_id'); END IF;"
    );
  });

  it('changes the stranded void by exactly one comparison over exactly the live pre-image', () => {
    expect(md5(body(VOID_PRIOR, 'public.fn_f06_void_stranded_mixed_original'))).toBe(VOID_PRE);
    expect(md5(VOID)).toBe(VOID_POST);
    expect(VOID.split(VOID_NEW)).toHaveLength(2);
    expect(md5(VOID.replace(VOID_NEW, VOID_OLD))).toBe(VOID_PRE);
    expect(SQL).toContain(`md5(p.prosrc) = '${VOID_PRE}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${VOID_POST}'`);
  });

  it('opens the door only to the successor holding a live lease at the transfer successor generation', () => {
    expect(DOOR).toContain(
      'PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation);'
    );
    expect(DOOR).toContain('xfer.successor_generation IS DISTINCT FROM p_lease_generation');
    expect(DOOR).toContain(
      'PERFORM smarter_private.f06_authority(p_tournament_id, p_lease_generation, false);'
    );
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION public.fn_f06_dispose_dead_origin_originals(uuid, uuid, uuid)\n  FROM PUBLIC, anon, authenticated;'
    );
    expect(SQL).toContain(
      'GRANT EXECUTE ON FUNCTION public.fn_f06_dispose_dead_origin_originals(uuid, uuid, uuid)\n  TO service_role;'
    );
    expect(SQL).toContain(
      'REVOKE ALL ON FUNCTION smarter_private.f06_dispose_dead_origin(uuid)\n  FROM PUBLIC, anon, authenticated, service_role;'
    );
  });

  it('records an absence only under the lane, with no other holder and no start witness of that hand or later', () => {
    const lane = DISPOSE.indexOf('PERFORM smarter_private.f06_try_lane(xfer.tournament_id);');
    const owned = DISPOSE.indexOf("RAISE EXCEPTION 'F06_STRANDED_EVENT_OWNED'");
    const insert = DISPOSE.indexOf('INSERT INTO smarter_private.f06_absent_permit_releases');
    expect(lane).toBeGreaterThan(0);
    expect(owned).toBeGreaterThan(lane);
    expect(insert).toBeGreaterThan(owned);
    for (const witness of [
      'smarter_private.f06_hand_permits h WHERE h.table_id = tab AND h.hand_number >= hn',
      'smarter_private.f06_hand_dispatch d WHERE d.permit_id = pid',
      'public.hand_atomic_commits h WHERE h.table_id = tab AND h.hand_number >= hn',
      'public.hand_history h WHERE h.table_id = tab AND h.hand_number >= hn',
      'public.hand_state_snapshots h WHERE h.table_id = tab AND h.hand_number >= hn',
      'public.hand_private_state h WHERE h.table_id = tab AND h.hand_number >= hn',
      'public.table_hole_cards h WHERE h.table_id = tab AND h.hand_number >= hn',
    ])
      expect(DISPOSE).toContain(witness);
    // The reserved hands go through the reviewed void, never a new chip path.
    expect(DISPOSE).toContain(
      'v_void := public.fn_f06_void_stranded_mixed_original(xfer.tournament_id);'
    );
    expect(DISPOSE).not.toMatch(/UPDATE\s+public\.(table_seats|tournament_players|wallets)/i);
  });

  it('keeps the release contract pins and the shared-hand lane on the snapshot post-image', () => {
    const publisher = readFileSync(
      join(ROOT, 'server/scripts/engine-release-database-proof.py'),
      'utf8'
    );
    const fixture = JSON.parse(
      readFileSync(
        join(ROOT, 'tests/fixtures/legacy-engine-checkpoint/mixed-custody-contract.json'),
        'utf8'
      )
    ) as { functions: { signature: string; body_md5: string; definition_md5: string }[] };
    const pinned = fixture.functions.find((f) => f.signature === SNAP_SIG);
    expect(pinned?.body_md5).toBe(SNAP_POST);
    expect(pinned?.definition_md5).toBe(SNAP_POST_DEF);
    expect(publisher).toContain(`'body_md5': '${SNAP_POST}'`);
    expect(publisher).toContain(`'definition_md5': '${SNAP_POST_DEF}'`);
    expect(publisher).not.toContain(SNAP_PRE);
    const lane = readFileSync(
      join(ROOT, 'scripts/ci/probes/f06-shared-hand-lane/historical_bank_qualification.py'),
      'utf8'
    );
    expect(lane).toContain(FILE);
    expect(lane).toContain(`'${SNAP_SIG} ${SNAP_POST} ${SNAP_POST_DEF}'`);
  });

  it('the successor asks the door before admission, only on the durable path', () => {
    const server = readFileSync(join(ROOT, 'server/src/GameServer.ts'), 'utf8');
    const ask = server.indexOf('await disposeDeadOriginMixedF06Originals(');
    const admit = server.indexOf(
      'await admitMixedF06Transfer(tournamentId, lease.leaseGeneration, durableMixed)'
    );
    expect(ask).toBeGreaterThan(0);
    expect(admit).toBeGreaterThan(ask);
    expect(server).toContain(
      'if (!packet && durableMixed && mixedF06PendingOriginals(durableMixed).length > 0) {'
    );
    const custody = readFileSync(join(ROOT, 'server/src/tournament/mixedF06Custody.ts'), 'utf8');
    expect(custody).toContain("supabase.rpc('fn_f06_dispose_dead_origin_originals'");
    expect(custody).toContain('runWithTournamentDataAuthority(');
  });

  it('is one transaction with a lock timeout, and is the newest definition of each body', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain("SET LOCAL lock_timeout = '2s';");
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) => {
        const text = readFileSync(join(MIGRATIONS, f), 'utf8');
        return (
          text.includes('FUNCTION smarter_private.f06_mixed_custody_snapshot(') ||
          text.includes('FUNCTION public.fn_f06_void_stranded_mixed_original(') ||
          text.includes('FUNCTION public.fn_f06_dispose_dead_origin_originals(')
        );
      });
    expect(later).toEqual([]);
  });
});
