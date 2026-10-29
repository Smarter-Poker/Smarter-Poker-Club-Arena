#!/usr/bin/env node
import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isBuiltin } from 'node:module';
import {
  existsSync,
  lstatSync,
  realpathSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { resolve, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readBuildInfoSha, classifyTrustedLineage } from './production-e2e-provenance.mjs';
import { readRetentionReceipt } from './client-runtime-retention.mjs';

const ROOTS = ['tests/e2e/stats-deep.spec.ts', 'tests/e2e/global-setup.ts', 'playwright.config.ts'];
const CONFIG = ['package.json', 'package-lock.json', 'tsconfig.json'];
const ORIGINS = ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'];
const SHA = /^[0-9a-f]{40}$/;
const blobId = (bytes) =>
  createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const extensions = ['', '.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx'];
const refuse = (message) => {
  throw new Error(message);
};
export class JourneyUnknown extends Error {}

// These three closed entry points are the actual Stats process, not client
// runtime equivalence. Follow their local imports; package/lock/config stay exact.
export function statsHarnessInputs(root, verifyImport = () => {}) {
  const inputs = new Set(CONFIG),
    queue = [...ROOTS];
  let bytes = 0,
    nodes = 0,
    edges = 0;
  const local = (path) => {
    if (
      !path ||
      posix.isAbsolute(path) ||
      path.startsWith('../') ||
      path.includes('\\') ||
      /[\x00-\x1f]/.test(path)
    )
      refuse('Stats harness path escapes the checkout.');
    const full = resolve(root, path);
    if (
      !existsSync(full) ||
      !lstatSync(full).isFile() ||
      lstatSync(full).isSymbolicLink() ||
      realpathSync(full) !== resolve(realpathSync(root), path)
    )
      refuse(`Stats harness input is missing or not a regular file: ${path}`);
    if (lstatSync(full).size > 4 * 1024 * 1024)
      refuse('A Stats harness input exceeds its byte bound.');
    return full;
  };
  const dependency = (from, spec) => {
    if (++edges > 128) refuse('Stats harness imports exceed their bound.');
    if (!spec.startsWith('.')) {
      if (
        aliases.some((pattern) => {
          const [prefix, suffix] = pattern.split('*');
          return suffix === undefined
            ? spec === prefix
            : spec.startsWith(prefix) && spec.endsWith(suffix);
        })
      )
        refuse('Stats harness package is shadowed by compiler paths.');
      if (baseUrl !== null && !isBuiltin(spec)) {
        if (
          spec.includes('\\') ||
          spec.includes('..') ||
          posix.isAbsolute(spec) ||
          /[\x00-\x1f]/.test(spec)
        )
          refuse('Stats harness package path is unsupported.');
        const base = posix.join(baseUrl, spec);
        if (
          extensions.some((extension) => {
            try {
              lstatSync(resolve(root, base + extension));
              return true;
            } catch {
              return false;
            }
          })
        )
          refuse('Stats harness package is shadowed by compiler baseUrl.');
        verifyImport(base, null);
      }
    }
    if (isBuiltin(spec)) return;
    if (spec.startsWith('.')) {
      const base = posix.normalize(posix.join(posix.dirname(from), spec));
      const path = extensions
        .map((extension) => base + extension)
        .find((candidate) => {
          try {
            const stat = lstatSync(resolve(root, candidate));
            return !stat.isDirectory() || stat.isSymbolicLink();
          } catch {
            return false;
          }
        });
      if (!path) refuse(`Stats harness local import is unresolved: ${from}`);
      local(path);
      verifyImport(base, path);
      if (!inputs.has(path)) queue.push(path);
      return;
    }
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const entry = lock.packages?.[`node_modules/${name}`];
    if (
      !entry ||
      entry.link === true ||
      typeof entry.version !== 'string' ||
      typeof entry.integrity !== 'string'
    )
      refuse(`Stats harness package is not locked: ${name}`);
  };
  const lock = JSON.parse(readFileSync(local('package-lock.json'), 'utf8'));
  for (const path of CONFIG) bytes += lstatSync(local(path)).size;
  const config = ts.parseConfigFileTextToJson(
    'tsconfig.json',
    readFileSync(local('tsconfig.json'), 'utf8')
  );
  if (config.error || config.config.extends || config.config.references)
    refuse('Stats harness compiler configuration requires a separately qualified closure.');
  const options = config.config.compilerOptions ?? {};
  const paths = options.paths ?? {};
  if (
    !paths ||
    typeof paths !== 'object' ||
    Array.isArray(paths) ||
    Object.keys(paths).length > 128
  )
    refuse('Stats compiler paths exceed the closed configuration.');
  const aliases = Object.keys(paths);
  for (const pattern of aliases)
    if (
      pattern.split('*').length > 2 ||
      !Array.isArray(paths[pattern]) ||
      paths[pattern].length > 16 ||
      paths[pattern].some((target) => typeof target !== 'string')
    )
      refuse('Stats compiler paths exceed the closed configuration.');
  const baseUrl = options.baseUrl === undefined ? null : options.baseUrl;
  if (
    baseUrl !== null &&
    (typeof baseUrl !== 'string' ||
      posix.isAbsolute(baseUrl) ||
      baseUrl.split('/').includes('..') ||
      baseUrl.includes('\\') ||
      /[\x00-\x1f]/.test(baseUrl))
  )
    refuse('Stats compiler baseUrl escapes the closed checkout.');
  while (queue.length) {
    const path = queue.shift();
    if (inputs.has(path)) continue;
    if (inputs.size >= 32) refuse('Stats harness import closure exceeds its bound.');
    inputs.add(path);
    const text = readFileSync(local(path), 'utf8');
    bytes += Buffer.byteLength(text);
    if (bytes > 8 * 1024 * 1024) refuse('Stats harness source exceeds its byte bound.');
    if (path.endsWith('.json')) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (file.parseDiagnostics.length) refuse(`Stats harness source does not parse: ${path}`);
    const visit = (node) => {
      if (++nodes > 100000) refuse('Stats harness AST exceeds its bound.');
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) {
          if (!ts.isStringLiteralLike(node.moduleSpecifier)) refuse('Unknown Stats import.');
          dependency(path, node.moduleSpecifier.text);
        }
      }
      if (ts.isImportEqualsDeclaration(node)) {
        const ref = node.moduleReference;
        if (
          !ts.isExternalModuleReference(ref) ||
          !ref.expression ||
          !ts.isStringLiteralLike(ref.expression)
        )
          refuse('Unknown Stats import assignment.');
        dependency(path, ref.expression.text);
      }
      if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteralLike(node.argument.literal))
          refuse('Unknown Stats import type.');
        dependency(path, node.argument.literal.text);
      }
      if (ts.isNewExpression(node) && node.expression.getText(file) === 'Function')
        refuse('Indirect executable Stats harness inputs are not qualified.');
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(file);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword || name === 'require') {
          if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]))
            refuse('Dynamic Stats harness imports are not qualified.');
          dependency(path, node.arguments[0].text);
        }
        if (['eval', 'Function', 'require.resolve', 'import.meta.glob'].includes(name))
          refuse('Indirect executable Stats harness inputs are not qualified.');
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...inputs].sort();
}

