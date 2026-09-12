import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  archiveNames,
  extractArchive,
  startArguments,
  fixtureTemplate,
  fixtureSourceContract,
  observationControl,
  financialActorDescriptor,
} from '../../operations/release/fixture/runtime-files.mjs';
const exec = promisify(execFile);

test('observation control identity is exact and cannot carry candidate routing or proof', () => {
  const control = { version: 1, control_sha: 'a'.repeat(40) };
  const actual = observationControl(control);
  assert.deepEqual(actual, control);
  assert.equal(Object.isFrozen(actual), true);
  for (const invalid of [
    null,
    [],
    {},
    { ...control, version: 2 },
    { ...control, control_sha: 'main' },
    { ...control, control_sha: 'A'.repeat(40) },
    { ...control, socket: '/tmp/candidate.sock' },
    { ...control, source_sha: 'b'.repeat(40) },
    { ...control, current_database_contract_ready: true },
  ])
    assert.throws(() => observationControl(invalid));
});

test('archive inventory refuses traversal, ambiguous names, aliases and controls', () => {
  for (const input of [
    '../outside\n',
    '/outside\n',
    'x\\y\n',
    'a/./b\n',
    'a//b\n',
    'a\na\n',
    'a\na/b\n',
    'a/\na\n',
    'a\r\n',
    'a\0b\n',
    'x',
    '*\n',
    '[a]\n',
    '-d\n',
  ]) {
    assert.throws(() => archiveNames(input));
  }
  assert.deepEqual(archiveNames('assets/\nassets/a.js\nindex.html\n'), [
    'assets/a.js',
    'index.html',
  ]);
});

test('CLI cannot select a command or a production backend', () => {
  const web = '--web=/inputs/' + 'a'.repeat(64) + '.zip';
  assert.deepEqual(
    startArguments(['--schema=/inputs/schema.zip', web, '--engine=http://engine:8080']),
    { schema: '/inputs/schema.zip', web: '/inputs/' + 'a'.repeat(64) + '.zip' }
  );
  assert.throws(() => startArguments(['--schema=/etc/passwd', web, '--engine=http://engine:8080']));
  assert.throws(() =>
    startArguments(['--schema=/inputs/schema.zip', web, '--engine=https://engine.smarter.poker'])
  );
  const base = ['--schema=/inputs/schema.zip', web, '--engine=http://engine:8080'];
  assert.equal(startArguments([...base, '--scenario=financial']).financialScenario, true);
  for (const extra of [
    '--scenario=product',
    '--scenario=unknown',
    '--actors=service_role',
    '',
    undefined,
  ])
    assert.throws(() => startArguments([...base, extra]));
  assert.throws(() => startArguments([...base, '--scenario=financial', '--scenario=financial']));
});

test('financial observer receives only two ordinary local Auth sessions and their bound scope', () => {
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const token = (sub, role = 'authenticated', exp = Math.floor(Date.now() / 1000) + 3600) =>
    'e30.' + Buffer.from(JSON.stringify({ sub, role, exp })).toString('base64url') + '.signature';
  const fixture = { club_id: id(1), table_id: id(2), actor_user_ids: [id(3), id(4)] };
  const users = fixture.actor_user_ids.map((actor) => ({
    id: actor,
    password: 'must-stay-private',
    sessionId: id(5),
    session: {
      access_token: token(actor),
      refresh_token: 'must-stay-private',
      user: { id: actor, email: 'private' },
    },
  }));
  const result = financialActorDescriptor(fixture, users);
  assert.deepEqual(result, {
    version: 1,
    club_id: id(1),
    table_id: id(2),
    users: users.map((user) => ({
      id: user.id,
      session: { access_token: user.session.access_token, user: { id: user.id } },
    })),
  });
  assert.ok(!JSON.stringify(result).includes('private'));
  for (const replacement of [
    token(id(3), 'service_role'),
    token(id(4)),
    token(id(3), 'authenticated', 1),
    'invalid',
  ]) {
    const invalid = structuredClone(users);
    invalid[0].session.access_token = replacement;
    assert.throws(() => financialActorDescriptor(fixture, invalid));
  }
  assert.throws(() => financialActorDescriptor(fixture, users.toReversed()));
  assert.throws(() => financialActorDescriptor(fixture, [users[0], users[0]]));
  assert.throws(() => financialActorDescriptor(fixture, [...users, users[0]]));
  result.users[0].session.user.id = id(9);
  assert.equal(users[0].session.user.id, id(3));
});

test('fixture requires fixed synthetic actor and real-auth provenance', () => {
  const template = {
    version: 1,
    scope: 'isolated-club-arena-fixture',
    supabase_host: 'a'.repeat(20) + '.supabase.co',
    seed_version: 1,
    actor_count: 2,
    spectator_count: 1,
    auth_user_source: 'local-gotrue-admin-api',
    source_contract: {
      version: 1,
      source_sha: 'a'.repeat(40),
      current_database_contract_ready: false,
      exclusions: ['per-tournament-shared-lane-conversion'],
    },
  };
  assert.equal(fixtureTemplate(template), template);
  assert.throws(() => fixtureTemplate({ ...template, actor_count: 0 }));
  assert.throws(() => fixtureTemplate({ ...template, serviceKey: 'not-allowed' }));
  const { source_contract, ...missingContract } = template;
  assert.throws(() => fixtureTemplate(missingContract));
});

test('fixture source limitations cannot be absent, malformed or hidden behind a ready flag', () => {
  const limited = {
    version: 1,
    source_sha: 'a'.repeat(40),
    current_database_contract_ready: false,
    exclusions: ['per-tournament-shared-lane-conversion'],
  };
  assert.equal(fixtureSourceContract(limited), limited);
  const full = { ...limited, current_database_contract_ready: true, exclusions: [] };
  assert.equal(fixtureSourceContract(full), full);
  for (const invalid of [
    null,
    [],
    { ...limited, version: 2 },
    { ...limited, source_sha: 'main' },
    { ...limited, current_database_contract_ready: 'false' },
    { ...limited, current_database_contract_ready: true },
    { ...limited, exclusions: [] },
    { ...limited, exclusions: ['same', 'same'] },
    { ...limited, exclusions: ['unexpected\ncontent'] },
    { ...limited, approved: true },
  ])
    assert.throws(() => fixtureSourceContract(invalid));
});

test('native ZIP extraction keeps a symlink payload inert and preserves exact bytes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixture-archive-'));
  try {
    await mkdir(path.join(root, 'source'));
    await writeFile(path.join(root, 'source', 'data.bin'), Buffer.from([0, 1, 255]));
    await symlink('/etc/passwd', path.join(root, 'source', 'link'));
    const archive = path.join(root, 'fixture.zip');
    await exec('/usr/bin/zip', ['-y', archive, 'data.bin', 'link'], {
      cwd: path.join(root, 'source'),
    });
    const result = await extractArchive(archive, path.join(root, 'expanded'));
    assert.equal(result.bytes, 14);
    assert.deepEqual(
      await readFile(path.join(root, 'expanded', 'data.bin')),
      Buffer.from([0, 1, 255])
    );
    assert.equal((await lstat(path.join(root, 'expanded', 'link'))).isSymbolicLink(), false);
    assert.equal(await readFile(path.join(root, 'expanded', 'link'), 'utf8'), '/etc/passwd');
    await assert.rejects(extractArchive(archive, path.join(root, 'expanded')));
    await assert.rejects(extractArchive(archive, path.join(root, 'bounded'), { maxBytes: 2 }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
