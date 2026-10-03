/**
 * LAW: THE LEDGER REPLAY READS ONLY THE LEGS IT IS ASKED ABOUT (2026-10-03).
 *
 * ca-ledger-replay-nightly was cancelled at its 600 s budget on 2026-10-03.
 * fn_ca_ledger_replay groups the accounts it touched by the reading each was
 * last judged at, and read EVERY journal leg since that reading once per
 * group. An idle account grouped with its own old reading cost days of the
 * whole journal: five stale readings were about 27 extra days, to explain 65
 * accounts.
 *
 * A group now reads only the legs of the entities that own its accounts,
 * through fn_ca_leg_accounts_since_snapshot_for, which is the full reader
 * with one filter per side. The felt is owned by no entity, so its group
 * keeps the full reader. On production, under one snapshot, the two readers
 * agreed on all 1,023 accounts the replay has ever read.
 *
 * What this pins:
 *   1. the entity reader is the full reader, character for character, except
 *      its name, its comment and the two entity filters, so a change to one
 *      that leaves the other behind fails here;
 *   2. the replay uses the full reader for the felt group and the entity
 *      reader otherwise, and gives a union's wallet row ids with its owners;
 *   3. everything else in the replay is the text that was live before;
 *   4. both migrations are pinned transactions, and the first proves both
 *      readers agree before it commits.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const MIGS = resolve(process.cwd(), 'supabase/migrations');
const READER = readFileSync(
  resolve(MIGS, '20261003112214_the_journal_can_be_read_for_the_accounts_that_ask.sql'),
  'utf8'
);
const REPLAY_MIG = readFileSync(
  resolve(MIGS, '20261003112219_the_ledger_replay_reads_only_the_legs_it_is_asked_about.sql'),
  'utf8'
);
const md5 = (s: string) => createHash('md5').update(s).digest('hex');

/** A declaration exactly as pg_get_functiondef prints it. */
function declaration(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} is declared`).toBeGreaterThan(-1);
  const end = sql.indexOf('$function$;', start);
  return sql.slice(start, end) + '$function$\n';
}

/** The newest declaration of a function anywhere in the migration corpus. */
function latest(name: string): { file: string; body: string } {
  const re = new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`);
  const files = readdirSync(MIGS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  for (const f of files) {
    const body = readFileSync(resolve(MIGS, f), 'utf8');
    if (re.test(body)) return { file: f, body };
  }
  throw new Error(`${name} is never declared`);
}

const FOR = declaration(READER, 'fn_ca_leg_accounts_since_snapshot_for');
const REPLAY = declaration(REPLAY_MIG, 'fn_ca_ledger_replay');

