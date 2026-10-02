/**
 * A MIXED ADMISSION ACCEPTS THE DISPATCH ITS DISPOSED ORIGINAL LEFT BEHIND (2026-10-02)
 *
 * MTT 3414f268 and SNG a59d7bbb dealt nothing after 23:15Z on 2026-10-01. Each
 * mixed custody transfer was prepared while one original hand was in
 * dispatch, so canonical_proof.hand_dispatch held that original's row. The
 * hands then finished (permits accepted, dispatch rows gone): the one legal
 * change before admission. fn_f06_admit_mixed_manager_custody compared
 * hand_dispatch with the rest of the snapshot, so every successor admission
 * was refused F06_MIXED_CANONICAL_CHANGED (engine:
 * f06_mixed_successor_custody_unproven), and the unadmitted transfers held
 * the F06 preparation barrier so no maintenance break could certify.
 *
 * 20261002023035 compares hand_dispatch without exactly the rows of this
 * transfer's bound originals. This law pins that comparison, that nothing
 * else in the admission moved, and that the release contract pins carry the
 * post-image the migration installs.
 *
 * docs/changelog/2026-10-02-a-mixed-admission-accepts-the-dispatch-its-disposed-original-left-behind.md
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const FILE = '20261002023035_a_mixed_admission_accepts_the_dispatch_its_disposed_original.sql';
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf8');
const SIG = 'public.fn_f06_admit_mixed_manager_custody(uuid,uuid,uuid,jsonb)';
const PRE_MD5 = 'aeaabb44975b8d138ed447687b0aea22';
const PRE_DEF_MD5 = '3b047e7502c62bff570cd6253e85a741';
const POST_MD5 = '70ec2492f10256458996947f4e7be51f';
const POST_DEF_MD5 = '1468813b11c2d5f8560e3a4e29bc3a91';
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

const OLD =
  " IF canonical-ARRAY['originals','original_evidence','pending_original_tables'] IS DISTINCT FROM\n" +
  " prior.canonical_proof-ARRAY['originals','original_evidence','pending_original_tables'] THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;";
const beside = (side: string) =>
  `(SELECT COALESCE(jsonb_agg(d ORDER BY n),'[]') FROM jsonb_array_elements(${side}->'hand_dispatch') WITH ORDINALITY x(d,n) WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(prior.local_proof->'engines') e WHERE e#>>'{permit,binding,permit_id}'=d->>'permit_id'))`;
const NEW =
  " IF canonical-ARRAY['originals','original_evidence','pending_original_tables','hand_dispatch'] IS DISTINCT FROM\n" +
  " prior.canonical_proof-ARRAY['originals','original_evidence','pending_original_tables','hand_dispatch']\n" +
  ` OR ${beside('canonical')} IS DISTINCT FROM\n ${beside('prior.canonical_proof')} THEN RAISE EXCEPTION 'F06_MIXED_CANONICAL_CHANGED'; END IF;`;

function body(sql: string): string {
  const start = sql.indexOf(
    'CREATE OR REPLACE FUNCTION public.fn_f06_admit_mixed_manager_custody('
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$function$', start) + '$function$'.length;
  return sql.slice(open, sql.indexOf('$function$', open));
}
const BODY = body(SQL);

describe('a mixed admission accepts the dispatch its disposed original left behind', () => {
  it('installs exactly the reviewed body over exactly the live pre-image', () => {
    expect(md5(BODY)).toBe(POST_MD5);
    expect(SQL).toContain(`md5(p.prosrc) = '${PRE_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${PRE_DEF_MD5}'`);
    expect(SQL).toContain(`md5(p.prosrc) = '${POST_MD5}'`);
    expect(SQL).toContain(`md5(pg_get_functiondef(p.oid)) = '${POST_DEF_MD5}'`);
  });

  it('changes only the snapshot comparison, and only for the originals own dispatch rows', () => {
    expect(BODY.split(NEW)).toHaveLength(2);
    expect(md5(BODY.replace(NEW, OLD))).toBe(PRE_MD5);
    // An original still in dispatch has no witness, so it stays pending and
    // the disposition refusal that follows the comparison is unchanged.
    expect(BODY).toContain(
      "IF canonical->'pending_original_tables' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'F06_MIXED_ORIGINAL_DISPOSITION_REQUIRED'; END IF;"
    );
  });

  it('keeps the release contract pins on the post-image', () => {
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
    const pinned = fixture.functions.find((f) => f.signature === SIG);
    expect(pinned?.body_md5).toBe(POST_MD5);
    expect(pinned?.definition_md5).toBe(POST_DEF_MD5);
    expect(publisher).toContain(`'body_md5': '${POST_MD5}'`);
    expect(publisher).toContain(`'definition_md5': '${POST_DEF_MD5}'`);
    expect(publisher).not.toContain(PRE_MD5);
    const lane = readFileSync(
      join(ROOT, 'scripts/ci/probes/f06-shared-hand-lane/historical_bank_qualification.py'),
      'utf8'
    );
    expect(lane).toContain(FILE);
    expect(lane).toContain(`${SIG} ${POST_MD5} ${POST_DEF_MD5}`);
  });

  it('is one transaction with explicit grants, and is the newest definition', () => {
    expect(SQL.match(/^BEGIN;$/gm)?.length).toBe(1);
    expect(SQL.match(/^COMMIT;$/gm)?.length).toBe(1);
    expect(SQL).toContain(`REVOKE ALL ON FUNCTION ${SIG} FROM PUBLIC, anon, authenticated;`);
    expect(SQL).toContain(`GRANT EXECUTE ON FUNCTION ${SIG} TO service_role;`);
    expect(SQL).toContain("p.proacl::text = '{postgres=X/postgres,service_role=X/postgres}'");
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith('.sql') && f > FILE)
      .filter((f) =>
        readFileSync(join(MIGRATIONS, f), 'utf8').includes(
          'FUNCTION public.fn_f06_admit_mixed_manager_custody('
        )
      );
    expect(later).toEqual([]);
  });
});
