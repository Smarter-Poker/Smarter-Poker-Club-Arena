import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  renderFixtureRoleAlignmentSql,
  withHeldFixtureRoleAlignmentClient,
  assertHeldFixtureRoleAlignmentClient,
} from '../../operations/release/fixture/role-alignment-render.mjs';

const template = readFileSync(new URL('../../operations/release/fixture/role-alignment-installer.sql', import.meta.url), 'utf8');
const password = 'a'.repeat(64);
const startMicros = '1789317000123456';
function client(overrides = {}) {
  const value = new EventEmitter();
  value.processID = 12345;
  value.query = async () => ({ rows: [{
    pid: 12345, database: 'club_arena_qualification',
    session_role: 'postgres', current_role: 'postgres', superuser: false,
    backend_start_micros: startMicros, ...overrides,
  }] });
  return value;
}
const render = (binding, source = template, secret = password) =>
  renderFixtureRoleAlignmentSql(source, { password: secret, clientBinding: binding });

test('binds the held actual query and renders exact PID plus backend birth at both boundaries', async () => {
  const application = client();
  await withHeldFixtureRoleAlignmentClient(application, async binding => {
    const sql = render(binding);
    assert.equal(sql.split(password).length - 1, 8);
    assert.equal(sql.split('pid=12345').length - 1, 4);
    assert.equal(sql.split(startMicros).length - 1, 4);
    assert.ok(sql.includes('"search_path" TO "\\$user", public, extensions;'));
    assert.ok(sql.includes("VALID UNTIL '2026-09-07 04:55:14.200464+00'"));
    assert.ok(!sql.includes("VALID UNTIL 'infinity'"));
    assert.ok(sql.includes('FIXTURE_FULL_ROLE_PREIMAGE_REQUIRED'));
    assert.ok(sql.includes('FIXTURE_FULL_ROLE_POSTIMAGE_REQUIRED'));
  });
  assert.equal(application.listenerCount('end'), 0);
  assert.equal(application.listenerCount('error'), 0);
});

for (const invalid of [null, '', 'a'.repeat(63), 'A'.repeat(64), "'; COMMIT; --", 123]) {
  test('refuses invalid password ' + JSON.stringify(invalid), async () => {
    await withHeldFixtureRoleAlignmentClient(client(), async binding => {
      assert.throws(() => render(binding, template, invalid));
    });
  });
}
for (const invalid of [null, false, 0, -1, 1.5, 2147483648, '123', '123 OR TRUE']) {
  test('refuses invalid client handshake PID ' + JSON.stringify(invalid), async () => {
    const application = client(); application.processID = invalid;
    await assert.rejects(withHeldFixtureRoleAlignmentClient(application, () => assert.fail('must refuse')));
  });
}
for (const [name, row] of [
  ['wrong PID', { pid: 54321 }],
  ['wrong database', { database: 'postgres' }],
  ['wrong session role', { session_role: 'supabase_admin' }],
  ['assumed API role', { current_role: 'authenticated' }],
  ['superuser', { superuser: true }],
  ['missing backend birth', { backend_start_micros: null }],
  ['unsafe backend birth', { backend_start_micros: '1;COMMIT;' }],
  ['overflow backend birth', { backend_start_micros: '9223372036854775808' }],
]) {
  test('refuses actual identity with ' + name, async () => {
    await assert.rejects(withHeldFixtureRoleAlignmentClient(client(row), () => assert.fail('must refuse')));
  });
}
test('absent identity row cannot enter the installer callback', async () => {
  const application = client(); application.query = async () => ({ rows: [] });
  await assert.rejects(withHeldFixtureRoleAlignmentClient(application, () => assert.fail('must refuse')));
});
for (const event of ['end', 'error']) {
  test('refuses ' + event + ' while obtaining the actual identity', async () => {
    const application = client(); const query = application.query;
    application.query = async () => { application.emit(event, new Error('fixture only')); return query(); };
    await assert.rejects(withHeldFixtureRoleAlignmentClient(application, () => assert.fail('must refuse')),
      /FIXTURE_APPLICATION_DISCONNECTED/);
    assert.equal(application.listenerCount('end'), 0);
    assert.equal(application.listenerCount('error'), 0);
  });
  test('invalidates held authority on ' + event + ' during the installer scope', async () => {
    const application = client();
    await assert.rejects(withHeldFixtureRoleAlignmentClient(application, async binding => {
      assertHeldFixtureRoleAlignmentClient(binding);
      application.emit(event, new Error('fixture only'));
      assert.throws(() => render(binding), /FIXTURE_APPLICATION_DISCONNECTED/);
    }), /FIXTURE_APPLICATION_DISCONNECTED/);
  });
}
test('refuses a changed handshake PID before subsequent execution', async () => {
  const application = client();
  await assert.rejects(withHeldFixtureRoleAlignmentClient(application, async binding => {
    application.processID = 54321;
    assert.throws(() => render(binding), /FIXTURE_APPLICATION_PID_CHANGED/);
  }), /FIXTURE_APPLICATION_PID_CHANGED/);
});
test('closed bindings and caller-selected numeric objects cannot authorize rendering', async () => {
  let saved;
  await withHeldFixtureRoleAlignmentClient(client(), async binding => { saved = binding; });
  for (const binding of [saved, {}, { pid: 12345, startMicros }, null, 12345]) {
    assert.throws(() => render(binding), /FIXTURE_HELD_APPLICATION_BINDING_REQUIRED/);
  }
});
test('callback failure removes listeners and expires its binding', async () => {
  const application = client(); let saved;
  await assert.rejects(withHeldFixtureRoleAlignmentClient(application, async binding => {
    saved = binding; throw new Error('fixture installer refused');
  }), /fixture installer refused/);
  assert.throws(() => render(saved), /FIXTURE_HELD_APPLICATION_BINDING_REQUIRED/);
  assert.equal(application.listenerCount('end'), 0);
  assert.equal(application.listenerCount('error'), 0);
});
test('refuses template drift before rendering any credential', async () => {
  await withHeldFixtureRoleAlignmentClient(client(), async binding => {
    assert.throws(() => render(binding, template.replace('RESTRICT;', 'CASCADE;')));
  });
});
test('refuses oversized input before parsing or interpolation', async () => {
  await withHeldFixtureRoleAlignmentClient(client(), async binding => {
    assert.throws(() => render(binding, 'x'.repeat(256 * 1024 + 1)));
  });
});
