import assert from 'node:assert/strict';
import { roleNativeInputs, RoleNativeOwner, lastCommand, digest } from './role-native-protocol.mjs';
import {
  withHeldFixtureRoleAlignmentClient,
  renderFixtureRoleAlignmentSql,
} from './role-alignment-render.mjs';

const markers = Object.freeze({
  middle: '-- schema-owners-and-exact-grants\n',
  late: '-- twenty-one-missing-default-acl-entries\n',
  final: '-- exact-postimage-and-commit\n',
});
export function splitRoleFaultSource(rendered, stage) {
  assert.ok(Object.hasOwn(markers, stage));
  const marker = markers[stage];
  assert.equal(rendered.split(marker).length, 2, 'FIXTURE_ROLE_NATIVE_UNIQUE_BOUNDARY');
  const offset = rendered.indexOf(marker);
  return [rendered.slice(0, offset), rendered.slice(offset)];
}
const catalogFaults = Object.freeze({
  'extra-role': 'CREATE ROLE fixture_role_fault NOLOGIN',
  flags: 'ALTER ROLE anon BYPASSRLS',
  settings: "ALTER ROLE anon SET statement_timeout='4011ms'",
  membership: 'GRANT anon TO dashboard_user',
  'schema-owner': 'ALTER SCHEMA auth OWNER TO postgres',
  'schema-acl': 'GRANT CREATE ON SCHEMA auth TO anon',
  'default-acl':
    'ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA auth GRANT ALL ON TABLES TO anon',
  // Deliberate transactional catalog corruption, only in the owned fault
  // fixture. These do not implement or impersonate an extension provider.
  'extension-version':
    "UPDATE pg_extension SET extversion='fixture-fault-version' WHERE extname='pg_cron'",
  'extension-owner':
    "UPDATE pg_extension SET extowner=(SELECT oid FROM pg_roles WHERE rolname='postgres') WHERE extname='pg_cron'",
});
export const roleFaultCases = Object.freeze([
  ...['entry', 'final'].flatMap((stage) =>
    Object.keys(catalogFaults).map((fault) => ({
      name: stage + '-' + fault,
      stage,
      fault,
      refusal:
        stage === 'entry'
          ? 'FIXTURE_FULL_ROLE_PREIMAGE_REQUIRED'
          : 'FIXTURE_FULL_ROLE_POSTIMAGE_REQUIRED',
    }))
  ),
  ...['middle', 'late'].map((stage) => ({
    name: stage + '-statement-error',
    stage,
    fault: 'statement-error',
    sqlstate: '22012',
  })),
  ...['entry', 'final'].flatMap((stage) =>
    [
      'absent',
      'replacement',
      'extra-client',
      'idle-transaction',
      'active',
      'other-database',
      'prepared',
      'cron-job',
    ].map((fault) => ({
      name: stage + '-' + fault,
      stage,
      fault,
      refusal: 'FIXTURE_QUIESCENT_INSTALLATION_REQUIRED',
    }))
  ),
]);
const passwordSql = 'SELECT rolname,rolpassword FROM pg_authid ORDER BY rolname';
export const roleFaultSteps = Object.freeze([
  'source',
  'connect-application',
  'native-preimage',
  'connect-installer',
  'password-before',
  'bind-application',
  'render-installer',
  'install-prefix',
  'fault-injection',
  'expected-refusal',
  'rollback',
  'close-case',
  'rollback-prepared',
  'backends-absent',
  'catalog-restored',
  'password-restored',
  'close-observer',
  'close-all',
]);
export function retainRoleFaultFailure(proof, step, error) {
  if (Object.hasOwn(proof, 'failure_step')) return;
  // Enumerated metadata only. Never copy messages, SQL, stacks or error detail.
  proof.failure_step = roleFaultSteps.includes(step) ? step : 'unobserved';
  proof.failure_type = [
    'Error',
    'AssertionError',
    'TypeError',
    'RangeError',
    'AbortError',
    'TimeoutError',
    'error',
  ].includes(error?.name)
    ? error.name
    : 'unknown';
  proof.sqlstate =
    typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
}

