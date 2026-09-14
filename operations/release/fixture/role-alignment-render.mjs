import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
// This literal is source authority. The adjacent JSON is an audit record only.
const templateSha256 = '75de4863de9a9276e701526389a6fbe0a033589d60844b71dd42eb44fbdf31db';
const heldBindings = new WeakMap();
const identitySql = `SELECT pg_backend_pid() AS pid, current_database() AS database,
  session_user AS session_role, current_user AS current_role,
  current_setting('is_superuser')::boolean AS superuser,
  (SELECT (extract(epoch FROM backend_start)*1000000)::bigint::text
     FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS backend_start_micros`;

function checkedBinding(binding) {
  const held = heldBindings.get(binding);
  assert.ok(held, 'FIXTURE_HELD_APPLICATION_BINDING_REQUIRED');
  assert.ok(!held.disconnected(), 'FIXTURE_APPLICATION_DISCONNECTED');
  assert.equal(held.client.processID, held.pid, 'FIXTURE_APPLICATION_PID_CHANGED');
  return held;
}

// The integration driver passes its actual, already-owned application pg.Client
// and keeps this scope around the installer and distinct post/rollback observers.
// It must not send another query on that client while the installer runs.
export async function withHeldFixtureRoleAlignmentClient(applicationClient, consume) {
  assert.ok(applicationClient && typeof applicationClient.query === 'function');
  assert.ok(typeof applicationClient.on === 'function' && typeof applicationClient.off === 'function');
  assert.equal(typeof consume, 'function');
  const pid = applicationClient.processID;
  assert.ok(Number.isInteger(pid) && pid > 0 && pid <= 2147483647);
  let disconnected = false;
  const disconnectedListener = () => { disconnected = true; };
  applicationClient.on('end', disconnectedListener);
  applicationClient.on('error', disconnectedListener);
  const binding = Object.freeze({});
  try {
    const result = await applicationClient.query(identitySql);
    assert.equal(result.rows?.length, 1, 'FIXTURE_APPLICATION_IDENTITY_REQUIRED');
    const row = result.rows[0];
    assert.equal(row.pid, pid, 'FIXTURE_APPLICATION_PID_MISMATCH');
    assert.equal(row.database, 'club_arena_qualification');
    assert.equal(row.session_role, 'postgres');
    assert.equal(row.current_role, 'postgres');
    assert.equal(row.superuser, false);
    assert.ok(typeof row.backend_start_micros === 'string'
      && /^[1-9][0-9]{12,18}$/.test(row.backend_start_micros)
      && BigInt(row.backend_start_micros) <= 9223372036854775807n);
    heldBindings.set(binding, {
      client: applicationClient, pid, startMicros: row.backend_start_micros,
      disconnected: () => disconnected,
    });
    checkedBinding(binding);
    const resultValue = await consume(binding);
    checkedBinding(binding);
    return resultValue;
  } finally {
    heldBindings.delete(binding);
    applicationClient.off('end', disconnectedListener);
    applicationClient.off('error', disconnectedListener);
  }
}

export function assertHeldFixtureRoleAlignmentClient(binding) {
  checkedBinding(binding);
}

export function renderFixtureRoleAlignmentSql(template, { password, clientBinding }) {
  assert.equal(typeof template, 'string');
  assert.ok(Buffer.byteLength(template) <= 256 * 1024);
  assert.equal(createHash('sha256').update(template).digest('hex'), templateSha256);
  assert.ok(typeof password === 'string' && /^[0-9a-f]{64}$/.test(password));
  const held = checkedBinding(clientBinding);
  assert.equal(template.split('@FIXTURE_RANDOM_64_HEX_PASSWORD@').length - 1, 8);
  assert.equal(template.split('@OWNED_IDLE_APPLICATION_PID@').length - 1, 4);
  assert.equal(template.split('@OWNED_APP_START_MICROS@').length - 1, 4);
  const rendered = template.replaceAll('@FIXTURE_RANDOM_64_HEX_PASSWORD@', password)
    .replaceAll('@OWNED_IDLE_APPLICATION_PID@', String(held.pid))
    .replaceAll('@OWNED_APP_START_MICROS@', held.startMicros);
  assert.ok(!/@[A-Z_]+@/.test(rendered));
  return rendered;
}
