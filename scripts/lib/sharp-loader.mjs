/**
 * sharp-loader — load sharp without ever touching the project's node_modules.
 *
 * `npm install` inside the project under NODE_ENV=production prunes every
 * devDependency (vite, typescript, ...) — that killed CI once already. So
 * when sharp is not importable, it is installed into an isolated prefix in
 * os.tmpdir() and required from there. Returns null on any failure; callers
 * must treat sharp as optional.
 */

import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    console.warn('[sharp-loader] sharp not installed — installing into a temp prefix...');
    try {
      const tmp = path.join(os.tmpdir(), 'ca-webp-sharp');
      mkdirSync(tmp, { recursive: true });
      const pkgPath = path.join(tmp, 'package.json');
      if (!existsSync(pkgPath)) {
        writeFileSync(pkgPath, '{"name":"ca-webp-sharp","private":true}\n');
      }
      execSync('npm install --no-save --no-audit --no-fund --loglevel=error sharp', {
        cwd: tmp,
        stdio: 'inherit',
        timeout: 180000,
        env: { ...process.env, NODE_ENV: 'development' },
      });
      const requireFromTmp = createRequire(pkgPath);
      return requireFromTmp('sharp');
    } catch (err) {
      console.warn('[sharp-loader] Could not install sharp:', err?.message || err);
      return null;
    }
  }
}
