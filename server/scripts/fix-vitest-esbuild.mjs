#!/usr/bin/env node
/**
 * Repair the vitest/vite esbuild binary mismatch.
 *
 * Symptom: every `npx vitest run` dies with
 *   "Cannot start service: Host version 0.21.5 does not match binary version 0.27.3"
 * and the ENTIRE server test suite is un-runnable. It was in exactly that state
 * on 2026-08-15 — which is why a 20-defect freeze audit initially had no test
 * coverage to lean on. A silently dead test suite is its own outage.
 *
 * Cause: `node_modules/vite/node_modules/@esbuild/` contains only the platform
 * package npm resolved at install time (linux-arm64 here, from a container
 * install). On a Mac the nested esbuild JS then falls back to the top-level
 * binary, which is a different esbuild major, and refuses to start.
 *
 * Fix: place the matching platform binary inside vite's nested tree.
 * Idempotent and wired to `pretest`, so the suite repairs itself.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const NESTED = 'node_modules/vite/node_modules';
const esbuildPkg = join(NESTED, 'esbuild/package.json');
if (!existsSync(esbuildPkg)) {
  console.log('[fix-vitest-esbuild] no nested vite esbuild — nothing to do');
  process.exit(0);
}
const want = JSON.parse(readFileSync(esbuildPkg, 'utf8')).version;
const plat = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const target = join(NESTED, '@esbuild', plat, 'bin/esbuild');

if (existsSync(target)) {
  try {
    const have = execSync(`"${target}" --version`, { encoding: 'utf8' }).trim();
    if (have === want) {
      console.log(`[fix-vitest-esbuild] ok — ${plat} ${have} already matches`);
      process.exit(0);
    }
  } catch {
    /* fall through and reinstall */
  }
}

try {
  console.log(`[fix-vitest-esbuild] installing @esbuild/${plat}@${want} into vite's nested tree`);
  const tmp = execSync('mktemp -d', { encoding: 'utf8' }).trim();
  execSync(`npm pack @esbuild/${plat}@${want} --silent`, { cwd: tmp });
  const tgz = execSync('ls *.tgz', { cwd: tmp, encoding: 'utf8' }).trim();
  execSync(`tar xzf ${tgz}`, { cwd: tmp });
  mkdirSync(join(NESTED, '@esbuild', plat, 'bin'), { recursive: true });
  copyFileSync(join(tmp, 'package/bin/esbuild'), target);
  copyFileSync(join(tmp, 'package/package.json'), join(NESTED, '@esbuild', plat, 'package.json'));
  chmodSync(target, 0o755);
  console.log(`[fix-vitest-esbuild] done — ${plat} ${want} installed`);
} catch (err) {
  // Never block the test run on this repair; surface it and continue.
  console.warn('[fix-vitest-esbuild] repair failed (tests may not start):', err?.message ?? err);
}
