import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  staticControlFiles,
  staticControlReceipt,
  proveStaticControl,
  validateStaticControlReceipt,
} from '../../operations/release/static-control-closure.mjs';
import { factDigest } from '../../operations/release/component-certificate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const repo = '/repos/Smarter-Poker/Smarter-Poker-Club-Arena';
async function fixture() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'ca-control-closure-'));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_AUTHOR_NAME: 'Disposable closure fixture',
    GIT_COMMITTER_NAME: 'Disposable closure fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  };
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const files = {};
  for (const file of staticControlFiles) {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    const bytes = await readFile(path.join(root, file));
    await writeFile(path.join(cwd, file), bytes);
    files[file] = { bytes, mode: '100644' };
  }
  git('init', '-b', 'main');
  git('add', '.');
  git('commit', '-m', 'Disposable approved closure');
  const source = git('rev-parse', 'HEAD');
  const receipt = staticControlReceipt({ sourceSha: source, repositoryId: '123', files });
  const calls = [];
  let onCall = () => {};
  async function request(route) {
    calls.push(route);
    await onCall(route);
    if (route === repo) return { id: 123, full_name: repo.slice(7), default_branch: 'main' };
    if (route === `${repo}/git/ref/heads/main`)
      return { ref: 'refs/heads/main', object: { type: 'commit', sha: git('rev-parse', 'HEAD') } };
    if (route === `${repo}/actions/workflows/235`)
      return { id: 235, path: staticControlFiles[0], state: 'active' };
    const [kind, sha] = route.slice(`${repo}/git/`.length).split('/');
    if (kind === 'commits') return { sha, tree: { sha: git('rev-parse', `${sha}^{tree}`) } };
    if (kind === 'trees')
      return {
        sha,
        truncated: false,
        tree: git('ls-tree', sha)
          .split('\n')
          .filter(Boolean)
          .map((row) => {
            const [, mode, type, sha, entry] = row.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/);
            return { mode, type, sha, path: entry };
          }),
      };
    if (kind === 'blobs') {
      const bytes = execFileSync('git', ['cat-file', 'blob', sha], { cwd, env });
      return { sha, encoding: 'base64', content: bytes.toString('base64'), size: bytes.length };
    }
    throw new Error(`unexpected fixture route: ${route}`);
  }
  async function commit(file, text) {
    await writeFile(path.join(cwd, file), text);
    git('add', '.');
    git('commit', '-m', 'Disposable candidate change');
    return git('rev-parse', 'HEAD');
  }
  return {
    cwd,
    git,
    files,
    receipt,
    source,
    request,
    calls,
    commit,
    onCall: (fn) => {
      onCall = fn;
    },
    close: () => rm(cwd, { recursive: true, force: true }),
  };
}
test('actual Git object closure accepts a newer frontend SHA without relabeling its control source', async () => {
  const f = await fixture();
  try {
    const newer = await f.commit('frontend.txt', 'Changed frontend content');
    const result = await proveStaticControl({
      request: f.request,
      installedReceipt: f.receipt,
      sourceSha: newer,
      workflowId: 235,
    });
    assert.equal(result.control_sha, newer);
    assert.equal(result.installed_control_sha, f.source);
    assert.equal(result.closure_digest, f.receipt.digest);
    assert.equal(result.file_count, 16);
    assert.equal(f.calls.filter((r) => r === `${repo}/git/ref/heads/main`).length, 2);
  } finally {
    await f.close();
  }
});
test('exact closure omits no file and accepts no caller-added file or forged digest', async () => {
  const f = await fixture();
  try {
    for (const alteration of ['omit', 'add', 'digest']) {
      const receipt = structuredClone(f.receipt);
      if (alteration === 'omit') receipt.files.pop();
      if (alteration === 'add') receipt.files.push({ ...receipt.files[0], path: 'extra.mjs' });
      const { digest: _digest, ...body } = receipt;
      receipt.digest = alteration === 'digest' ? 'f'.repeat(64) : factDigest(body);
      assert.throws(() => validateStaticControlReceipt(receipt));
    }
    assert.throws(() =>
      staticControlReceipt({
        sourceSha: f.source,
        repositoryId: 123,
        files: { ...f.files, 'extra.mjs': { bytes: Buffer.from('new code'), mode: '100644' } },
      })
    );
  } finally {
    await f.close();
  }
});
for (const change of ['content', 'dynamic dependency', 'symlink', 'omission']) {
  test(`actual Git ${change} requires a reviewed controller upgrade`, async () => {
    const f = await fixture();
    try {
      const file = 'operations/release/adapters/github.mjs';
      let newer;
      if (change === 'omission') {
        f.git('rm', file);
        f.git('commit', '-m', 'Remove control');
        newer = f.git('rev-parse', 'HEAD');
      } else if (change === 'symlink') {
        const { symlink, unlink } = await import('node:fs/promises');
        await unlink(path.join(f.cwd, file));
        await symlink('/outside/control.mjs', path.join(f.cwd, file));
        f.git('add', '.');
        f.git('commit', '-m', 'Hostile control symlink');
        newer = f.git('rev-parse', 'HEAD');
      } else
        newer = await f.commit(
          file,
          change === 'content' ? 'changed authority' : 'await import(process.env.HOSTILE_MODULE);'
        );
      await assert.rejects(
        proveStaticControl({
          request: f.request,
          installedReceipt: f.receipt,
          sourceSha: newer,
          workflowId: 235,
        }),
        /RELEASE_STATIC_CONTROL/
      );
    } finally {
      await f.close();
    }
  });
}
test('default branch race and malicious blob API response refuse before a dispatch', async () => {
  const f = await fixture();
  try {
    let moved = false;
    f.onCall(async (route) => {
      if (!moved && route.includes('/git/blobs/')) {
        moved = true;
        await f.commit('frontend.txt', 'race');
      }
    });
    await assert.rejects(
      proveStaticControl({
        request: f.request,
        installedReceipt: f.receipt,
        sourceSha: f.source,
        workflowId: 235,
      }),
      /DEFAULT_CONTROL_CHANGED/
    );
    f.onCall(() => {});
    const newer = f.git('rev-parse', 'HEAD');
    await assert.rejects(
      proveStaticControl({
        request: async (r) => {
          const value = await f.request(r);
          return r.includes('/git/blobs/')
            ? { ...value, content: Buffer.from('forged').toString('base64') }
            : value;
        },
        installedReceipt: f.receipt,
        sourceSha: newer,
        workflowId: 235,
      }),
      /CONTROL_UPGRADE_REQUIRED/
    );
    assert.ok(f.calls.every((r) => !r.endsWith('/dispatches')));
  } finally {
    await f.close();
  }
});
