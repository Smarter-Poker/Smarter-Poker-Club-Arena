/**
 * sharp-loader - load sharp without ever touching the project's node_modules.
 *
 * `npm install` inside the project under NODE_ENV=production prunes every
 * devDependency (vite, typescript, ...) - that killed CI once already. So
 * when sharp is not importable, it is installed into an isolated prefix in
 * os.tmpdir() and required from there. Returns null on any failure; callers
 * must treat sharp as optional.
 *
 * WHY THE PREFIX IS NOT ONE FIXED PATH (2026-09-03)
 * ------------------------------------------------
 * It was `os.tmpdir()/ca-webp-sharp` for every caller. That was fine while CI
 * ran one job at a time on a GitHub-hosted runner, each with its own machine
 * and its own /tmp. It is not fine now: eight self-hosted runners share one
 * box and one /tmp, so two jobs npm-installing at the same second raced inside
 * the same directory and one of them died with
 *
 *   npm error ENOTEMPTY: directory not empty, rename
 *     '/tmp/ca-webp-sharp/node_modules/sharp' -> '.../.sharp-Xz06ay6F'
 *
 * which failed `CSS Beat E2E` - a REQUIRED check - and so blocked a pull
 * request for a reason that had nothing to do with its diff. Renaming the
 * directory per runner would have hidden it rather than fixed it, because two
 * jobs on the SAME runner (or two agents on a workstation) still collide.
 *
 * So the install is staged in a private directory and published with a single
 * `rename`, which is atomic. Whoever gets there first wins; everyone else
 * discards their copy and uses the winner's. That is correct under any amount
 * of concurrency, including none.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CACHE = path.join(os.tmpdir(), 'ca-webp-sharp');

/** Require sharp out of an already-populated prefix, or null. */
function tryPrefix(prefix) {
  try {
    const pkgPath = path.join(prefix, 'package.json');
    if (!existsSync(path.join(prefix, 'node_modules', 'sharp'))) return null;
    return createRequire(pkgPath)('sharp');
  } catch {
    return null;
  }
}

export async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    // Fast path: a previous job on this box already published the cache, so
    // there is no npm to run and nothing to race over.
    const warm = tryPrefix(CACHE);
    if (warm) return warm;

    console.warn('[sharp-loader] sharp not installed - installing into a temp prefix...');
    // Staging directory is private to this process: pid AND random, because
    // pids are reused and two runners on one box can hold the same one.
    const staging = `${CACHE}.staging.${process.pid}.${randomBytes(4).toString('hex')}`;
    try {
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, 'package.json'), '{"name":"ca-webp-sharp","private":true}\n');
      execSync('npm install --no-save --no-audit --no-fund --loglevel=error sharp', {
        cwd: staging,
        stdio: 'inherit',
        timeout: 180000,
        env: { ...process.env, NODE_ENV: 'development' },
      });

      // Publish atomically. If someone beat us to it, rename fails with
      // EEXIST/ENOTEMPTY - that is not an error, it means the cache we wanted
      // already exists, so use theirs and throw ours away.
      try {
        renameSync(staging, CACHE);
      } catch {
        const theirs = tryPrefix(CACHE);
        if (theirs) {
          rmSync(staging, { recursive: true, force: true });
          return theirs;
        }
        // Nobody published a usable cache; keep serving out of staging rather
        // than failing the build over a directory name.
        return tryPrefix(staging);
      }
      return tryPrefix(CACHE);
    } catch (err) {
      // Never leave a half-installed staging directory behind: the nightly GC
      // ages /tmp by mtime, so debris would sit here for a day looking like a
      // real cache to nobody and consuming space for no reason.
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
      console.warn('[sharp-loader] Could not install sharp:', err?.message || err);
      return null;
    }
  }
}
