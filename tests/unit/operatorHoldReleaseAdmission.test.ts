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
      {
        ...expected,
        functions: [...expected.functions, expected.functions[0]],
      },
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
  it('binds the selected checkpoint image to the exact measured predecessor profile', () => {
    const shell = readFileSync(`${root}/server/scripts/legacy-engine-checkpoint.sh`, 'utf8');
    const start = shell.indexOf('case "$LEGACY_SHA" in');
    const end = shell.indexOf('\nesac', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const selection = shell.slice(start, end + '\nesac'.length);
    const profile = JSON.parse(
      readFileSync(`${root}/server/scripts/operator-hold-predecessor-profile.json`, 'utf8')
    );
    const admit = (release: string, image: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
LEGACY_SHA="$1"
die(){ exit 1; }
${selection}
[ "$LEGACY_IMAGE" = "$2" ]`,
          'exact-checkpoint-image',
          release,
          image,
        ],
        { encoding: 'utf8' }
      ).status;
    expect(admit(profile.releaseSha, profile.imageId)).toBe(0);
    expect(
      admit(
        profile.releaseSha,
        'sha256:80d5fc79b13b4d795d866f2b4dc3ddcd0286a993931bbaae8889fd275714912c'
      )
    ).not.toBe(0);
    expect(admit('a9e3ca8b3b6be522065476da2e9ab53e751ad132', profile.imageId)).not.toBe(0);
    expect(admit('f'.repeat(40), profile.imageId)).not.toBe(0);
  });

  it('admits only the specifically qualified pre-store predecessor', () => {
    expect(
      predecessorAdmission('9f9dcc6d55980bf96249dbd985f08c246d7006b2', '<no value>').status
    ).toBe(0);
  });
  it('keeps historical evidence separate from the active native-qualified profile', () => {
    const current = JSON.parse(
      readFileSync(`${root}/server/scripts/operator-hold-predecessor-profile.json`, 'utf8')
    );
    const historical = JSON.parse(
      readFileSync(`${root}/server/scripts/operator-hold-predecessor-a29-profile.json`, 'utf8')
    );
    expect(current.releaseSha).toBe('9f9dcc6d55980bf96249dbd985f08c246d7006b2');
    expect(current.imageId).toBe(
      'sha256:14c5afe9221b4b8b35c5a4e555b8522c5e4ca31c31d858b5a99a9507f562489b'
    );
    expect(current.provenance.sourceSha256).toBe(
      '6f6114f6d78665978a1b111b11492cbab71d18ec471a159f3cf885d57eaca2b5'
    );
    expect(current.runtimeNode).toBe('v22.23.2');
    const gameServer = current.compiled.find(
      (row: { path: string }) => row.path === '/app/dist/GameServer.js'
    );
    expect(gameServer).toEqual({
      path: '/app/dist/GameServer.js',
      bytes: 611541,
      sha256: 'd4708386037a26c85d72a8525c6a6cdca479ed0e13e8632b3129b34ebe959097',
    });
    // All fourteen expected rows come from genuine root metadata48227, not the profile under test.
    expect(current.compiled).toEqual([
      {
        bytes: 611541,
        path: '/app/dist/GameServer.js',
        sha256: 'd4708386037a26c85d72a8525c6a6cdca479ed0e13e8632b3129b34ebe959097',
      },
      {
        bytes: 530863,
        path: '/app/dist/engine/ServerTableEngineBase.js',
        sha256: '27072e1294c606c628940dd8478bafdd24cd929b3b9ea971a6be7cb1a029d92e',
      },
      {
        bytes: 111943,
        path: '/app/dist/engine/ServerTableEngineSeating.js',
        sha256: '2a9106ea7634003e9cfc1800531c45182dd792ea6ceaeee563273c15bb147ad4',
      },
      {
        bytes: 249469,
        path: '/app/dist/engine/ServerTableEngineDealing.js',
        sha256: 'd7dff692d3e06fa69f0cc57df86cb4397bbb29617ae604d8aa1eaf7c495e3823',
      },
      {
        bytes: 15468,
        path: '/app/dist/handlers/admin.js',
        sha256: '7600cf1b170b80e775691d413c8791aab3c441b09c3821c16951c06bdd67fc7e',
      },
      {
        bytes: 568882,
        path: '/app/dist/tournament/TournamentManagerBase.js',
        sha256: '95d25e403c684b4b3fe938292c7b0026735efe6825738f348dcb16889b949a57',
      },
      {
        bytes: 25463,
        path: '/app/dist/services/tableLease.js',
        sha256: 'f6483c4692c99ad4042cdd174cb99a38346a507446306684a491c986ba1d4d0e',
      },
      {
        bytes: 13939,
        path: '/app/dist/services/supabase/client.js',
        sha256: 'c27acc261be7815a4686d903b8a6cbfa2dc75e1f0bd289ab25079555f9d91f5f',
      },
      {
        bytes: 797,
        path: '/app/dist/releaseIdentity.js',
        sha256: '3386b6a5740b7f6fa936b4e1f0727199b0d661e134dcb20424e602c1d3db8c89',
      },
      {
        bytes: 291,
        path: '/app/dist/http/createEngineHttpServer.js',
        sha256: '2925b3958172cb841a1c35c205b3566b6a25e155b8e01b1acec1f961fa6b2b9b',
      },
      {
        bytes: 27163,
        path: '/app/dist/engine/ServerTableEngine.js',
        sha256: '185b993331bd71243e32c1ca9e2ff4d6d1df075fc837eed9597c3a9e539e1ce1',
      },
      {
        bytes: 130108,
        path: '/app/dist/maintenance/MaintenanceBreak.js',
        sha256: '5cd742c67380abd091bad322619c20c6ebb72d3162c477c43d91b37be0cf0f4f',
      },
      {
        bytes: 4199,
        path: '/app/dist/maintenance/freezeState.js',
        sha256: 'c962466ac1178f35a073ed265554d197c4d214467e190d83edfa2c2f4034e001',
      },
      {
        bytes: 9096,
        path: '/app/dist/services/supabase/dataActorContext.js',
        sha256: '07ff29c562d000690437b62c46c87a10adb1fc40beb54e82ad863632b7e18985',
      },
    ]);
    expect(
      current.compiled.find(
        (row: { path: string }) => row.path === '/app/dist/engine/ServerTableEngineSeating.js'
      )
    ).toEqual({
      path: '/app/dist/engine/ServerTableEngineSeating.js',
      bytes: 111943,
      sha256: '2a9106ea7634003e9cfc1800531c45182dd792ea6ceaeee563273c15bb147ad4',
    });
    expect(
      current.compiled.find(
        (row: { path: string }) => row.path === '/app/dist/engine/ServerTableEngineBase.js'
      )
    ).toEqual({
      path: '/app/dist/engine/ServerTableEngineBase.js',
      bytes: 530863,
      sha256: '27072e1294c606c628940dd8478bafdd24cd929b3b9ea971a6be7cb1a029d92e',
    });
    const previous = JSON.parse(
      readFileSync(`${root}/server/scripts/operator-hold-predecessor-4dbb-profile.json`, 'utf8')
    );
    expect(previous.releaseSha).toBe('4dbbd0672dd46d86116140cde77da1bd143c6b8f');
    expect(previous.compiled).toEqual(historical.compiled);
    expect(historical.releaseSha).toBe('a29a591da2efa8acb1a67cbb93f5e67af11cfc1f');
    expect(current.provenance.scope).toContain('not_boot_or_handoff_qualification');
  });
  it('refuses historical pre-store identities instead of broadening the active profile', () => {
    expect(
      predecessorAdmission('a9e3ca8b3b6be522065476da2e9ab53e751ad132', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('1406d401954fce9bd9212eaa69455339f9a8ac1e', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('c1deef24a4b2e3a0db6e1ccbeab05180c6991400', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('94b2ae91c3c6742b5e05bca858c62580651ee180', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('5adefba4ac868bf138bee41bda24ae4b1754e456', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('f59e0a36a08b756d23b47976cd31ecca8f8d28a3', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('aab0f1e59275489204ea2a141b66f41902177258', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('4fadb520bbf0dc1dbe346dd3447bb5ca72ab8efe', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('e16d38f3e6693f55348fd3b7a470098bbc9a51dc', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('a29a591da2efa8acb1a67cbb93f5e67af11cfc1f', '<no value>').status
    ).not.toBe(0);
    expect(
      predecessorAdmission('4dbbd0672dd46d86116140cde77da1bd143c6b8f', '<no value>').status
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
