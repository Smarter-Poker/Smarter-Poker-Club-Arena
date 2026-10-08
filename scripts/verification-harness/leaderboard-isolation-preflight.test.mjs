import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ownerStatements, validateRestoreScript } from './leaderboard-isolation-restore-script.mjs';
import { partitionPlainSchema } from './leaderboard-plain-schema-partition.mjs';
// The existing directly invoked preflight lane also runs startup-parity contracts.
import './leaderboard-isolation-startup-profile.test.mjs';
import './leaderboard-isolation-catalog-diagnostic.test.mjs';
import './leaderboard-isolation-acl-order.test.mjs';

const shell = fileURLToPath(new URL('./leaderboard-isolation-preflight.sh', import.meta.url));
const source = readFileSync(shell, 'utf8');
test('native schema restore compares primary and dedicated replica before and after only the long dump', () => {
  const missing = spawnSync('bash', [shell], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, DATABASE_URL: 'SYNTHETIC_PRIVATE_INPUT' },
  });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /primary export fallback is prohibited/);
  assert.doesNotMatch(
    missing.stderr + missing.stdout,
    /SYNTHETIC_PRIVATE_INPUT|Docker state|scratch parent/
  );
  const start = source.indexOf('# Keep all authoritative metadata reads on PRIMARY.');
  const end = source.indexOf('source_client 180 pg_dumpall', start);
  assert.ok(start > 0 && end > start);
  const block = source.slice(start, end);
  const parent =
    process.env.TMPDIR || (process.env.CI === 'true' ? process.env.RUNNER_TEMP : undefined);
  assert.ok(
    parent &&
      (parent.startsWith('/Volumes/SmarterWork/agent-work/') ||
        (process.env.CI === 'true' && parent === process.env.RUNNER_TEMP))
  );
  const descriptor = {
    identifier: 'kuklfnapbkmacvwxktbh-rr-us-west-2-feulx',
    database_type: 'READ_REPLICA',
    db_host: 'aws-0-us-west-2.pooler.supabase.com',
    db_port: 6543,
    db_user: 'postgres.kuklfnapbkmacvwxktbh-rr-us-west-2-feulx',
    db_name: 'postgres',
    pool_mode: 'transaction',
  };
  const primaryURL =
    'postgresql://postgres.kuklfnapbkmacvwxktbh:synthetic@aws-0-us-west-2.pooler.supabase.com:6543/postgres?sslmode=require';
  const fence = { version_num: '170006', current_wal_lsn: '2/0' };
  const admitted = {
    in_recovery: true,
    in_hot_standby: 'on',
    read_only: 'on',
    feedback: 'off',
    version_num: '170006',
    replay_lsn: '2/1',
  };
  const startup = [
    ['max_connections', '480'],
    ['max_locks_per_transaction', '64'],
    ['max_prepared_transactions', '0'],
    ['autovacuum_max_workers', '3'],
    ['max_worker_processes', '16'],
    ['max_wal_senders', '80'],
  ].map(([name, setting]) => ({ name, setting }));
  for (const scenario of [
    'success',
    'minor-success',
    'minor-drift',
    'feedback-before',
    'feedback-after',
    'promoted-before',
    'promoted-after',
    'version',
    'lag',
    'catalog-before',
    'catalog-after',
    'startup-before',
    'startup-after',
  ]) {
    const scratch = mkdtempSync(join(parent, 'leaderboard-replica-route-'));
    try {
      writeFileSync(join(scratch, 'source-before.json'), '[1]\n');
      writeFileSync(join(scratch, 'startup-before.json'), JSON.stringify(startup));
      const before = { ...admitted };
      const after = { ...admitted };
      if (scenario === 'feedback-before') before.feedback = 'on';
      if (scenario === 'feedback-after') after.feedback = 'on';
      if (scenario === 'promoted-before') before.in_recovery = false;
      if (scenario === 'promoted-after') after.in_recovery = false;
      if (scenario === 'version') before.version_num = '180001';
      if (scenario === 'minor-success' || scenario === 'minor-drift') {
        before.version_num = '170011';
        after.version_num = scenario === 'minor-success' ? '170011' : '170012';
      }
      if (scenario === 'lag') before.replay_lsn = '1/FFFFFFFF';
      const changedStartup = startup.map((row) =>
        row.name === 'max_connections' ? { ...row, setting: '100' } : row
      );
      const script = `set -euo pipefail
export PGDATABASE="$DATABASE_URL"
guards=0; catalogs=0; startups=0
failure(){ echo "$1" >&2; exit 42; }
source_failure(){ exit 43; }
source_client(){
  local client="$2"
  if [[ "$PGDATABASE" == "$DATABASE_URL" ]]; then endpoint=primary; else endpoint=replica; fi
  printf '%s|%s\\n' "$client" "$endpoint" >>"$scratch/routes"
  if [[ "$client" == pg_dump ]]; then printf dumped >"$scratch/dumped"; printf '%s' "$PLAIN_DUMP"; return; fi
  if [[ "$endpoint" == primary ]]; then printf '%s' "$FENCE"; return; fi
  guards=$((guards+1))
  if [[ "$guards" == 1 ]]; then printf '%s' "$BEFORE"; else printf '%s' "$AFTER"; fi
}
source_catalog(){
  catalogs=$((catalogs+1))
  if [[ "$SCENARIO" == "catalog-before" && "$catalogs" == 1 || "$SCENARIO" == "catalog-after" && "$catalogs" == 2 ]]; then printf '[2]\\n'; else printf '[1]\\n'; fi
}
source_startup(){
  startups=$((startups+1))
  if [[ "$SCENARIO" == "startup-before" && "$startups" == 1 || "$SCENARIO" == "startup-after" && "$startups" == 2 ]]; then printf '%s' "$CHANGED_STARTUP"; else printf '%s' "$STARTUP"; fi
}
${block}
[[ "$PGDATABASE" == "$DATABASE_URL" ]]
`;
      const result = spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          DATABASE_URL: primaryURL,
          LEADERBOARD_SCHEMA_REPLICA_DESCRIPTOR: JSON.stringify(descriptor),
          scratch,
          replica_helper: fileURLToPath(
            new URL('./leaderboard-schema-replica.mjs', import.meta.url)
          ),
          startup_helper: fileURLToPath(
            new URL('./leaderboard-isolation-startup-profile.mjs', import.meta.url)
          ),
          plain_schema_helper: fileURLToPath(
            new URL('./leaderboard-plain-schema-partition.mjs', import.meta.url)
          ),
          PLAIN_DUMP:
            'SET standard_conforming_strings = on;\nCREATE DATABASE postgres WITH TEMPLATE = template0;\nALTER DATABASE postgres OWNER TO owner;\n\\connect postgres\n',
          SCENARIO: scenario,
          FENCE: JSON.stringify(fence),
          BEFORE: JSON.stringify(before),
          AFTER: JSON.stringify(after),
          STARTUP: JSON.stringify(startup),
          CHANGED_STARTUP: JSON.stringify(changedStartup),
        },
      });
      const succeeds = scenario === 'success' || scenario === 'minor-success';
      assert.equal(result.status, succeeds ? 0 : 42, `${scenario}: ${result.stderr}`);
      const routes = readFileSync(join(scratch, 'routes'), 'utf8');
      assert.ok(routes.startsWith('psql|primary\npsql|replica\n'));
      if (succeeds)
        assert.equal(routes, 'psql|primary\npsql|replica\npg_dump|replica\npsql|replica\n');
      if (
        [
          'feedback-before',
          'promoted-before',
          'version',
          'lag',
          'catalog-before',
          'startup-before',
        ].includes(scenario)
      )
        assert.ok(!routes.includes('pg_dump'));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  assert.ok(
    source.indexOf('unset schema_replica_url replica_query LEADERBOARD_SCHEMA_REPLICA_DESCRIPTOR') <
      source.indexOf('docker network create --internal')
  );
  assert.equal(source.split('export PGDATABASE="$DATABASE_URL"').length, 2);
});
test('definition metadata is privately drift-checked before unchanged atomic restore and exact catalog', () => {
  const before = source.indexOf('>"$scratch/definitions-before.sql"');
  const dump = source.indexOf('source_client 600 pg_dump');
  const after = source.indexOf('>"$scratch/definitions-after.sql"');
  const stable = source.indexOf(
    'cmp -s "$scratch/definitions-before.sql" "$scratch/definitions-after.sql"'
  );
  const restore = source.indexOf('cat "$scratch/event-owners-elevate.sql"');
  const compare = source.indexOf('cmp -s "$scratch/source-before.json" "$scratch/isolated.json"');
  assert.ok(
    before > 0 &&
      dump > before &&
      after > dump &&
      stable > after &&
      restore > stable &&
      compare > restore
  );
  assert.equal(
    source.match(
      /source_client 30 psql -XAtq --no-password -v ON_ERROR_STOP=1 \\\n  <"\$definition_bootstrap"/g
    )?.length,
    2
  );
  for (const suffix of ['before', 'after'])
    assert.ok(source.includes(`chmod 600 "$scratch/definitions-${suffix}.sql"`));
  assert.ok(source.includes('test -s "$definition_bootstrap"'));
});
test('exact source ACL replay is private, drift guarded and precedes full catalog comparison', () => {
  const before = source.indexOf('>"$scratch/acl-before.sql"');
  const dump = source.indexOf('source_client 600 pg_dump');
  const after = source.indexOf('>"$scratch/acl-after.sql"');
  const stable = source.indexOf('cmp -s "$scratch/acl-before.sql" "$scratch/acl-after.sql"');
  const restore = source.indexOf('<"$scratch/acl-before.sql" >"$scratch/acl-restore.log"');
  const compare = source.indexOf('cmp -s "$scratch/source-before.json" "$scratch/isolated.json"');
  assert.ok(
    before > 0 &&
      dump > before &&
      after > dump &&
      stable > after &&
      restore > stable &&
      compare > restore
  );
  for (const suffix of ['before', 'after'])
    assert.ok(source.includes(`chmod 600 "$scratch/acl-${suffix}.sql"`));
  assert.ok(source.includes('test -s "$acl_bootstrap"'));
  assert.ok(source.includes("failure 'source ACL metadata changed during export'"));
  assert.ok(source.includes("destination_failure 'exact source ACL restoration failed'"));
});
test('custom extension-table trigger metadata is private, stable and captured before the atomic restore', () => {
  const before = source.indexOf('>"$scratch/extension-triggers-before.sql"');
  const after = source.indexOf('>"$scratch/extension-triggers-after.sql"');
  const stable = source.indexOf(
    'cmp -s "$scratch/extension-triggers-before.sql" "$scratch/extension-triggers-after.sql"'
  );
  const restore = source.indexOf('cat "$scratch/event-owners-elevate.sql"');
  assert.ok(before > 0 && after > before && stable > after && restore > stable);
  for (const suffix of ['before', 'after'])
    assert.ok(source.includes(`chmod 600 "$scratch/extension-triggers-${suffix}.sql"`));
  assert.ok(source.includes('test -s "$extension_trigger_bootstrap"'));
  assert.ok(source.includes("failure 'extension-table trigger metadata changed during export'"));
});
test('private source markers and exact PG17 phases disclose only validated status and enums', () => {
  for (const [input, expected] of [
    [
      'pg_dump: reading indexes\nLB_SOURCE_CLIENT_START:psql\nLB_SOURCE_CLIENT_COMPLETE:psql:2\n',
      'inner-status=2;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dumpall\npg_dump: reading indexes\nLB_SOURCE_CLIENT_COMPLETE:pg_dumpall:2\n',
      'inner-status=2;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\npg_dump: reading policies\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:2\npg_dump: reading indexes\n',
      'inner-status=2;dump-stage=policies',
    ],
    [
      'LB_SOURCE_CLIENT_COMPLETE:pg_dump:2\nLB_SOURCE_CLIENT_START:pg_dump\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\nLB_SOURCE_CLIENT_START:pg_dump\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\npg_dump: reading user-defined tables\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:2\n',
      'inner-status=2;dump-stage=tables',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\npg_dump: reading indexes\nprivate secret\n',
      'inner-status=unknown;dump-stage=indexes',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\npg_dump: reading indexes private_secret\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\nLB_SOURCE_CLIENT_COMPLETE:psql:2\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:2\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:3\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:999\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:08\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    ['LB_SOURCE_CLIENT_START:private_secret\n', 'inner-status=unknown;dump-stage=unknown'],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\npg_dump: reading dependency data\npg_dump: saving database definition\nLB_SOURCE_CLIENT_COMPLETE:pg_dump:1\n',
      'inner-status=1;dump-stage=database-definition',
    ],
    [
      'LB_SOURCE_CLIENT_START:pg_dump\npg_dump: saving database definition private_secret\n',
      'inner-status=unknown;dump-stage=unknown',
    ],
    [
      'LB_SOURCE_CLIENT_START:psql\npg_dump: saving database definition\nLB_SOURCE_CLIENT_COMPLETE:psql:1\n',
      'inner-status=1;dump-stage=unknown',
    ],
  ]) {
    const result = spawnSync('bash', [shell, '--classify-source-progress'], {
      input,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), expected);
    assert.equal(result.stderr, '');
  }
});
test('plain partitions are validated privately before destination creation without connection escape', () => {
  const partition = source.indexOf('node "$plain_schema_helper"');
  assert.ok(partition > 0 && partition < source.indexOf('docker network create --internal'));
  assert.match(source, /chmod 600 "\$scratch\/schema.sql"/);
  assert.match(source, /native plain schema partition refused/);
  assert.doesNotMatch(source, /docker[^\n]*pg_restore|archive\.list|remaining\.list/);
  assert.throws(() => partitionPlainSchema('invalid synthetic dump'));
  const parts = partitionPlainSchema(
    'SET standard_conforming_strings = on;\nCREATE DATABASE postgres WITH TEMPLATE = template0;\n\\connect postgres\nCREATE TABLE public.example(id integer);\n'
  );
  assert.match(parts.database, /CREATE DATABASE postgres/);
  assert.match(parts.remaining, /CREATE TABLE public.example/);
  for (const value of Object.values(parts)) {
    assert.doesNotMatch(value, /^\\connect/m);
    assert.doesNotThrow(() => validateRestoreScript(value));
  }
});
test('atomic archive validation preserves quoted routine bodies and refuses transaction or connection escape', () => {
  assert.doesNotThrow(() =>
    validateRestoreScript(
      '\\restrict abc123\nCREATE FUNCTION f() RETURNS void AS $fn$ BEGIN; COMMIT; END; \\connect secret $fn$ LANGUAGE plpgsql;\n\\unrestrict abc123\n'
    )
  );
  assert.doesNotThrow(() =>
    validateRestoreScript(
      "CREATE FUNCTION f() RETURNS text AS 'BEGIN; COMMIT; ''quoted'';' LANGUAGE sql; /* nested /* comment */ safe */"
    )
  );
  for (const sql of [
    'BEGIN;',
    'COMMIT;',
    'ROLLBACK;',
    'START TRANSACTION;',
    'START-- token separating comment\nTRANSACTION;',
    'START/* token separating comment */TRANSACTION;',
    'SELECT x$tag$foo; COMMIT; SELECT x$tag$foo;',
    "SELECT x$E'\\'; COMMIT; SELECT '\\';",
    "PREPARE TRANSACTION 'private';",
    '\\connect private\n',
    '\\include private\n',
    '\\restrict abc\n\\unrestrict wrong\n',
    "SELECT 'unterminated",
    'SELECT $x$unterminated',
  ])
    assert.throws(() => validateRestoreScript(sql));
  const owners = [
    {
      elevate: 'ALTER ROLE "quoted owner" SUPERUSER;',
      restore: 'ALTER ROLE "quoted owner" NOSUPERUSER;',
    },
  ];
  assert.deepEqual(ownerStatements(owners), {
    elevate: owners[0].elevate + '\n',
    restore: owners[0].restore + '\n',
  });
  assert.throws(() => ownerStatements([...owners, ...owners]));
  assert.throws(() =>
    ownerStatements([{ ...owners[0], restore: 'ALTER ROLE other NOSUPERUSER;' }])
  );
  assert.match(
    source,
    /cat "\$scratch\/event-owners-elevate.sql" "\$scratch\/remaining.sql" "\$scratch\/extension-triggers-before.sql" "\$scratch\/definitions-before.sql" "\$scratch\/event-owners-restore.sql"[\s\S]*--single-transaction[\s\S]*--file=-/
  );
  assert.match(source, /isolated catalog differs from current source/);
});
test('actual restore input prepares all private files before one transactional client and propagates failures', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'restore-stream-'));
  const pipeline = source.slice(
    source.indexOf('cat "$scratch/event-owners-elevate.sql"'),
    source.indexOf('# Replay only exact owner-bound source ACLs')
  );
  assert.ok(pipeline.includes('--single-transaction') && pipeline.includes('--file=-'));
  try {
    for (const [name, content] of [
      ['event-owners-elevate.sql', 'ELEVATE\n'],
      ['remaining.sql', 'ARCHIVE\n'],
      ['extension-triggers-before.sql', 'TRIGGERS\n'],
      ['definitions-before.sql', 'DEFINITIONS\n'],
      ['event-owners-restore.sql', 'RESTORE\n'],
    ])
      writeFileSync(join(scratch, name), content, { mode: 0o600, flag: 'wx' });
    for (const status of [0, 7]) {
      const result = spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail; scratch=$1; container=owned; bootstrap=qualification; fixture_status=$2; failure() { exit 1; }; docker() { [[ "$1" == exec && "$2" == -i && "$*" == *--single-transaction* && "$*" == *--file=-* ]] || return 9; cat; return "$fixture_status"; }; destination_failure() { exit "$3"; }; ${pipeline}`,
          'fixture',
          scratch,
          String(status),
        ],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, status);
      assert.equal(
        readFileSync(join(scratch, 'schema-restore.log'), 'utf8'),
        'ELEVATE\nARCHIVE\nTRIGGERS\nDEFINITIONS\nRESTORE\n'
      );
      assert.equal(result.stderr, '');
    }
    rmSync(join(scratch, 'remaining.sql'));
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail; scratch=$1; container=owned; bootstrap=qualification; failure() { exit 1; }; docker() { echo client-was-invoked >&2; cat; }; destination_failure() { exit "$3"; }; ${pipeline}`,
        'fixture',
        scratch,
      ],
      { encoding: 'utf8' }
    );
    assert.notEqual(result.status, 0, 'A missing private archive must fail before any client');
    assert.doesNotMatch(result.stderr, /client-was-invoked/);
  } finally {
    rmSync(scratch, { recursive: true });
  }
});
test('initdb public namespace is retained for extension installation', () => {
  const command = source.match(/-c '([^']+)' >"\$scratch\/empty-schema.log"/)?.[1];
  assert.equal(command, 'DROP EXTENSION plpgsql;');
  assert.doesNotMatch(source, /DROP SCHEMA public/);
  assert.match(source, /"\$scratch\/remaining.sql"/);
  assert.match(source, /atomic restore script validation failed/);
  assert.match(source, /isolated catalog differs from current source/);
  // Execute the actual extracted preparation SQL through a finite stub model:
  // it must remove default plpgsql but preserve the namespace pg_dump omits.
  function prepare(sql) {
    const namespaces = new Set(['public', 'pg_catalog']);
    const extensions = new Set(['plpgsql']);
    for (const statement of sql
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)) {
      if (statement === 'DROP SCHEMA public') namespaces.delete('public');
      else if (statement === 'DROP EXTENSION plpgsql') extensions.delete('plpgsql');
      else assert.fail('Unreviewed preparation statement');
    }
    return {
      namespacePresent: namespaces.has('public'),
      extensionPresent: extensions.has('plpgsql'),
    };
  }
  assert.equal(prepare('DROP SCHEMA public; DROP EXTENSION plpgsql;').namespacePresent, false);
  assert.deepEqual(prepare(command), { namespacePresent: true, extensionPresent: false });
});
test('destination refusal diagnostics retain fixed categories without private error contents', () => {
  const classifier = source.slice(
    source.indexOf('destination_error_category() {'),
    source.indexOf('if [[ "${1:-}" == \'--classify-destination-error\' ]]')
  );
  const helper = source.slice(
    source.indexOf('destination_failure() {'),
    source.indexOf('docker pull "$image"')
  );
  for (const [diagnostic, line, toc, kind] of [
    [
      'psql:/tmp/remaining.sql:9: ERROR: 42501: permission denied secret',
      '9',
      'unknown',
      'unknown',
    ],
    [
      'psql:/tmp/private-secret.sql:9: ERROR: 42501: permission denied secret',
      'unknown',
      'unknown',
      'unknown',
    ],
    ['psql:<stdin>:7: ERROR: 42501: permission denied secret', '7', 'unknown', 'unknown'],
    [
      'untrusted psql:<stdin>:7: ERROR: 42501: permission denied secret',
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'pg_restore: from TOC entry 123; 1255 987 FUNCTION private_secret owner_secret\nERROR: 42501: permission denied secret',
      'unknown',
      '123',
      'FUNCTION',
    ],
    [
      'pg_restore: from TOC entry 44; 0 0 DEFAULT ACL private_secret owner_secret\nERROR: 42501: permission denied secret',
      'unknown',
      '44',
      'DEFAULT ACL',
    ],
    [
      'untrusted pg_restore: from TOC entry 123; 1255 987 FUNCTION private_secret\nERROR: 42501: permission denied secret',
      'unknown',
      'unknown',
      'unknown',
    ],
    [
      'pg_restore: from TOC entry 123; 1255 987 PRIVATE_SECRET owner_secret\nERROR: 42501: permission denied secret',
      'unknown',
      '123',
      'unknown',
    ],
  ]) {
    const actual = spawnSync(
      'bash',
      [
        '-c',
        `${classifier}\n${helper.replace('diagnostic="$(cat "$log")"', 'diagnostic="$fixture_error"')}\nfixture_error=$1; failure() { printf '%s' "$1"; }; destination_failure 'fixed-stage' <(printf '%s' "$fixture_error") 3`,
        'fixture',
        diagnostic,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(actual.status, 0);
    assert.equal(
      actual.stdout,
      `fixed-stage (client-status=3;42501:destination-permission;stdin-line=${line};toc-entry=${toc};object-kind=${kind})`
    );
    assert.equal(actual.stderr, '');
  }
  for (const [input, expected] of [
    [
      'ERROR: 22023: extension private has no installation script nor update path for version secret',
      '22023:extension-version-unavailable',
    ],
    [
      'ERROR: 58P01: could not open extension control file private',
      '58P01:extension-control-unavailable',
    ],
    [
      'ERROR: 55000: must be loaded via shared_preload_libraries secret',
      '55000:extension-preload-required',
    ],
    [
      'ERROR: 42704: required extension private is not installed',
      '42704:extension-dependency-missing',
    ],
    ['ERROR: 3F000: schema private does not exist', '3F000:schema-missing'],
    ['ERROR: 42710: private already exists', '42710:duplicate-destination-object'],
    ['ERROR: 42501: permission denied secret', '42501:destination-permission'],
    [
      'ERROR: 53200: out of shared memory\nHINT: You might need to increase max_locks_per_transaction. private',
      '53200:shared-memory-lock-capacity',
    ],
    ['ERROR: 53200: out of shared memory private', '53200:shared-memory-unclassified'],
    ['ERROR: 53200: out of memory private', '53200:server-memory-unavailable'],
    ['ERROR: 53200: private unknown memory issue', '53200:server-memory-unclassified'],
    ['ERROR: 42501: must be owner of function private', '42501:destination-owner-required'],
    ['ERROR: 42501: must be superuser secret', '42501:destination-superuser-required'],
    [
      'ERROR: 42501: permission denied for function private',
      '42501:destination-function-permission',
    ],
    ['ERROR: 42501: permission denied for schema private', '42501:destination-schema-permission'],
    [
      'ERROR: 42501: permission denied for table pg_private',
      '42501:destination-relation-permission',
    ],
    ['ERROR: 58P01: could not load library private', '58P01:extension-library-unavailable'],
    ['ERROR: malformed secret', 'unknown:unclassified-destination'],
    ['secret configuration body', 'unknown:unclassified-destination'],
  ]) {
    const result = spawnSync('bash', [shell, '--classify-destination-error'], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), expected);
    assert.equal(result.stderr, '');
  }
  assert.match(source, /client-status=\$status;\$category/);
  assert.match(source, /VERBOSITY=verbose[^\n]*\n[^\n]*extension-restore.log/);
});
test('exact preexisting bootstrap CREATE is removed without changing role grants or attributes', () => {
  const input =
    'CREATE ROLE source_admin;\nALTER ROLE source_admin WITH SUPERUSER;\nGRANT member TO actor GRANTED BY source_admin;\n';
  const run = (role, sql) =>
    spawnSync('bash', [shell, '--prepare-roles', role], {
      input: sql,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
  assert.equal(
    run('source_admin', input).stdout,
    'ALTER ROLE source_admin WITH SUPERUSER;\nGRANT member TO actor GRANTED BY source_admin;\n'
  );
  for (const [role, sql] of [
    ['source_admin', input + 'CREATE ROLE source_admin;\n'],
    ['source_admin', input.replace('CREATE ROLE source_admin;\n', '')],
    ['source_admin; DROP ROLE actor', input],
    ['leaderboard_qualification_bootstrap', input],
  ]) {
    const result = run(role, sql);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  }
  assert.match(source, /WHERE oid=10 AND rolsuper/);
  assert.match(source, /initdb -U "\$1"/);
  assert.match(source, /isolated-bootstrap "\$source_bootstrap"/);
});
test('destination role diagnostics disclose only SQLSTATE and fixed categories', () => {
  const result = spawnSync('bash', [shell, '--classify-role-error'], {
    input: 'ERROR: 42501: must have admin option on role private_secret\nraw settings secret',
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '42501:grantor-admin-option\n');
  assert.equal(result.stderr, '');
});
const catalog = readFileSync(
  new URL('./leaderboard-isolation-catalog.sql', import.meta.url),
  'utf8'
);

test('native schema restore compares live column order and explicit publication names, not dropped physical slots', () => {
  assert.match(catalog, /row_number\(\) OVER \(PARTITION BY a\.attrelid ORDER BY a\.attnum\)/);
  assert.doesNotMatch(catalog, /a\.attname,a\.attnum,/);
  assert.match(catalog, /CASE WHEN r\.prattrs IS NULL THEN NULL ELSE/);
  assert.match(catalog, /jsonb_agg\(a\.attname ORDER BY a\.attnum\)/);
  assert.match(catalog, /a\.attnum=ANY\(r\.prattrs::smallint\[\]\) AND NOT a\.attisdropped/);
  assert.doesNotMatch(catalog, /c\.relname,r\.prattrs,/);
  // Native pg_dump omits dropped columns. This finite fixture models its
  // documented slot compaction, not an actual isolated PostgreSQL run.
  const original = [
    { name: 'first', slot: 1 },
    { name: 'last', slot: 3 },
  ];
  const restored = original.map((column, index) => ({ ...column, slot: index + 1 }));
  assert.notDeepEqual(original, restored);
  const logical = (columns) => columns.map((column, index) => [column.name, index + 1]);
  assert.deepEqual(logical(original), logical(restored));
  assert.notDeepEqual(logical(original), logical([...restored].reverse()));
  const publication = (columns, slots) =>
    columns.filter((column) => slots.includes(column.slot)).map((column) => column.name);
  assert.deepEqual(publication(original, [3]), publication(restored, [2]));
  assert.notDeepEqual(publication(original, [3]), publication(restored, [1]));
});

test('source safeguard check executes without credentials or production access', () => {
  const result = spawnSync('bash', [shell, '--check'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /safeguards checked/);
});

test('source export is schema-only and password-free, with drift and isolation refusal', () => {
  assert.match(source, /--schema-only --create --format=plain --no-password --no-subscriptions/);
  assert.match(source, /--database="\$PGDATABASE"/);
  assert.match(source, /source_client 600 pg_dump/);
  assert.match(
    source,
    /source_client 180 pg_dumpall --roles-only --no-role-passwords --no-password/
  );
  assert.match(source, /default_transaction_read_only=on/);
  assert.match(source, /source schema changed during export/);
  assert.match(source, /unset DATABASE_URL PGDATABASE PGOPTIONS/);
  assert.match(source, /docker network create --internal/);
  assert.match(source, /cron\.launch_active_jobs=off/);
  assert.ok(
    source.indexOf("-c 'DROP DATABASE postgres;'") <
      source.indexOf('shared_preload_libraries=pg_cron,pg_stat_statements')
  );
  assert.match(
    source,
    /node "\$plain_schema_helper" "\$scratch\/schema.sql" "\$scratch\/database.sql" "\$scratch\/schemas.sql"/
  );
  assert.match(source, /--dbname=template1[\s\S]*<"\$scratch\/database.sql"/);
  assert.match(source, /--single-transaction --file=-[\s\S]*<"\$scratch\/schemas.sql"/);
  const selected = partitionPlainSchema(
    "SET standard_conforming_strings = on;\nCREATE DATABASE postgres WITH TEMPLATE = template0;\nGRANT CONNECT ON DATABASE postgres TO reader;\n\\connect postgres\nCREATE SCHEMA auth;\nALTER SCHEMA auth OWNER TO owner;\nCREATE EXTENSION IF NOT EXISTS hstore WITH SCHEMA auth;\nGRANT USAGE ON SCHEMA auth TO reader;\nCREATE TABLE auth.sample(id integer);\nCOMMENT ON EXTENSION hstore IS 'retained';\n"
  );
  assert.match(selected.database, /GRANT CONNECT ON DATABASE postgres TO reader/);
  assert.match(selected.schemas, /ALTER SCHEMA auth OWNER TO owner/);
  assert.match(selected.extensions, /CREATE EXTENSION/);
  assert.doesNotMatch(selected.remaining, /CREATE DATABASE|CREATE SCHEMA|CREATE EXTENSION/);
  assert.match(selected.remaining, /GRANT USAGE ON SCHEMA auth TO reader/);
  assert.match(selected.remaining, /CREATE TABLE auth.sample/);
  assert.match(selected.remaining, /COMMENT ON EXTENSION hstore/);
  assert.match(source, /isolated catalog differs from current source/);
  assert.doesNotMatch(source, /--data-only|fn_payout_leaderboard|fn_settle_due_leaderboards/);
});

test('catalog fingerprint includes security and financial schema dependencies', () => {
  for (const category of [
    'roles',
    'memberships',
    'schemas',
    'relations',
    'columns',
    'routines',
    'constraints',
    'domain_constraints',
    'indexes',
    'triggers',
    'event_triggers',
    'policies',
    'types',
    'defaults',
    'extensions',
    'database',
    'database_settings',
    'sql_settings',
    'tablespaces',
    'publications',
    'publication_relations',
    'publication_schemas',
  ]) {
    assert.match(catalog, new RegExp(`'${category}'`));
  }
  assert.match(catalog, /relrowsecurity,c\.relforcerowsecurity,\s*CASE WHEN c\.relacl IS NULL/);
  assert.match(catalog, /prosecdef,p\.proconfig,\s*CASE WHEN p\.proacl IS NULL/);
  assert.match(catalog, /pg_get_viewdef/);
  assert.match(catalog, /pg_get_userbyid\(e\.extowner\)/);
  assert.match(catalog, /k\.conrelid=0/);
  assert.doesNotMatch(catalog, /FROM public\.|FROM auth\.|rolpassword/i);
});

test('cleanup must finish before the verdict and source entrypoints cannot initialize a server', () => {
  assert.match(source, /cleanup \|\| failure 'explicit cleanup verification failed'/);
  assert.ok(
    source.indexOf("cleanup || failure 'explicit cleanup verification failed'") <
      source.indexOf('echo "Captured schema/security')
  );
  assert.match(source, /docker run --name "\$source_container" --rm/);
  assert.match(source, /--entrypoint \/bin\/sh/);
  assert.match(source, /psql\) \/usr\/lib\/postgresql\/bin\/psql --dbname="\$PGDATABASE"/);
  assert.match(source, /pg_dump\) \/opt\/lb-native\/bin\/pg_dump --dbname="\$PGDATABASE"/);
  assert.match(
    source,
    /\[\[ "\$client" != pg_dump \]\] \|\| source_image="\$LEADERBOARD_NATIVE_BATCH_IMAGE"/
  );
  assert.match(source, /docker container ls --all --format/);
  assert.match(source, /docker network ls --format/);
  assert.doesNotMatch(source, /docker (rm|network rm).*\|\| true/);
});

test('source-client timeout escalates a TERM-resistant synthetic client without extending its deadline', () => {
  const installed = spawnSync('timeout', ['--version'], { encoding: 'utf8' });
  assert.ifError(installed.error);
  assert.equal(
    installed.status,
    0,
    'GNU timeout must be available for the executable bound regression'
  );
  assert.match(installed.stdout, /GNU coreutils/);
  const helper = source.match(/source_client\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  assert.match(helper, /timeout --kill-after=10s "\$seconds" docker run/);
  const scratch = mkdtempSync(join(tmpdir(), 'source-bound-'));
  try {
    // Finite synthetic child: TERM is ignored but native sleep exits after one second.
    // No Docker daemon, database, container PID1 or source credential is involved.
    writeFileSync(
      join(scratch, 'docker'),
      '#!/bin/bash\ntrap "" TERM\nprintf "started\\n" >&2\n/bin/sleep 1\nprintf "completed\\n"\n',
      { mode: 0o700 }
    );
    for (const escalation of [false, true]) {
      const candidate = helper.replace('--kill-after=10s ', escalation ? '--kill-after=0.1s ' : '');
      const result = spawnSync(
        'bash',
        [
          '-c',
          `${candidate}\nscratch=$1; source_container=synthetic; image=unused; source_client 0.5 psql`,
          'fixture',
          scratch,
        ],
        {
          env: { ...process.env, PATH: `${scratch}:${process.env.PATH}` },
          encoding: 'utf8',
          timeout: 3000,
          killSignal: 'SIGKILL',
        }
      );
      assert.ifError(result.error);
      assert.equal(result.status, escalation ? 137 : 124);
      assert.match(result.stderr, /^started$/m);
      assert.equal(result.stdout, escalation ? '' : 'completed\n', result.stderr);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('actual source-client connection wrapper expands URI instead of local socket defaults', () => {
  const wrapper = source.match(/'client=\$1; shift; printf[^\n]+'/)?.[0].slice(1, -1);
  assert.ok(wrapper);
  // Synthetic unreachable loopback endpoint only: no source data or credentials.
  // Use installed clients with exactly the maintained argument construction.
  const executable = wrapper
    .replaceAll('/usr/lib/postgresql/bin/', '')
    .replaceAll('/opt/lb-native/bin/', '');
  const success = spawnSync(
    'sh',
    [
      '-c',
      `psql() { printf 'synthetic-result\\n'; return 0; }; ${executable}`,
      'source-client',
      'psql',
    ],
    { encoding: 'utf8' }
  );
  assert.equal(success.status, 0);
  assert.equal(success.stdout, 'synthetic-result\n');
  assert.equal(success.stderr, 'LB_SOURCE_CLIENT_START:psql\nLB_SOURCE_CLIENT_COMPLETE:psql:0\n');
  const env = {
    PATH: process.env.PATH,
    PGHOST: '/leaderboard-qualification-nonexistent-fixture-socket',
    PGDATABASE: 'postgresql://fixture_user:fixture_password@127.0.0.1:1/postgres?connect_timeout=1',
  };
  const before = spawnSync('psql', ['-XAtq', '--no-password', '-c', 'SELECT 1;'], {
    env,
    encoding: 'utf8',
  });
  assert.equal(before.error, undefined, 'Required PostgreSQL psql client unavailable');
  assert.equal(before.status, 2);
  assert.match(before.stderr, /socket/);
  for (const client of ['psql', 'pg_dump', 'pg_dumpall']) {
    const after = spawnSync('sh', ['-c', executable, 'source-client', client, '--no-password'], {
      env,
      encoding: 'utf8',
    });
    assert.equal(after.error, undefined, 'Required shell unavailable');
    assert.notEqual(after.status, 127, `Required PostgreSQL ${client} client unavailable`);
    assert.ok(after.status !== 0);
    assert.equal(after.stdout, '');
    assert.match(after.stderr, new RegExp(`LB_SOURCE_CLIENT_START:${client}\\n`));
    assert.match(
      after.stderr,
      new RegExp(`LB_SOURCE_CLIENT_COMPLETE:${client}:${after.status}\\n`)
    );
    assert.match(after.stderr, /127\.0\.0\.1/);
    assert.doesNotMatch(after.stderr, /on socket/);
  }
});

test('source diagnostics return allowlisted categories without raw error or secrets', () => {
  const samples = [
    [
      2,
      'password authentication failed for postgres://secret:marker@private.example/db',
      'authentication',
    ],
    [2, 'could not translate host name private.example', 'name-resolution'],
    [124, 'postgres://secret:marker@private.example/db', 'bounded-timeout'],
    [137, 'secret marker', 'signal-termination'],
    [2, 'canceling statement due to statement timeout secret', 'server-statement-timeout'],
    [2, 'canceling statement due to lock timeout secret', 'server-lock-timeout'],
    [
      1,
      'canceling statement due to conflict with recovery private detail',
      'replica-recovery-conflict',
    ],
    [
      1,
      'pg_dump: error: query failed: server closed the connection unexpectedly\npg_dump: detail: Query was: SECRET_SQL',
      'source-connection-lost',
    ],
    [
      1,
      'pg_dump: error: query failed: SSL SYSCALL error: EOF detected SECRET_URI',
      'source-connection-lost',
    ],
    [
      1,
      'pg_dump: error: query failed: SSL connection has been closed unexpectedly SECRET',
      'source-connection-lost',
    ],
    [
      1,
      'pg_dump: error: query failed: SECRET_UNKNOWN_ERROR\npg_dump: detail: Query was: SECRET_SQL',
      'pg-dump-query-failure',
    ],
    [1, 'pg_dump: error: query failed: permission denied for SECRET_OBJECT', 'catalog-permission'],
    [
      1,
      'pg_dump: error: query failed: canceling statement due to statement timeout SECRET',
      'server-statement-timeout',
    ],
    [
      124,
      'pg_dump: error: query failed: server closed the connection unexpectedly SECRET',
      'bounded-timeout',
    ],
    [
      137,
      'pg_dump: error: query failed: SSL SYSCALL error: EOF detected SECRET',
      'signal-termination',
    ],
    [
      1,
      'pg_dump: detail: Query was: SECRET_SQL\nquery failed without native error prefix SECRET',
      'unclassified-source-client',
    ],
    [2, 'unrecognized raw error secret marker', 'unclassified-source-client'],
  ];
  for (const [status, input, category] of samples) {
    const result = spawnSync('bash', [shell, '--classify-source-error', String(status)], {
      input,
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), category);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /SECRET|private\.example|postgres:\/\//);
  }
});

test('actual source failure reports only bounded owned state and numeric elapsed/status', () => {
  const classifier = source.slice(
    source.indexOf('source_error_category() {'),
    source.indexOf('if [[ "${1:-}" == \'--classify-source-error\' ]]')
  );
  const helper = source.slice(
    source.indexOf('source_failure() {'),
    source.indexOf('destination_failure() {')
  );
  for (const [state, expected, marker, elapsed, inspectStatus] of [
    ['running|0|false', 'running|0|false', '2', '3', '0'],
    ['exited|137|true', 'exited|137|true', '2', '3', '0'],
    ['private-secret-state', 'unknown', '2', '3', '0'],
    ['running|0|false', 'unknown', '2', '3', '1'],
    ['running|0|false', 'unknown', '2', '3', '127'],
    ['running|0|false', 'running|0|false', 'invalid', 'unknown', '0'],
    ['running|0|false', 'running|0|false', 'missing', 'unknown', '0'],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `${classifier}\n${helper}\nSECONDS=5; scratch=/fixture; source_container=exact-owned; cat() { if [[ "$1" == /fixture/source-client-started ]]; then [[ "$fixture_marker" != missing ]] || return 1; printf '%s' "$fixture_marker"; else command cat "$@"; fi; }; timeout() { [[ "$*" == *exact-owned* ]] || exit 9; printf '%s' "$fixture_state"; return "$fixture_inspect_status"; }; failure() { printf '%s' "$1"; }; fixture_state=$1; fixture_marker=$2; fixture_inspect_status=$3; source_failure fixed-stage <(printf 'secret') 137`,
        'fixture',
        state,
        marker,
        inspectStatus,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0);
    assert.equal(
      result.stdout,
      `fixed-stage (client-status=137;elapsed-seconds=${elapsed};signal-termination;owned-source-state=${expected};inner-status=unknown;dump-stage=unknown)`
    );
    assert.equal(result.stderr, '');
  }
  assert.match(
    source,
    /timeout 10 docker inspect --format '\{\{\.State\.Status\}\}\|\{\{\.State\.ExitCode\}\}\|\{\{\.State\.OOMKilled\}\}' "\$source_container"/
  );
});

function cleanupFixture(mode, primaryStatus = 0) {
  const cleanupSource = source.slice(
    source.indexOf('cleanup_complete=false\n'),
    source.indexOf('trap on_exit EXIT\n')
  );
  assert.ok(cleanupSource.includes('cleanup() {') && cleanupSource.includes('on_exit() {'));
  // Execute the maintained cleanup/trap, not a second implementation. Only log
  // redirections change: no files, Docker daemon, source credentials or deletion.
  const executable = cleanupSource.replaceAll(/>"\$scratch\/[^"\n]+"/g, '>/dev/null');
  return spawnSync(
    'bash',
    [
      '-c',
      `
set -euo pipefail
exec 3>&1
scratch=/leaderboard-cleanup-fixture-never-created
container=fixture-owned
source_container=fixture-owned-source
network=fixture-owned-network
mode=$1
primary_status=$2
source_present=true
container_present=true
network_present=true
if [[ "$mode" == absent || "$mode" == unreadable_network ]]; then
  source_present=false; container_present=false; network_present=false
fi
docker() {
  case "$1 \${2:-}" in
    'info ') return 0 ;;
    'container inspect'|'network inspect') return 1 ;;
    'container ls')
      [[ "$mode" != unreadable_container && !( "$mode" == unreadable_container_after && "$source_present" == false ) ]] || { echo secret-diagnostic >&2; return 9; }
      [[ "$*" == 'container ls --all --format {{.Names}}' ]] || return 8
      printf '%s\\n' fixture-owned-unrelated fixture-owned-source-unrelated
      [[ "$source_present" == false ]] || echo "$source_container"
      [[ "$container_present" == false ]] || echo "$container"
      return 0 ;;
    'network ls')
      [[ "$mode" != unreadable_network && !( "$mode" == unreadable_network_after && "$network_present" == false ) ]] || { echo secret-diagnostic >&2; return 9; }
      [[ "$*" == 'network ls --format {{.Name}}' ]] || return 8
      echo fixture-owned-network-unrelated
      [[ "$network_present" == false ]] || echo "$network"
      return 0 ;;
    'rm -f')
      [[ $# == 3 && ( "$3" == "$source_container" || "$3" == "$container" ) ]] || return 8
      echo "remove:$3" >&3
      [[ "$mode" != failed_container_remove ]] || return 7
      [[ "$mode" != container_still_present ]] || return 0
      if [[ "$3" == "$source_container" ]]; then source_present=false; else container_present=false; fi ;;
    'network rm')
      [[ $# == 3 && "$3" == "$network" ]] || return 8
      echo "remove:$3" >&3
      [[ "$mode" != failed_network_remove ]] || return 7
      [[ "$mode" != network_still_present ]] || return 0
      network_present=false ;;
    *) echo 'Unexpected Docker stub invocation.' >&3; return 8 ;;
  esac
}
rm() {
  [[ $# == 3 && "$1" == -rf && "$2" == -- && "$3" == "$scratch" ]] || return 8
  echo 'remove:scratch' >&3
}
${executable}
trap on_exit EXIT
exit "$primary_status"
`,
      'cleanup-fixture',
      mode,
      String(primaryStatus),
    ],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    }
  );
}

test('actual cleanup refuses unreadable inventories and cannot certify unknown absence', () => {
  for (const mode of [
    'unreadable_container',
    'unreadable_network',
    'unreadable_container_after',
    'unreadable_network_after',
  ]) {
    const result = cleanupFixture(mode);
    assert.equal(result.status, 1, `${mode}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /Cleanup refused:/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-diagnostic|remove:scratch/);
  }
});

test('actual cleanup verifies absent or removed exact-owned resources only', () => {
  const absent = cleanupFixture('absent');
  assert.equal(absent.status, 0, absent.stderr);
  assert.equal(absent.stdout, 'remove:scratch\n');
  const removed = cleanupFixture('remove');
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(
    removed.stdout,
    'remove:fixture-owned-source\nremove:fixture-owned\nremove:fixture-owned-network\nremove:scratch\n'
  );
});

test('actual cleanup rejects failed removal and successful removal with a still-present resource', () => {
  for (const mode of [
    'failed_container_remove',
    'container_still_present',
    'failed_network_remove',
    'network_still_present',
  ]) {
    const result = cleanupFixture(mode);
    assert.equal(result.status, 1, `${mode}: ${result.stdout} ${result.stderr}`);
    assert.match(result.stderr, /Cleanup failed:/);
    assert.doesNotMatch(result.stdout, /remove:scratch/);
  }
});

test('actual exit trap preserves the primary failure when cleanup fails or succeeds', () => {
  for (const mode of ['unreadable_container', 'failed_network_remove', 'remove']) {
    const result = cleanupFixture(mode, 37);
    assert.equal(result.status, 37, `${mode}: ${result.stdout} ${result.stderr}`);
  }
});
