import assert from 'node:assert/strict';
import test from 'node:test';
import {
  installFixtureCron,
  assertFixtureCronCatalog,
} from '../../operations/release/fixture/cron-provider.mjs';

test('cron installation refuses a non-bootstrap identity before any mutation', async () => {
  const calls = [];
  await assert.rejects(
    installFixtureCron({
      query: async (sql) => {
        calls.push(sql);
        return { rows: [{ owned_service_bootstrap: false }] };
      },
    }),
    /FIXTURE_SERVICE_BOOTSTRAP_IDENTITY_REQUIRED/
  );
  assert.equal(calls.length, 1);
});

test('cron installation refuses an existing or actively scheduled target', async () => {
  const calls = [];
  await assert.rejects(
    installFixtureCron({
      query: async (sql) => {
        calls.push(sql);
        return {
          rows: [
            sql.includes('owned_service_bootstrap')
              ? { owned_service_bootstrap: true }
              : { empty_isolated_cron: false },
          ],
        };
      },
    }),
    /FIXTURE_CRON_EMPTY_ISOLATED_TARGET_REQUIRED/
  );
  assert.equal(calls.length, 2);
});

test('an extension creation error rolls back without accepting a substitute', async () => {
  const calls = [];
  const failure = Object.assign(new Error('missing genuine library'), { code: '58P01' });
  await assert.rejects(
    installFixtureCron({
      query: async (sql) => {
        calls.push(sql);
        if (sql.includes('owned_service_bootstrap'))
          return { rows: [{ owned_service_bootstrap: true }] };
        if (sql.includes('empty_isolated_cron')) return { rows: [{ empty_isolated_cron: true }] };
        if (sql.startsWith('CREATE EXTENSION')) throw failure;
        return { rows: [] };
      },
    }),
    (error) => error === failure
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
  assert.ok(!calls.includes('COMMIT'));
  assert.ok(!calls.some((sql) => sql.startsWith('CREATE FUNCTION')));
});

test('an extension row cannot qualify missing native C functions', async () => {
  await assert.rejects(
    assertFixtureCronCatalog({
      query: async (sql) => ({
        rows: sql.includes('AS owned_extension') ? [{ owned_extension: true }] : [],
      }),
    }),
    /FIXTURE_CRON_NATIVE_FUNCTIONS_REQUIRED/
  );
});
