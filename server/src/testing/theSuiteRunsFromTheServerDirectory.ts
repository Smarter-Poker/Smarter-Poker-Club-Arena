/**
 * THE SERVER SUITE RESOLVES ITS PATHS FROM THE WORKING DIRECTORY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 68 files in this suite read engine source with
 * `readFileSync(path.join(process.cwd(), 'src/...'))`. That is correct exactly
 * once: when vitest is invoked from INSIDE `server/`, which is what
 * `.husky/pre-push` (`cd server && vitest run`) and `ci.yml` both do.
 *
 * `vitest run --root server` from the repo root looks like the same thing and
 * is not: `--root` moves the CONFIG root and leaves `process.cwd()` at the
 * repo root, so every one of those 68 files opens `<repo>/src/...`, which does
 * not exist. On 2026-09-06 that produced nineteen failing files with
 *
 *     Error: ENOENT: no such file or directory, open '<repo>/src/GameServer.ts'
 *
 * and nothing anywhere in the output saying the invocation was the problem.
 * Twenty minutes went into asking which change had broken the tournament
 * suite; the answer was that nothing had.
 *
 * That is CLAUDE.md 10.86 rule 1 - "I could not tell" is a distinct outcome
 * and must have its own name. An ENOENT for a path nobody wrote is the suite
 * failing to say it was started in the wrong place.
 *
 * This file does not change how the suite runs. It refuses to run at all from
 * the wrong directory, and says which directory and which command. Rewriting
 * all 68 to resolve from `__dirname` would also work and is welcome one file
 * at a time; it is 68 files across every open branch, so the cheap half is
 * here and the expensive half can follow whenever those files are touched for
 * other reasons.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// server/src/testing/<this file>  ->  server/
const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, '..', '..');

const cwd = process.cwd();

if (resolve(cwd) !== SERVER_ROOT) {
  throw new Error(
    [
      '',
      'The server test suite must be run from the server directory.',
      '',
      `  working directory: ${cwd}`,
      `  expected:          ${SERVER_ROOT}`,
      '',
      '68 test files in this suite read engine source through process.cwd().',
      '`vitest run --root server` from the repo root does NOT set the working',
      'directory, so those files look for `src/...` beside the repo root and',
      'fail with an ENOENT that names no cause.',
      '',
      'Run it the way the pre-push hook and CI do:',
      '',
      '  cd server && npx vitest run',
      '',
    ].join('\n')
  );
}