// Every expected fault remains a failed installation. Passing this matrix means
// only that these explicit refusals rolled back; no retry or partial install.
export async function qualifyRoleNativeFaults({ Client, password, signal, deadlineMs = 120000 }) {
  const owner = new RoleNativeOwner(Client, { password, signal, deadlineMs });
  const inputs = await owner.bounded(roleNativeInputs);
  const native = inputs['role-alignment-native.json'];
  const template = inputs['role-alignment-installer.sql'];
  const proof = {
    scope: 'native-role-fault-matrix',
    status: 'failed',
    stage: 'source',
    cases: [],
    all_clients_closed: false,
    production_or_funded: false,
    commit_transport_faults_qualified: false,
  };
  let step = 'source';
  try {
    for (const spec of roleFaultCases) {
      proof.stage = spec.name;
      step = 'connect-application';
      const app = await owner.connect('postgres');
      step = 'native-preimage';
      await owner.snapshot(native, app.client.processID);
      step = 'connect-installer';
      const installer = await owner.connect('supabase_admin');
      step = 'password-before';
      const passwordBefore = digest(
        JSON.stringify((await owner.query(installer, passwordSql)).rows)
      );
      const extras = [];
      let active,
        prepared = false,
        refused = false;
      try {
        try {
          step = 'bind-application';
          await withHeldFixtureRoleAlignmentClient(app.client, async (binding) => {
            step = 'render-installer';
            const rendered = renderFixtureRoleAlignmentSql(template, {
              password,
              clientBinding: binding,
            });
            let suffix = rendered;
            step = 'install-prefix';
            if (spec.stage !== 'entry') {
              const [prefix, rest] = splitRoleFaultSource(rendered, spec.stage);
              await owner.query(installer, prefix);
              suffix = rest;
              // The exact prefix's first guard already cached activity. Read it
              // again, then change the held client: the final guard must refresh.
              await owner.query(installer, 'SELECT count(*) FROM pg_stat_activity');
            } else {
              // Execute the original BEGIN/settings exactly once before injection.
              const at = rendered.indexOf('DO $owned$\n');
              assert.ok(at > 0);
              await owner.query(installer, rendered.slice(0, at));
              suffix = rendered.slice(at);
            }
            step = 'fault-injection';
            if (catalogFaults[spec.fault]) await owner.query(installer, catalogFaults[spec.fault]);
            if (spec.fault === 'statement-error') suffix = 'SELECT 1 / 0';
            if (['absent', 'replacement'].includes(spec.fault)) await owner.close(app);
            if (['replacement', 'extra-client'].includes(spec.fault))
              extras.push(await owner.connect('postgres'));
            if (spec.fault === 'other-database')
              extras.push(await owner.connect('supabase_admin', { database: 'postgres' }));
            if (spec.fault === 'idle-transaction') await owner.query(app, 'BEGIN');
            if (spec.fault === 'active') {
              active = app.client.query('SELECT pg_sleep(20)').catch(() => undefined);
              let observed = false;
              for (let n = 0; n < 20; n++) {
                const row = (
                  await owner.query(installer, 'SELECT state FROM pg_stat_activity WHERE pid=$1', [
                    app.client.processID,
                  ])
                ).rows[0];
                if (row?.state === 'active') {
                  observed = true;
                  break;
                }
                await owner.query(installer, 'SELECT pg_stat_clear_snapshot()');
                await owner.bounded(() => new Promise((resolve) => setTimeout(resolve, 20)));
              }
              assert.ok(observed, 'FIXTURE_ROLE_NATIVE_ACTIVE_NOT_OBSERVED');
            }
            if (spec.fault === 'prepared') {
              await owner.query(app, 'BEGIN');
              await owner.query(app, "PREPARE TRANSACTION 'fixture-role-fault-prepared'");
              prepared = true;
            }
            if (spec.fault === 'cron-job')
              await owner.query(
                installer,
                `INSERT INTO cron.job(schedule,command,nodename,nodeport,database,username,active)
              VALUES('* * * * *','SELECT 1','localhost',5432,current_database(),'postgres',false)`
              );
            step = 'expected-refusal';
            try {
              await owner.query(installer, suffix);
            } catch (error) {
              if (
                error.code !== (spec.sqlstate || 'P0001') ||
                (!spec.sqlstate && error.message !== spec.refusal)
              ) {
                retainRoleFaultFailure(proof, step, error);
              }
              if (spec.sqlstate) assert.equal(error.code, spec.sqlstate);
              else {
                assert.equal(error.code, 'P0001');
                assert.equal(error.message, spec.refusal);
              }
              refused = true;
            }
            assert.ok(refused, 'FIXTURE_ROLE_NATIVE_EXPECTED_REFUSAL');
            step = 'rollback';
            lastCommand(await owner.query(installer, 'ROLLBACK', undefined, true), 'ROLLBACK');
          });
        } catch (error) {
          // The unchanged opaque binding correctly rejects intentional end.
          // Accept only after the SQL refusal and acknowledged rollback above.
          if (
            !refused ||
            !['absent', 'replacement'].includes(spec.fault) ||
            error.message !== 'FIXTURE_APPLICATION_DISCONNECTED'
          ) {
            retainRoleFaultFailure(proof, step, error);
            throw error;
          }
        }
      } finally {
        step = 'close-case';
        await owner.close(installer);
        await owner.close(app);
        for (const extra of extras) await owner.close(extra);
        if (active) await owner.bounded(() => active, true);
        if (prepared) {
          step = 'rollback-prepared';
          const cleanup = await owner.connect('supabase_admin');
          try {
            lastCommand(
              await owner.query(
                cleanup,
                "ROLLBACK PREPARED 'fixture-role-fault-prepared'",
                undefined,
                true
              ),
              'ROLLBACK'
            );
          } finally {
            await owner.close(cleanup);
          }
        }
      }
      step = 'backends-absent';
      await owner.absent([
        app.client.processID,
        installer.client.processID,
        ...extras.map((r) => r.client.processID),
      ]);
      step = 'catalog-restored';
      const catalogSha = await owner.snapshot(native, app.client.processID);
      step = 'password-restored';
      const observer = await owner.connect('supabase_admin', { readOnly: true });
      try {
        assert.equal(
          digest(JSON.stringify((await owner.query(observer, passwordSql)).rows)),
          passwordBefore,
          'FIXTURE_ROLE_NATIVE_PASSWORD_ROLLBACK'
        );
        assert.deepEqual(
          (
            await owner.query(
              observer,
              'SELECT NOT EXISTS(SELECT FROM pg_prepared_xacts) AND NOT EXISTS(SELECT FROM cron.job) AS clean'
            )
          ).rows,
          [{ clean: true }]
        );
      } catch (error) {
        retainRoleFaultFailure(proof, step, error);
        throw error;
      } finally {
        step = 'close-observer';
        await owner.close(observer);
      }
      proof.cases.push({
        name: spec.name,
        expected_refusal: true,
        rollback_acknowledged: true,
        original_catalog_sha256: catalogSha,
        password_catalog_restored: true,
        backends_absent: true,
      });
    }
  } catch (error) {
    retainRoleFaultFailure(proof, step, error);
    throw Object.assign(new Error('FIXTURE_ROLE_NATIVE_FAULT_QUALIFICATION_FAILED'), { proof });
  } finally {
    try {
      await owner.closeAll();
      proof.all_clients_closed = true;
    } catch (error) {
      retainRoleFaultFailure(proof, 'close-all', error);
      throw Object.assign(new Error('FIXTURE_ROLE_NATIVE_FAULT_CLEANUP_FAILED'), { proof });
    }
  }
  proof.status = 'passed';
  proof.stage = 'complete';
  return proof;
}
