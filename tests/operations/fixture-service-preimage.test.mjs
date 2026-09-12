import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { captureFixtureServicePreimage } from '../../operations/release/fixture/service-preimage.mjs';

// Driver tests separately validate every nested field before artifact exposure.
// These tests exercise the collector's connection/transaction failure boundary.
function database({ failure, quiescent = true, edit = () => {} } = {}) {
  const calls = [];
  const catalog = {
    version: 1,
    scope: 'owned-post-service-preimage',
    observed_at: '2026-09-12T18:00:00+00:00',
    database: 'club_arena_qualification',
    role_scope: 'all roles including unconnected builtin and fixture roles',
    roles: [{ name: 'supabase_admin' }],
    memberships: [{ role: 'postgres', member: 'supabase_admin' }],
    role_settings: null,
    default_acl: null,
    schemas: [{ name: 'public' }],
    extensions: [{ name: 'plpgsql' }],
    production_parity: false,
    contains_passwords_or_user_rows: false,
  };
  edit(catalog);
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      const stage = sql.startsWith('BEGIN')
        ? 'begin'
        : sql === 'ROLLBACK'
          ? 'rollback'
          : sql.includes('DO $owned$')
            ? 'identity'
            : sql.includes('pg_stat_activity')
              ? 'quiescence'
              : 'catalog';
      if (stage === failure) throw new Error('PRIVATE DATABASE ERROR');
      if (stage === 'quiescence') return { rows: [{ quiescent }] };
      if (stage === 'catalog') return { rows: [{ preimage: catalog }] };
      return { rows: [] };
    },
  };
}

test('catalog capture uses one read-only snapshot, actual idle PID and rollback', async () => {
  const db = database();
  const { serialized, proof } = await captureFixtureServicePreimage(db, 4321);
  assert.equal(db.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.deepEqual(db.calls[2].values, [4321]);
  assert.match(db.calls[2].sql, /IS NOT TRUE/);
  assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  assert.equal(proof.catalog_sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(proof.roles, 1);
  assert.equal(proof.role_settings, 0);
  assert.equal(proof.default_acl, 0);
  assert.equal(proof.production_parity, false);
  assert.equal(proof.application_schema_restored, false);
});

test('invalid actual application PID never starts a transaction', async () => {
  for (const pid of [undefined, null, 0, -1, 1.5, '4321', 2147483648]) {
    const db = database();
    await assert.rejects(captureFixtureServicePreimage(db, pid));
    assert.equal(db.calls.length, 0);
  }
});

test('wrong identity and database failures roll back without captured output', async () => {
  for (const failure of ['identity', 'quiescence', 'catalog', 'rollback']) {
    const db = database({ failure });
    await assert.rejects(captureFixtureServicePreimage(db, 4321), /PRIVATE DATABASE ERROR/);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  }
  const db = database({ failure: 'begin' });
  await assert.rejects(captureFixtureServicePreimage(db, 4321));
  assert.equal(db.calls.length, 1);
});

test('any unapproved client or unknown quiescence refuses catalog collection', async () => {
  for (const quiescent of [false, null, undefined, 'true', 1]) {
    const db = database({ quiescent });
    // Explicit undefined would use the helper default, so inject it in the query.
    if (quiescent === undefined) {
      const query = db.query.bind(db);
      db.query = async (sql, values) => {
        const result = await query(sql, values);
        return sql.includes('pg_stat_activity') ? { rows: [] } : result;
      };
    }
    await assert.rejects(captureFixtureServicePreimage(db, 4321), /QUIESCENT_CATALOG/);
    assert.equal(db.calls.length, 4);
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  }
});

test('missing, surplus, oversized or parity-claiming catalog cannot be captured', async () => {
  for (const edit of [
    (c) => {
      c.production_parity = true;
    },
    (c) => {
      c.contains_passwords_or_user_rows = true;
    },
    (c) => {
      c.password = 'PRIVATE';
    },
    (c) => {
      delete c.observed_at;
    },
    (c) => {
      c.roles = [];
    },
    (c) => {
      c.memberships = null;
    },
    (c) => {
      c.extensions = Array(129).fill({});
    },
    (c) => {
      c.role_settings = {};
    },
    (c) => {
      c.roles[0].name = 'x'.repeat(1024 * 1024);
    },
  ]) {
    const db = database({ edit });
    await assert.rejects(captureFixtureServicePreimage(db, 4321));
    assert.equal(db.calls.at(-1).sql, 'ROLLBACK');
  }
});
