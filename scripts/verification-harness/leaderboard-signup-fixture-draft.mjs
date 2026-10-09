// UNQUALIFIED: generates synthetic isolated SQL only; never connects to a DB.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = new URL('./leaderboard-isolated-authorization-draft.sql', import.meta.url);
const start = 'DO $mint_policy$';
const end = 'DO $matrix$';
const pinned = '41bc8d84b49fe4661acbde695cf17e74f5a51b9e087ae5f5634a54651965840c';
export function generateFixture(ids, template = readFileSync(source, 'utf8')) {
  assert.ok(Array.isArray(ids) && ids.length === 5);
  ids = ids.map((id) => {
    assert.equal(typeof id, 'string');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    return id.toLowerCase();
  });
  assert.equal(new Set(ids).size, 5);
  assert.equal(template.split(start).length, 2);
  assert.equal(template.split(end).length, 2);
  const a = template.indexOf(start),
    b = template.indexOf(end);
  assert.ok(a >= 0 && b > a);
  let section = template.slice(a, b);
  assert.equal(
    createHash('sha256').update(section).digest('hex'),
    pinned,
    'Fixture template drift requires explicit source review and requalification'
  );
  ids.forEach((id, index) => {
    const prior = `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    section = section.replaceAll(prior, id);
  });
  assert.ok(!/90000000-0000-4000-8000-/.test(section));
  assert.ok(!/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+auth\./i.test(section));
  assert.ok(!/fn_save_leaderboard|fn_publish_leaderboard|\$matrix\$/i.test(section));
  for (const [anchor, stage] of [
    ['DO $mint_policy$', 'mint-policy'],
    ['INSERT INTO public.union_creators', 'union-create'],
    ['-- Create each club in its own statement:', 'club-create'],
    ['DO $retire$', 'opening-retirement'],
    ['INSERT INTO public.union_clubs', 'union-link'],
    ['DO $membership$', 'memberships'],
  ]) {
    assert.equal(section.split(anchor).length, 2);
    section = section.replace(anchor, `\\echo ISOLATED_AUTH_FIXTURE_STAGE=${stage}\n${anchor}`);
  }
  const values = ids
    .map((id, index) => `('${id}'::uuid,'lb-real-auth-${index + 1}@smarter-poker.invalid')`)
    .join(',\n');
  return (
    `-- UNQUALIFIED SYNTHETIC FIXTURE. Never run against production.\n` +
    `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='30s';
SET LOCAL lock_timeout='5s';
CREATE TEMP TABLE signup_fixture_identity(id uuid PRIMARY KEY,email text UNIQUE);
INSERT INTO signup_fixture_identity VALUES ${values};
\\echo ISOLATED_AUTH_FIXTURE_STAGE=identity-guard
DO $guard$
BEGIN
 IF session_user <> 'leaderboard_qualification_bootstrap'
 OR current_user <> 'leaderboard_qualification_bootstrap'
 OR current_database() <> 'postgres' OR inet_server_addr() IS NOT NULL THEN
  RAISE EXCEPTION 'Signup fixture requires isolated bootstrap socket';
 END IF;
 IF (SELECT count(*) FROM auth.users) <> 5
 OR EXISTS (SELECT 1 FROM auth.users u FULL JOIN signup_fixture_identity f
   ON u.id=f.id AND u.email=f.email WHERE u.id IS NULL OR f.id IS NULL)
 OR (SELECT count(*) FROM public.profiles) <> 5
 OR EXISTS (SELECT 1 FROM public.profiles p FULL JOIN signup_fixture_identity f
   ON p.id=f.id WHERE p.id IS NULL OR f.id IS NULL)
 OR EXISTS (SELECT 1 FROM public.signup_errors)
 OR EXISTS (SELECT 1 FROM public.clubs)
 OR EXISTS (SELECT 1 FROM public.unions)
 OR EXISTS (SELECT 1 FROM public.leaderboard_reward_program_versions) THEN
  RAISE EXCEPTION 'Signup fixture requires exact actual signup identities and empty business state';
 END IF;
END;
$guard$;
` +
    section +
    `
\\echo ISOLATED_AUTH_FIXTURE_STAGE=constraints
SET CONSTRAINTS ALL IMMEDIATE;
-- Explicit committed SYNTHETIC state is needed across separate HTTP requests.
-- Only an already-qualified owned disposable runtime may execute this file.
-- Destroy that complete owned runtime after testing; do not delete receipts.
COMMIT;
`
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const parsed = JSON.parse(input);
    assert.equal(parsed.kind, 'synthetic-signup-ids');
    process.stdout.write(generateFixture(parsed.ids));
  } catch {
    console.error('Signup Fixture Draft Refused Input Or Source Drift');
    process.exitCode = 1;
  }
}
