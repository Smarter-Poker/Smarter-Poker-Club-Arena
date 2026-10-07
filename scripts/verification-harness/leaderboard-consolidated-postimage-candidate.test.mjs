// Source identity contracts only. No PostgreSQL client or runtime proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assembleConsolidatedCandidate,
  loadReviewedInputs,
  reviewedOutputHash,
} from './leaderboard-consolidated-migration-candidate.mjs';
const sql = readFileSync(
  new URL('./leaderboard-consolidated-postimage-candidate.sql', import.meta.url),
  'utf8'
);
const installer = assembleConsolidatedCandidate(loadReviewedInputs());
test('each of eight exact generated function bodies has independently derived post-image identity', () => {
  assert.equal(createHash('sha256').update(installer).digest('hex'), reviewedOutputHash);
  const definitions = [
    ...installer.matchAll(
      /CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\)([\s\S]*?)AS (\$\w*\$)([\s\S]*?)\4;/g
    ),
  ];
  assert.equal(definitions.length, 8);
  assert.equal(new Set(definitions.map((m) => m[1])).size, 8);
  for (const m of definitions) {
    const hash = createHash('md5').update(m[5]).digest('hex');
    const args = m[2].trim()
      ? m[2]
          .split(',')
          .map((arg) => arg.trim().split(/\s+/)[1])
          .join(',')
      : '';
    const line = sql.split('\n').filter((line) => line.includes(`('public.${m[1]}(${args})'`));
    assert.equal(line.length, 1, `Exact signature ${m[1]}`);
    assert.ok(line[0].includes(`'${hash}'`), `Body hash ${m[1]}`);
    assert.ok(
      line[0].includes(/SECURITY DEFINER/i.test(m[3]) ? ',true,' : ',false,'),
      `Security ${m[1]}`
    );
    assert.ok(line[0].includes(/\bSTABLE\b/i.test(m[3]) ? "'s'" : "'v'"), `Volatility ${m[1]}`);
  }
});
test('post-image requires actual metadata/security/index/trigger equality before fixed receipt', () => {
  assert.equal(sql.match(/^BEGIN;$/gm)?.length, 1);
  assert.equal(sql.match(/^ROLLBACK;$/gm)?.length, 1);
  assert.doesNotMatch(sql, /^COMMIT;|^CREATE|^ALTER|^INSERT|^UPDATE|^DELETE/m);
  for (const text of [
    "session_user<>'leaderboard_qualification_bootstrap'",
    'inet_server_addr() IS NOT NULL',
    "current_database()<>'postgres'",
    "actual.owner_name IS DISTINCT FROM 'postgres'",
    'actual.proconfig IS DISTINCT FROM',
    'a.is_grantable',
    'a.grantor',
    'a.grantee=0',
    'aclexplode(a.attacl)',
    'pg_policy',
    'actual.relrowsecurity',
    'i.indisprimary',
    'i.indisvalid',
    'i.indisready',
    'pg_get_indexdef',
    'trigger_count<>10',
    "t.tgenabled='O'",
    't.tgqual IS NULL',
    "'public.fn_refuse_leaderboard_basis_mutation()'::regprocedure",
    'EXCEPT SELECT id FROM public.clubs',
    "fn_leaderboard_period_window('weekly',0)",
    "fn_leaderboard_period_window('monthly',0)",
    "'45b3a6ffbacfac889d78ff126953c806'",
    "'8f2b1c2ff47e45431be6fee4639f9cb8'",
  ])
    assert.ok(sql.includes(text), text);
  assert.match(sql, /END;\n\$verify\$;\nSELECT 'CONSOLIDATED_POSTIMAGE\|PASS';\nROLLBACK;/);
  for (const table of [
    'leaderboard_complete_captures',
    'leaderboard_capture_counters',
    'leaderboard_round_basis_receipts',
  ])
    assert.ok(sql.includes(`OR EXISTS(SELECT 1 FROM public.${table})`));
});
