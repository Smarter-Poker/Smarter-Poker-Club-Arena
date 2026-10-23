import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preferOfficialUbuntuSource } from './ubuntu-package-source.mjs';

const fixture = (uri) =>
  `Types: deb\nURIs: ${uri}\nSuites: noble noble-updates noble-backports\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n\nTypes: deb\nURIs: https://security.ubuntu.com/ubuntu\nSuites: noble-security\nComponents: main restricted universe multiverse\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n`;
const expected = fixture('https://archive.ubuntu.com/ubuntu');

for (const uri of [
  'mirror+file:/etc/apt/apt-mirrors.txt',
  'http://azure.archive.ubuntu.com/ubuntu',
  'https://azure.archive.ubuntu.com/ubuntu/',
  'http://archive.ubuntu.com/ubuntu/',
]) {
  test(`uses the signed public archive instead of ${uri}`, () => {
    assert.equal(preferOfficialUbuntuSource(fixture(uri)), expected);
  });
}

test('preserves already official sources and PostgreSQL signing authority byte for byte', () => {
  assert.equal(preferOfficialUbuntuSource(expected), expected);
  const pg =
    'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n';
  assert.equal(preferOfficialUbuntuSource(pg), pg);
});

test('preserves CRLF and signing fields when the copied source uses Windows line endings', () => {
  assert.equal(
    preferOfficialUbuntuSource(
      fixture('mirror+file:/etc/apt/apt-mirrors.txt').replaceAll('\n', '\r\n')
    ),
    expected.replaceAll('\n', '\r\n')
  );
});

test('the original accounting install checks and rewrites its private source before apt reads it', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const start = workflow.indexOf(
    '- name: Install PostgreSQL 17 tools without a default database service'
  );
  assert.ok(start >= 0);
  const step = workflow.slice(start, workflow.indexOf('\n      - name:', start + 1));
  const copy = step.indexOf('cp /etc/apt/sources.list.d/ubuntu.sources');
  const rewrite = step.indexOf(
    'node scripts/ci/ubuntu-package-source.mjs "$pg_ci_sources/ubuntu.sources"'
  );
  const apt = step.indexOf('sudo apt-get');
  assert.ok(step.indexOf('node --test scripts/ci/ubuntu-package-source.test.mjs') >= 0);
  assert.ok(copy >= 0 && rewrite > copy && apt > rewrite);
});

test('refuses an unsupported mixed mirror line', () => {
  assert.throws(
    () =>
      preferOfficialUbuntuSource(
        fixture('http://azure.archive.ubuntu.com/ubuntu https://other.invalid/ubuntu')
      ),
    /Unsupported Ubuntu mirror/
  );
});

test('the actual CLI changes only the copied Ubuntu source and refuses another source file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-ubuntu-source-'));
  try {
    const script = fileURLToPath(new URL('./ubuntu-package-source.mjs', import.meta.url));
    const path = join(dir, 'ubuntu.sources');
    writeFileSync(path, fixture('mirror+file:/etc/apt/apt-mirrors.txt'));
    execFileSync(process.execPath, [script, path]);
    assert.equal(readFileSync(path, 'utf8'), expected);
    assert.throws(() =>
      execFileSync(process.execPath, [script, join(dir, 'pgdg.sources')], { stdio: 'pipe' })
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
