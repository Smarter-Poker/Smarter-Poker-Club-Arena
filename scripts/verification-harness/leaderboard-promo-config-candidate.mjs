// UNQUALIFIED disposable-only source proposal. Never executes or installs SQL.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
export const configPredecessor = new URL(
  '../../supabase/migrations/20260923143157_the_opening_seed_funds_round_one_and_an_owner_may_allow_a_cl.sql',
  import.meta.url
);
export function buildPromoConfigCandidate(source) {
  assert.equal(
    createHash('sha256').update(source).digest('hex'),
    '2cdd4a18c315290da99012c98dc244996db4de4799ffa738d11a5c82a3b88840'
  );
  function extract(header) {
    assert.equal(source.split(header).length, 2);
    const rest = source.split(header)[1];
    const end = '\n$function$;';
    assert.ok(rest.includes(end));
    return header + rest.split(end)[0] + end;
  }
  function once(text, old, next) {
    assert.equal(text.split(old).length, 2, 'Reviewed configuration anchor changed');
    return text.replace(old, () => next);
  }
  let gate = extract('CREATE OR REPLACE FUNCTION public.fn_enforce_leaderboard_program_funding()');
  gate = once(gate, '  v_opening_seed numeric := 0;\n', '');
  const seedStart = gate.indexOf('    -- THE OPENING SEED FUNDS THE OPENING PROGRAM');
  const seedEnd = gate.indexOf('\n  ELSE', seedStart);
  assert.ok(seedStart > 0 && seedEnd > seedStart);
  gate = once(
    gate,
    gate.slice(seedStart, seedEnd),
    '    -- Only the actual Promo Wallet contributes publication capacity.'
  );
  assert.doesNotMatch(gate, /club_opening_setups|v_opening_seed/);
  let publish = extract('CREATE FUNCTION public.fn_publish_leaderboard_reward_program(');
  publish = once(
    publish,
    'CREATE FUNCTION public.fn_publish_leaderboard_reward_program(',
    'CREATE OR REPLACE FUNCTION public.fn_publish_leaderboard_reward_program('
  );
  const nextPublication =
    '  SELECT program.version, program.id INTO v_current_version, v_previous_id';
  publish = once(
    publish,
    nextPublication,
    `  -- Exact historical operation replay above never creates a new program.
  -- Preserve that immutable response; refuse overlays for new publications.
  IF COALESCE(p_overlay_enabled, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROMO_ONLY|Club Bank Overlay Is Not Allowed For Leaderboard Prizes'
      USING ERRCODE = '22023';
  END IF;

${nextPublication}`
  );
  // All false-overlay hashing, immutable history and idempotent replay text
  // remains byte-identical; no opening setup or settled record is modified.
  const entries = [
    [
      'public.fn_enforce_leaderboard_program_funding()',
      '82d95908883bb20269653a348eae124e',
      '5e9daeca352e313dfd03ff960e5316b4',
    ],
    [
      'public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)',
      'ef4ab9935eb3681ba4f1ab068a8b65fd',
      '897cb1df3bb6cf38e2bb4847f3658c43',
    ],
  ];
  const guards = entries
    .map(
      ([signature, body, definition]) => `
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('${signature}')
    AND md5(p.prosrc)='${body}' AND md5(pg_get_functiondef(p.oid))='${definition}'
    AND pg_get_userbyid(p.proowner)='postgres' AND p.prosecdef
    AND p.proconfig=ARRAY['search_path=public, pg_temp']::text[]
    AND (SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ':' || a.privilege_type) FROM aclexplode(p.proacl) a)='postgres:EXECUTE,service_role:EXECUTE') THEN
    RAISE EXCEPTION 'Exact Promo configuration predecessor drift';
  END IF;`
    )
    .join('\n');
  return `-- UNQUALIFIED proposal; no installed migration version.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
DO $guard$ BEGIN
  IF session_user <> 'leaderboard_qualification_bootstrap' OR current_user <> session_user
    OR inet_server_addr() IS NOT NULL OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Disposable bootstrap socket required';
  END IF;
${guards}
END $guard$;
${gate}
${publish}
-- CREATE OR REPLACE retains original owners and execute ACLs.
COMMIT;
`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assert.equal(process.argv.length, 2);
    process.stdout.write(buildPromoConfigCandidate(readFileSync(configPredecessor, 'utf8')));
  } catch {
    console.error('Unqualified Promo configuration candidate refused: reviewed input changed');
    process.exitCode = 1;
  }
}
