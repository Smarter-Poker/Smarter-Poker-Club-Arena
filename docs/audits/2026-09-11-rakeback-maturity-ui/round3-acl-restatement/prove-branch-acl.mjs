import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const directory = 'docs/audits/2026-09-11-rakeback-maturity-ui/round3-acl-restatement';
const declaringPath = 'supabase/migrations/20260911072837_legacy_rakeback_closed_period_single_payer.sql';
const companionPath = 'supabase/migrations/20260911081721_legacy_round3_preserve_server_only_acl.sql';
const checkerPath = 'scripts/ci/check-definer-authorization.mjs';
const declaring = readFileSync(declaringPath, 'utf8');
const companion = readFileSync(companionPath, 'utf8');
const { unauthorisedWriters } = await import(pathToFileURL(resolve(root, checkerPath)).href);
const name = 'fn_settle_round3_agents_to_players';
const baseline = unauthorisedWriters(declaring);
assert(baseline.includes(name), 'Actual adopted declaration must reproduce the explicit grant record gate');
const combined = unauthorisedWriters(declaring, new Set(), declaring + '\n' + companion);
assert.deepEqual(combined, [], 'Actual companion must satisfy the unchanged gate');
assert(companion.includes('FROM PUBLIC, anon, authenticated;'));
const missingPublic = companion.replace('FROM PUBLIC, anon, authenticated;', 'FROM anon, authenticated;');
const publicVerdict = unauthorisedWriters(declaring, new Set(), declaring + '\n' + missingPublic);
assert(publicVerdict.includes(name), 'Omitting the PUBLIC revoke must still fail');
const laterBrowserGrant = declaring + '\n' + companion +
  '\nGRANT EXECUTE ON FUNCTION public.fn_settle_round3_agents_to_players(uuid,timestamptz,timestamptz) TO authenticated;';
const browserVerdict = unauthorisedWriters(declaring, new Set(), laterBrowserGrant);
assert(browserVerdict.includes(name), 'A later browser grant must still fail');
const inputs = [declaringPath, companionPath, checkerPath, directory + '/prove-branch-acl.mjs'].map(path => ({
  path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex')
}));
const proof = {
  observed_at_utc: new Date().toISOString(),
  inputs,
  cases: [
    { name: 'actual_a55_requires_explicit_round3_grant_record', passed: true, verdict: baseline },
    { name: 'actual_a55_plus_actual_companion_passes', passed: true, verdict: combined },
    { name: 'missing_public_revoke_refused', passed: true, verdict: publicVerdict },
    { name: 'later_authenticated_grant_refused', passed: true, verdict: browserVerdict }
  ],
  limits: 'Static exported checker proof only. The checker matches grants by function name; this does not prove arbitrary overload resolution or runtime authority. Root owns production pre/post identity readbacks.'
};
writeFileSync(directory + '/branch-acl-proof.json', JSON.stringify(proof, null, 2) + '\n');
console.log(JSON.stringify(proof, null, 2));
