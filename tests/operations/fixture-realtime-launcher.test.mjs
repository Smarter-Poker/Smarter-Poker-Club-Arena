import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, lstat, chmod, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  privateRealtimeLauncher,
  prepareRealtimeCookie,
} from '../../operations/release/fixture/fixture-server.mjs';

const exec = promisify(execFile);
const fixtures = new URL('./fixtures/realtime-launcher/', import.meta.url);
const original = await readFile(new URL('realtime.sh', fixtures), 'utf8');
const releaseEnvironment = await readFile(new URL('env.sh', fixtures), 'utf8');
const adapted = privateRealtimeLauncher(original, releaseEnvironment);
const hash = (value) => createHash('sha256').update(value).digest('hex');

async function owned(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixture-realtime-launcher-'));
  const home = path.join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  try {
    return await callback({ root, home, uid: process.getuid(), gid: process.getgid() });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('only the complete pinned launcher and release environment may be adapted', () => {
  for (const changed of [original + '\n', original.replace('start () {', 'start () { # drift')])
    assert.throws(() => privateRealtimeLauncher(changed, releaseEnvironment), /PREIMAGE_REFUSED/);
  assert.throws(
    () => privateRealtimeLauncher(original, releaseEnvironment + '\n'),
    /PREIMAGE_REFUSED/
  );
  assert.throws(() => privateRealtimeLauncher(adapted, releaseEnvironment), /PREIMAGE_REFUSED/);
  assert.ok(!adapted.includes('--cookie') && !adapted.includes('-setcookie'));
});

async function launcher(root, home, source, command, extraEnv = {}) {
  const release = path.join(root, 'releases', '2.134.10');
  await mkdir(path.join(root, 'bin'), { recursive: true });
  await mkdir(release, { recursive: true });
  await writeFile(path.join(root, 'bin', 'realtime'), source, { mode: 0o700 });
  await writeFile(path.join(root, 'releases', 'start_erl.data'), '16.4 2.134.10\n');
  await writeFile(path.join(root, 'releases', 'COOKIE'), 'unused-packaged-test-cookie\n');
  await writeFile(path.join(release, 'env.sh'), releaseEnvironment);
  await writeFile(path.join(release, 'sys.config'), '[].\n');
  const capture = path.join(root, 'capture.json');
  const captureProgram = path.join(root, 'capture.mjs');
  await writeFile(
    captureProgram,
    `import {writeFileSync} from 'node:fs';
writeFileSync(process.env.FIXTURE_TEST_CAPTURE, JSON.stringify({
  args: process.argv.slice(2), distribution: process.env.RELEASE_DISTRIBUTION,
  cookieEnvironmentPresent: Object.hasOwn(process.env, 'RELEASE_COOKIE')
}));`
  );
  // This stub captures only the shell launch boundary; it is not an Erlang or
  // service substitute. Linux native-smoke separately proves the real cookie.
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(
    path.join(release, 'elixir'),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(captureProgram)} "$@"\n`,
    { mode: 0o700 }
  );
  const result = await exec('/bin/sh', [path.join(root, 'bin', 'realtime'), ...command], {
    env: {
      PATH: '/usr/bin:/bin',
      HOME: home,
      FIXTURE_TEST_CAPTURE: capture,
      RELEASE_DISTRIBUTION: 'none',
      ...extraEnv,
    },
    timeout: 3000,
  });
  assert.equal(result.stdout, '');
  return JSON.parse(await readFile(capture, 'utf8'));
}

test('the pinned original launcher reproduces cookie-in-argv before adaptation', async () =>
  owned(async ({ root, home }) => {
    const result = await launcher(root, home, original, ['start']);
    assert.ok(result.args.includes('--cookie'));
    assert.ok(result.args.includes('unused-packaged-test-cookie'));
    assert.equal(result.distribution, 'name');
  }));

for (const command of [
  ['start'],
  ['eval', 'Realtime.Release.migrate'],
  ['rpc', 'IO.write("hash-only")'],
]) {
  test(`adapted ${command[0]} preserves the real launcher path without cookie arguments`, async () =>
    owned(async (context) => {
      const cookie = await prepareRealtimeCookie(context);
      const result = await launcher(context.root, context.home, adapted, command);
      assert.ok(result.args.every((argument) => hash(argument) !== cookie.sha256));
      assert.ok(!result.args.some((argument) => argument.includes('cookie')));
      assert.equal(result.cookieEnvironmentPresent, false);
      assert.equal(result.distribution, 'name', 'pinned upstream env.sh sets the actual mode');
      if (command[0] === 'start') {
        assert.ok(result.args.includes('--name'));
        assert.ok(result.args.includes('realtime@127.0.0.1'));
        assert.ok(result.args.includes('--no-halt'));
      } else {
        assert.ok(result.args.includes(command[1]));
      }
    }));
}

test('legacy cookie environment is refused without printing its value', async () =>
  owned(async ({ root, home }) => {
    const sentinel = 'private-cookie-test-sentinel';
    await assert.rejects(
      launcher(root, home, adapted, ['start'], { RELEASE_COOKIE: sentinel }),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.equal(error.stderr, 'FIXTURE_REALTIME_COOKIE_ENV_REFUSED\n');
        assert.ok(!error.message.includes(sentinel));
        return true;
      }
    );
  }));

test('cookie has a fresh private file and returns only its argument-scan hash', async () =>
  owned(async (context) => {
    const result = await prepareRealtimeCookie(context);
    assert.deepEqual(Object.keys(result), ['sha256']);
    const cookie = await readFile(path.join(context.home, '.erlang.cookie'), 'utf8');
    assert.match(cookie, /^[a-f0-9]{96}\n$/);
    assert.equal(hash(cookie.trim()), result.sha256);
    const details = await lstat(path.join(context.home, '.erlang.cookie'));
    assert.equal(details.mode & 0o7777, 0o400);
    assert.equal(details.uid, context.uid);
    assert.equal(details.gid, context.gid);
    assert.equal(details.nlink, 1);
    await assert.rejects(prepareRealtimeCookie(context), { code: 'EEXIST' });
    assert.equal(
      hash((await readFile(path.join(context.home, '.erlang.cookie'), 'utf8')).trim()),
      result.sha256
    );
  }));

test('cookie creation refuses a shared home, wrong owner or symlink without altering targets', async () =>
  owned(async (context) => {
    await chmod(context.home, 0o755);
    await assert.rejects(prepareRealtimeCookie(context), /COOKIE_HOME_REFUSED/);
    await chmod(context.home, 0o700);
    await assert.rejects(prepareRealtimeCookie({ ...context, uid: context.uid + 1 }));
    const target = path.join(context.root, 'unchanged');
    await writeFile(target, 'unchanged');
    await symlink(target, path.join(context.home, '.erlang.cookie'));
    await assert.rejects(prepareRealtimeCookie(context));
    assert.equal(await readFile(target, 'utf8'), 'unchanged');
    const homeLink = path.join(context.root, 'home-link');
    await symlink(context.home, homeLink);
    await assert.rejects(
      prepareRealtimeCookie({ ...context, home: homeLink }),
      /COOKIE_HOME_REFUSED/
    );
  }));
