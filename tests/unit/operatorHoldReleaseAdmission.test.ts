import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = process.cwd();
const expected = JSON.parse(
  readFileSync(`${root}/server/scripts/operator-hold-contract.json`, 'utf8')
);
function verify(payload: unknown) {
  return spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('operator_hold_proof',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.verify_operator_hold_contract(json.loads(sys.stdin.read()))`,
      `${root}/server/scripts/engine-release-database-proof.py`,
    ],
    { input: JSON.stringify(payload), encoding: 'utf8' }
  ).status;
}
describe('original operator hold release admission', () => {
  it('accepts only the complete native qualified contract', () => {
    expect(verify(expected)).toBe(0);
    const sql = readFileSync(
      `${root}/supabase/migrations/20261007154739_an_operator_pause_survives_its_engine.sql`
    );
    expect(expected.migration.sql_md5).toBe(createHash('md5').update(sql).digest('hex'));
  });
  it('refuses missing migration, loosened grants and altered native constraints', () => {
    const absent = structuredClone(expected);
    absent.migration = null;
    expect(verify(absent)).not.toBe(0);
    const grants = structuredClone(expected);
    grants.functions[0].acl += ',authenticated=X/postgres';
    expect(verify(grants)).not.toBe(0);
    const constraint = structuredClone(expected);
    constraint.tables[0].constraints[0].validated = false;
    expect(verify(constraint)).not.toBe(0);
  });
  it('refuses empty, malformed and extra function results', () => {
    for (const value of [
      null,
      {},
      [],
      { ...expected, functions: [...expected.functions, expected.functions[0]] },
    ])
      expect(verify(value)).not.toBe(0);
  });
  it('checks installation before the original release can mutate or checkpoint', () => {
    const source = readFileSync(`${root}/server/scripts/engine-release-transaction.sh`, 'utf8');
    const check = source.indexOf('--operator-hold-contract');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(
      source.indexOf('sealed desired runtime could not be restored before release work')
    );
    expect(check).toBeLessThan(source.indexOf('create_image_lease\n'));
    expect(check).toBeLessThan(source.indexOf('"$LEGACY_CHECKPOINT" "$RUN_ID"'));
    expect(source).toContain(
      'installed operator-hold authority is unqualified; new release not started'
    );
  });
});

function predecessorAdmission(source: string, capability: string) {
  const shell = readFileSync(`${root}/server/scripts/engine-release-transaction.sh`, 'utf8');
  const checkpointSha = shell.match(/^CHECKPOINT_OPERATOR_SHA=([0-9a-f]{40})$/m)?.[1];
  if (!checkpointSha) throw new Error('Maintained checkpoint identity is unreadable');
  const block = shell.slice(
    shell.indexOf('OPERATOR_PREDECESSOR_SHA='),
    shell.indexOf('# The durable unit, not the SSH session')
  );
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
CONTROL_DIR="$1/server/scripts"; CHECKPOINT_OPERATOR_SHA=${checkpointSha}; RELEASE_SEAL=seal
source="$2"; capability="$3"
die(){ echo "$*" >&2; exit 1; }
timeout(){
 shift
 case "$*" in
  'seal get desired-sha') printf '%s\\n' "$source";;
  'seal get desired-image-id') echo image;;
  *'docker image inspect'*) [ "$capability" != UNKNOWN ] || return 1; printf '%s\\n' "$capability";;
  *) return 1;;
 esac
}
${block}
echo ADMITTED
`,
      'owned-predecessor-admission',
      root,
      source,
      capability,
    ],
    { encoding: 'utf8' }
  );
}

describe('operator authority predecessor compatibility admission', () => {
  it('admits only the specifically qualified pre-store predecessor', () => {
    expect(
      predecessorAdmission('4dbbd0672dd46d86116140cde77da1bd143c6b8f', '<no value>').status
    ).toBe(0);
  });
  it('keeps historical evidence separate from the active native-qualified profile', () => {
    const current = JSON.parse(
      readFileSync(`${root}/server/scripts/operator-hold-predecessor-profile.json`, 'utf8')
    );
    const historical = JSON.parse(
      readFileSync(`${root}/server/scripts/operator-hold-predecessor-a29-profile.json`, 'utf8')
    );
    expect(current.releaseSha).toBe('4dbbd0672dd46d86116140cde77da1bd143c6b8f');
    expect(current.imageId).toBe(
      'sha256:fe7b7d681b9514ed3227ca66d39658aad8ba1eea0eb8c893ae149619216d771d'
    );
    expect(current.provenance.sourceSha256).toBe(
      '49d484d3ee962182f9c4be5a1dba216a16b3627a9b694fc75450d777867f03d4'
    );
    expect(current.runtimeNode).toBe('v22.23.2');
    expect(current.compiled).toEqual(historical.compiled);
    expect(historical.releaseSha).toBe('a29a591da2efa8acb1a67cbb93f5e67af11cfc1f');
    expect(current.provenance.scope).toContain('not_boot_or_handoff_qualification');
  });
  it('refuses historical pre-store identities instead of broadening the active profile', () => {
    expect(
      predecessorAdmission('a29a591da2efa8acb1a67cbb93f5e67af11cfc1f', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('6b1af5c5fb11b158c3c8871b93360df566ad7a49', '<no value>').status
    ).not.toBe(0);
  });
  it('refuses an unknown later pre-store publication before build or capture', () => {
    expect(predecessorAdmission('a'.repeat(40), '<no value>').status).not.toBe(0);
    expect(predecessorAdmission('a'.repeat(40), 'UNKNOWN').status).not.toBe(0);
  });
  it('keeps subsequent maintained durable-runtime images on the ordinary route', () => {
    expect(predecessorAdmission('a'.repeat(40), '1').status).toBe(0);
    expect(readFileSync(`${root}/server/Dockerfile`, 'utf8')).toContain(
      'LABEL sp.operator-hold.persistence=1'
    );
  });
});