describe('the ledger replay reads only the legs it is asked about', () => {
  it('is two pinned transactions whose live proofs are the declared texts', () => {
    for (const sql of [READER, REPLAY_MIG]) {
      expect(sql.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(sql.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
      for (const c of ['PREIMAGE_CHANGED', 'AUTHORITY_CHANGED', 'RESULT_CHANGED'])
        expect(sql).toContain('LEDGER_REPLAY_WINDOW_' + c);
    }
    expect(md5(FOR)).toBe('2994dc949e5ed22c3f8f0ef832652cb8');
    expect(md5(REPLAY)).toBe('8bd897bd17bde110e610ef3d3564f25e');
    expect(READER).toMatch(/^-- @live-proof: .*'2994dc949e5ed22c3f8f0ef832652cb8'\)$/m);
    expect(REPLAY_MIG).toMatch(/^-- @live-proof: .*'8bd897bd17bde110e610ef3d3564f25e'\)$/m);
    expect(READER).toContain("IS DISTINCT FROM 'ec36a30011e62e266e3385ef407fe064'");
    expect(REPLAY_MIG).toContain("IS DISTINCT FROM 'd64b8e6eba7ad3e77766d06eb9071704'");
    // The replay refuses to run until the reader it calls is the declared one.
    expect(REPLAY_MIG).toContain("IS DISTINCT FROM '2994dc949e5ed22c3f8f0ef832652cb8' THEN");
  });

  it('the entity reader is the full reader with one filter per side', () => {
    const full = latest('fn_ca_leg_accounts_since_snapshot');
    const FULL = declaration(full.body, 'fn_ca_leg_accounts_since_snapshot');
    const expected = FULL.replace(
      'FUNCTION public.fn_ca_leg_accounts_since_snapshot(p_prev_at timestamp with time zone, p_prev_snapshot pg_snapshot)',
      'FUNCTION public.fn_ca_leg_accounts_since_snapshot_for(p_prev_at timestamp with time zone, p_prev_snapshot pg_snapshot, p_entities uuid[])'
    )
      .replace('AND l.to_entity_id IS NOT NULL', 'AND l.to_entity_id = ANY (p_entities)')
      .replace('AND l.from_entity_id IS NOT NULL', 'AND l.from_entity_id = ANY (p_entities)');
    const withoutComment = FOR.replace(
      /\n {2}\/\* THE SAME JOURNAL[\s\S]*?\*\/(?=\n {2}WITH sides AS)/,
      ''
    );
    expect(withoutComment, `${full.file} and the entity reader have drifted apart`).toBe(expected);
  });

  it('the entity reader is closed to every browser role', () => {
    const sig = 'public.fn_ca_leg_accounts_since_snapshot_for(timestamptz, pg_snapshot, uuid[])';
    expect(READER).toContain(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon, authenticated;`);
    expect(READER).toContain(`GRANT EXECUTE ON FUNCTION ${sig} TO service_role;`);
    expect(FOR).toContain('STABLE SECURITY DEFINER');
  });

  it('the felt keeps the full reader, every other group reads its own owners', () => {
    expect(REPLAY).toContain("bool_or(t.account_type = 'table_stack') AS reads_the_felt");
    expect(REPLAY).toContain('array_agg(DISTINCT t.entity_id) AS owners');
    expect(REPLAY).toMatch(
      /IF w\.reads_the_felt THEN[\s\S]*?public\.fn_ca_leg_accounts_since_snapshot\(w\.prev_at, w\.prev_snapshot::pg_snapshot\)[\s\S]*?ELSE[\s\S]*?public\.fn_ca_leg_accounts_since_snapshot_for\(w\.prev_at, w\.prev_snapshot::pg_snapshot, v_entities\)[\s\S]*?END IF;/
    );
    expect(REPLAY).toContain(
      'ARRAY(SELECT uw.id FROM public.union_wallets uw WHERE uw.union_id = ANY (w.owners))'
    );
  });

  it('both branches write the same reading, and the rest of the replay is unchanged', () => {
    const felt = REPLAY.slice(
      REPLAY.indexOf('IF w.reads_the_felt THEN'),
      REPLAY.indexOf('      ELSE\n')
    );
    const rest = REPLAY.slice(
      REPLAY.indexOf('      ELSE\n'),
      REPLAY.indexOf('      END IF;\n    END LOOP;')
    );
    const insert = (s: string) => s.slice(s.indexOf('INSERT INTO zz_replay_read'));
    expect(insert(felt)).toBe(insert(rest));
    // Outside the loop, the replay is still the one that judges by snapshot.
    expect(REPLAY).toContain("v_basis text := 'one-snapshot-v4';");
    expect(REPLAY).toContain("IF COALESCE(r.prev_basis, '') <> v_basis THEN");
    expect(REPLAY).toContain(
      "PERFORM public.fn_ca_kill_switch_trip('fn_ca_ledger_replay', v_worst,"
    );
    expect(REPLAY).toContain("SET statement_timeout TO '540s'");
  });

  it('proves both readers agree under one snapshot before it commits', () => {
    expect(READER).toContain('Both readers, one statement, so one snapshot');
    expect(READER).toContain(
      "FROM public.fn_ca_leg_accounts_since_snapshot(now() - interval '1 hour', v_snap) f"
    );
    expect(READER).toContain(
      "FROM ents, public.fn_ca_leg_accounts_since_snapshot_for(now() - interval '1 hour', v_snap, ents.a) e"
    );
    expect(READER).toContain(
      'WHERE f.net IS DISTINCT FROM e.net OR f.legs IS DISTINCT FROM e.legs;'
    );
    for (const cte of ['ents', 'accts', 'full_reader', 'entity_reader'])
      expect(READER).toContain(`${cte} AS MATERIALIZED (`);
  });

  it('is the newest replay on disk', () => {
    expect(latest('fn_ca_ledger_replay').file).toBe(
      '20261003112219_the_ledger_replay_reads_only_the_legs_it_is_asked_about.sql'
    );
  });
});