export function qualifyStatsJourneyPin({
  root,
  originalSha,
  bodies,
  git,
  retention,
  verifyRetention,
}) {
  if (!SHA.test(originalSha || '')) refuse('The original client pin is malformed.');
  if (!Array.isArray(bodies) || bodies.length !== 2)
    throw new JourneyUnknown('Both origin reads are required.');
  let live;
  try {
    const shas = bodies.map(readBuildInfoSha);
    if (shas[0] !== shas[1]) throw new Error('Origins disagree.');
    live = shas[0];
  } catch {
    throw new JourneyUnknown('Both origins did not establish one exact published client.');
  }
  const here = git('rev-parse', 'HEAD').trim();
  if (!SHA.test(here)) refuse('Stats control source is malformed.');
  const evidence = {
    commitExists: (sha) => {
      try {
        git('cat-file', '-e', `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    isAncestor: (a, b) => {
      try {
        git('merge-base', '--is-ancestor', a, b);
        return true;
      } catch {
        return false;
      }
    },
  };
  for (const sha of [here, originalSha, live])
    if (!evidence.commitExists(sha) || !evidence.isAncestor(sha, 'origin/main'))
      refuse('Stats source is not on protected main.');
  if (classifyTrustedLineage(live, originalSha, evidence) === 'ancestor')
    refuse('The Stats client moved backwards from the original job pin.');
  const controlInputs = [
    'scripts/ci/downline-journey-pin.mjs',
    'scripts/ci/production-e2e-provenance.mjs',
    'scripts/ci/client-runtime-retention.mjs',
    'scripts/ci/client-runtime-inputs.mjs',
    'scripts/ci/client-runtime-font-inputs.mjs',
    'scripts/ci/publisher-job-identity.mjs',
  ];
  for (const path of controlInputs) {
    const full = resolve(root, path);
    const mode = git('ls-tree', here, '--', path).split(/\s/)[0];
    if (
      !['100644', '100755'].includes(mode) ||
      lstatSync(full).isSymbolicLink() ||
      realpathSync(full) !== resolve(realpathSync(root), path) ||
      git('rev-parse', `${here}:${path}`).trim() !== blobId(readFileSync(full))
    )
      refuse(`The Stats pin control differs from protected source: ${path}`);
  }
  let canonicalSha = live;
  let retainedRuntime = false;
  let retentionAuthority = null;
  if (retention) {
    const run = retention.event?.workflow_run;
    const receipt = readRetentionReceipt(
      retention.raw,
      run?.id,
      run?.head_sha,
      retention.event?.repository?.id
    );
    if (receipt.runtimeSha === live) {
      if (receipt.verificationSha !== here || typeof verifyRetention !== 'function')
        refuse('Retained Stats source is not the exact executed verification source.');
      // The existing harness command proves the complete runtime input seal and
      // both origins' build-info AND manifests. Test blobs cannot replace it.
      verifyRetention(receipt);
      canonicalSha = here;
      retainedRuntime = true;
      retentionAuthority = {
        sourceRunId: receipt.sourceRunId,
        sourceTriggerSha: receipt.sourceTriggerSha,
        repositoryId: receipt.repositoryId,
        runtimeSha: receipt.runtimeSha,
        verificationSha: receipt.verificationSha,
        buildInfoSHA256: receipt.buildInfoSHA256,
        manifestSHA256: receipt.manifestSHA256,
      };
    }
  }
  const modes = new Map();
  const inputs = statsHarnessInputs(root, (base, actualPath) => {
    if (actualPath === null) {
      for (const extension of extensions)
        if (git('ls-tree', canonicalSha, '--', base + extension).trim())
          refuse('Stats canonical package is shadowed by compiler baseUrl.');
      return;
    }
    const canonicalPath = extensions
      .map((extension) => base + extension)
      .find((path) => {
        if (!modes.has(path))
          modes.set(path, git('ls-tree', canonicalSha, '--', path).split(/\s/)[0]);
        const mode = modes.get(path);
        return mode && mode !== '040000';
      });
    if (canonicalPath !== actualPath || !['100644', '100755'].includes(modes.get(canonicalPath)))
      refuse('Stats canonical import resolution differs from the executed harness.');
  });
  const inputBlobs = {};
  for (const path of inputs) {
    const mode = git('ls-tree', canonicalSha, '--', path).split(/\s/)[0];
    const controlMode = git('ls-tree', here, '--', path).split(/\s/)[0];
    const executed = blobId(readFileSync(resolve(root, path)));
    if (
      !['100644', '100755'].includes(mode) ||
      !['100644', '100755'].includes(controlMode) ||
      git('rev-parse', `${canonicalSha}:${path}`).trim() !== executed ||
      git('rev-parse', `${here}:${path}`).trim() !== executed
    )
      refuse(`Stats canonical harness differs from the executed input: ${path}`);
    inputBlobs[path] = executed;
  }
  return {
    schema: 1,
    kind: 'qualified-downline-journey-pin',
    originalSha,
    journeySha: live,
    verificationControlSha: here,
    canonicalHarnessSha: canonicalSha,
    retainedRuntime,
    retentionAuthority,
    inputs,
    inputBlobs,
    controlInputs,
    originShas: bodies.map(readBuildInfoSha),
    fullRuntimeEquivalenceClaimed: false,
  };
}

async function main() {
  const root = process.cwd();
  const receipt = { schema: 1, observedAt: new Date().toISOString(), status: 'unknown' };
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
  let exit = 0;
  try {
    if (process.argv.length !== 2)
      refuse('The downline journey pin has no caller-selected inputs.');
    const bodies = await Promise.all(
      ORIGINS.map(async (origin) => {
        try {
          const response = await fetch(`${origin}/build-info.json?downline-journey=${Date.now()}`, {
            headers: { 'Cache-Control': 'no-cache' },
            redirect: 'error',
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error('Origin unavailable.');
          const chunks = [];
          let size = 0;
          for await (const chunk of response.body) {
            size += chunk.byteLength;
            if (size > 16384) throw new Error('Origin evidence exceeds its byte bound.');
            chunks.push(chunk);
          }
          return Buffer.concat(chunks).toString('utf8');
        } catch {
          throw new JourneyUnknown('The exact Stats origin read is unavailable.');
        }
      })
    );
    receipt.originReadAt = new Date().toISOString();
    try {
      git('fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    } catch {
      throw new JourneyUnknown('The protected-main history read is unavailable.');
    }
    const retainedPath = 'retained-runtime-evidence/retained-runtime.json';
    let retention;
    if (existsSync(retainedPath)) {
      if (process.env.GITHUB_EVENT_NAME !== 'workflow_run' || !process.env.GITHUB_EVENT_PATH)
        refuse('Retained Stats source requires the existing publisher workflow event.');
      if (
        lstatSync(retainedPath).size > 4 * 1024 * 1024 ||
        lstatSync(process.env.GITHUB_EVENT_PATH).size > 4 * 1024 * 1024
      )
        refuse('Retained Stats evidence exceeds its bound.');
      retention = {
        raw: readFileSync(retainedPath, 'utf8'),
        event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
      };
      if (
        process.env.GITHUB_REPOSITORY_ID !== '1132369872' ||
        String(retention.event.repository?.id) !== process.env.GITHUB_REPOSITORY_ID ||
        String(retention.event.workflow_run?.repository?.id) !== process.env.GITHUB_REPOSITORY_ID ||
        retention.event.workflow_run?.head_branch !== 'main'
      )
        refuse('Retained Stats evidence does not name this protected publisher repository.');
    }
    const verifyRetention = (retained) => {
      try {
        execFileSync(
          process.execPath,
          [
            'scripts/ci/client-runtime-retention.mjs',
            'harness',
            retained.runtimeSha,
            retained.verificationSha,
            retainedPath,
            String(retention.event.workflow_run.id),
            retention.event.workflow_run.head_sha,
            String(retention.event.repository.id),
          ],
          { cwd: root, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch {
        refuse('The existing retained-runtime harness did not qualify this Stats source.');
      }
    };
    Object.assign(
      receipt,
      qualifyStatsJourneyPin({
        root,
        originalSha: process.env.LIVE_SHA,
        bodies,
        git,
        retention,
        verifyRetention,
      }),
      { status: 'qualified', qualifiedAt: new Date().toISOString() }
    );
  } catch (error) {
    exit = error instanceof JourneyUnknown ? 3 : 1;
    Object.assign(receipt, { status: exit === 3 ? 'unknown' : 'refused', reason: error.message });
  }
  mkdirSync('e2e-report', { recursive: true });
  writeFileSync('e2e-report/downline-journey-pin.json', JSON.stringify(receipt, null, 2) + '\n');
  console.error(`[downline-journey-pin] ${JSON.stringify(receipt)}`);
  if (exit === 0) console.log(receipt.journeySha);
  process.exitCode = exit;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
