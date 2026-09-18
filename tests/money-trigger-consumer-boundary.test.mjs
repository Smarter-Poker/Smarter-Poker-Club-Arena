import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const consumer = new URL('../scripts/ci/consume-money-trigger-recovery.mjs', import.meta.url);
const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const migration = 'supabase/migrations/20260102000000_candidate.sql';
const declaration = 'supabase/migrations/20260101000000_declaration.sql';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sqlBytes = (size) => Buffer.from('-- ' + 'x'.repeat(size - 4) + '\n');

// Run the maintained consumer unchanged: real committed Git bytes and ZIP,
// with only the authenticated provider transport replaced by a closed fixture.
function consume({ migrationSize = 64, recordSize = 64, wrongHash } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'money-consumer-boundary-'));
  const gitEnv = {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_AUTHOR_NAME: 'Boundary Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Boundary Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8' }).trim();
  try {
    git('init', '--quiet');
    fs.mkdirSync(path.join(dir, 'supabase/migrations'), { recursive: true });
    const recordBytes = sqlBytes(recordSize);
    fs.writeFileSync(path.join(dir, declaration), recordBytes);
    git('add', declaration);
    const base = git('commit-tree', git('write-tree'), '-m', 'declaration fixture');
    git('update-ref', 'HEAD', base);
    const candidateBytes = sqlBytes(migrationSize);
    fs.writeFileSync(path.join(dir, migration), candidateBytes);
    git('add', migration);
    const head = git('commit-tree', git('write-tree'), '-p', base, '-m', 'candidate fixture');
    git('update-ref', 'HEAD', head);

    const now = new Date().toISOString();
    const proof = {
      version: 1,
      repository,
      headSha: head,
      runId: '1234',
      pr: null,
      producedAt: now,
      results: [
        {
          path: migration,
          sha256: wrongHash === 'migration' ? '0'.repeat(64) : hash(candidateBytes),
          recovered: false,
        },
      ],
      // Deliberately unchanged in the candidate: this exercises the separate
      // declaration-record Git read rather than the changed-file loop twice.
      recordHashes: {
        [declaration]: wrongHash === 'record' ? '0'.repeat(64) : hash(recordBytes),
      },
    };
    const artifactDir = path.join(dir, 'artifact');
    fs.mkdirSync(artifactDir);
    fs.writeFileSync(path.join(artifactDir, 'money-trigger-recovery.json'), JSON.stringify(proof));
    const zip = path.join(artifactDir, 'proof.zip');
    execFileSync('zip', ['-q', zip, 'money-trigger-recovery.json'], {
      cwd: artifactDir,
      env: { PATH: process.env.PATH },
    });
    const run = {
      id: 1234,
      repository: { full_name: repository },
      path: '.github/workflows/money-trigger-recovery.yml',
      event: 'workflow_dispatch',
      head_branch: 'main',
      conclusion: 'success',
      updated_at: now,
    };
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const requests = [];
      globalThis.fetch = async (url, options = {}) => {
        assert.equal(options.method || 'GET', 'GET');
        assert.equal(options.headers.Authorization, 'Bearer modeled-reader-token');
        requests.push(url);
        fs.writeFileSync('requests.json', JSON.stringify(requests));
        if (url === 'https://api.github.com/repos/${repository}/actions/runs/1234')
          return { ok: true, json: async () => (${JSON.stringify(run)}) };
        if (url === 'https://api.github.com/repos/${repository}/actions/runs/1234/artifacts')
          return { ok: true, json: async () => ({ artifacts: [
            { id: 5678, name: 'money-trigger-recovery-${head}', expired: false }
          ] }) };
        if (url === 'https://api.github.com/repos/${repository}/actions/artifacts/5678/zip')
          return { ok: true, arrayBuffer: async () => fs.readFileSync(${JSON.stringify(zip)}) };
        throw Error('Unexpected provider request: ' + url);
      };
      await import(${JSON.stringify(consumer.href)});
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: os.devNull,
        GITHUB_REPOSITORY: repository,
        GITHUB_TOKEN: 'modeled-reader-token',
        MONEY_TRIGGER_RUN_ID: '1234',
        MONEY_TRIGGER_BASE: base,
      },
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'requests.json'), 'utf8')), [
      `https://api.github.com/repos/${repository}/actions/runs/1234`,
      `https://api.github.com/repos/${repository}/actions/runs/1234/artifacts`,
      `https://api.github.com/repos/${repository}/actions/artifacts/5678/zip`,
    ]);
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const size of [1_000_956, 1_048_576]) {
  test(`actual consumer verifies migration and declaration hashes at ${size} bytes`, () => {
    const result = consume({ migrationSize: size, recordSize: size });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Trusted exact-head money-trigger proof verified for 1 files/);
  });
}

for (const field of ['migrationSize', 'recordSize']) {
  test(`actual consumer refuses ${field} above 1 MiB`, () => {
    const result = consume({ [field]: 1_048_577 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOBUFS|maxBuffer/);
    assert.doesNotMatch(result.stdout, /proof verified/);
  });
}

for (const wrongHash of ['migration', 'record']) {
  test(`actual consumer still refuses a mismatched ${wrongHash} hash`, () => {
    const result = consume({ wrongHash });
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      wrongHash === 'migration' ? /migration bytes differ/ : /declaration record bytes differ/
    );
    assert.doesNotMatch(result.stdout, /proof verified/);
  });
}
