/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LAW - A PULL REQUEST THAT IS GREEN AND AHEAD OF MAIN IS QUEUED, NOT STALE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04: "I WILL NEVER LEAVE ANYTHING UNFINISHED FOR MORE THAN 48
 * HOURS. ANYTHING OLDER THEN 48 HOURS IS TRASH." The rule stays. What it means
 * by "unfinished" is what this narrows.
 *
 * On 2026-09-04 the close took six finished, green pull requests - the
 * horse-identity programme - because they were waiting on a merge queue rather
 * than on an author. Recovering them took most of a session: `main` had moved
 * ~800 pull requests, so every branch needed a new base, a re-run against
 * three guards that had landed meanwhile, and a re-review. Closing queued work
 * is what created the drift that made it expensive.
 *
 * THIS IS TESTED BY RUNNING IT, NOT BY READING IT. The script is driven
 * against a stub GitHub API (GITHUB_API_URL) so all three outcomes are
 * exercised for real: green-and-ahead gets the label, red loses it, and an
 * unreadable answer changes nothing. A regex over the source could not tell
 * the difference between those and would pass on a script that guesses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(__dirname, '..');
const SCRIPT = join(root, '.github/scripts/label-queued-pull-requests.mjs');

/** Every label write the script attempted, so we can assert on side effects. */
const writes: string[] = [];

const REQUIRED = ['TypeScript Check', 'Production Build'];

const checkRuns = (state: 'green' | 'red') => ({
  check_runs: REQUIRED.map((name, i) => ({
    name,
    status: 'completed',
    started_at: '2026-09-08T00:00:00Z',
    conclusion: state === 'green' || i === 0 ? 'success' : 'failure',
  })),
});

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url || '';
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method !== 'GET') {
      writes.push(`${req.method} ${url}`);
      return send(200, {});
    }
    if (url.startsWith('/repos/o/r/rulesets?')) return send(200, [{ id: 1 }]);
    if (url === '/repos/o/r/rulesets/1')
      return send(200, {
        rules: [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: REQUIRED.map((c) => ({ context: c })) },
          },
        ],
      });
    if (url.startsWith('/repos/o/r/pulls?'))
      return send(200, [
        // green + ahead, unlabelled  -> gains `queued`
        { number: 1, draft: false, labels: [], base: { ref: 'main' }, head: { sha: 'green' } },
        // red + ahead, already labelled -> loses it
        {
          number: 2,
          draft: false,
          labels: [{ name: 'queued' }],
          base: { ref: 'main' },
          head: { sha: 'red' },
        },
        // checks unreadable, already labelled -> left exactly as it is
        {
          number: 3,
          draft: false,
          labels: [{ name: 'queued' }],
          base: { ref: 'main' },
          head: { sha: 'secret' },
        },
        // green but BEHIND main -> not queued
        { number: 4, draft: false, labels: [], base: { ref: 'main' }, head: { sha: 'behind' } },
        // green + ahead but a DRAFT -> not queued
        { number: 5, draft: true, labels: [], base: { ref: 'main' }, head: { sha: 'green' } },
      ]);
    if (url.startsWith('/repos/o/r/compare/'))
      return send(200, { ahead_by: url.endsWith('behind') ? 0 : 3 });
    if (url.includes('/commits/green/check-runs')) return send(200, checkRuns('green'));
    if (url.includes('/commits/red/check-runs')) return send(200, checkRuns('red'));
    if (url.includes('/commits/behind/check-runs')) return send(200, checkRuns('green'));
    // The 403 that a token without `checks: read` really gets. Its body has no
    // `check_runs` key at all - the shape that reads as "nothing failed" if
    // anyone coerces it with `?? []`.
    if (url.includes('/commits/secret/check-runs'))
      return send(403, { message: 'Resource not accessible by personal access token' });
    return send(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(() => server?.close());

async function runScript() {
  writes.length = 0;
  const { stdout } = await run('node', [SCRIPT], {
    env: {
      ...process.env,
      GITHUB_TOKEN: 'stub',
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_API_URL: base,
      GITHUB_STEP_SUMMARY: '',
    },
  });
  return stdout;
}

describe('LAW: a queued pull request is not stale', () => {
  it('labels a green pull request that is ahead of main, and restarts its clock', async () => {
    const out = await runScript();
    expect(out).toMatch(/#1 \+ queued \(green, 3 ahead\)/);
    expect(writes).toContain('POST /repos/o/r/issues/1/labels');
    // Waiting on the queue is not waiting on its author: the stale label goes.
    expect(writes).toContain('DELETE /repos/o/r/issues/1/labels/stale');
  });

  it('takes the label back the moment a pull request stops qualifying', async () => {
    await runScript();
    expect(writes).toContain('DELETE /repos/o/r/issues/2/labels/queued');
  });

  it('changes NOTHING when it cannot read the checks, and says so', async () => {
    const out = await runScript();
    expect(out).toMatch(/#3 unknown \(checks unreadable\) - labels left as they are/);
    // The trap this law exists for: a 403 must not read as "not green" and
    // strip the protection off work that is fine.
    expect(writes).not.toContain('DELETE /repos/o/r/issues/3/labels/queued');
    expect(out).toMatch(/1 could not be read/);
  });

  it('does not queue a pull request that is behind main, or a draft', async () => {
    const out = await runScript();
    expect(writes).not.toContain('POST /repos/o/r/issues/4/labels');
    expect(writes).not.toContain('POST /repos/o/r/issues/5/labels');
    expect(out).toMatch(/1 newly queued/);
  });

  it('the workflow exempts the label it writes, and can read what it needs', () => {
    const yml = readFileSync(join(root, '.github/workflows/stale.yml'), 'utf8');
    expect(yml).toContain('label-queued-pull-requests.mjs');
    expect(yml).toMatch(/exempt-pr-labels:\s*'pinned,do-not-close,queued'/);
    /* Without `checks: read` the step 403s on every pull request, reports
       "could not tell", changes nothing - and the exemption protects no one
       while still looking like it works. */
    expect(yml).toMatch(/^\s+checks: read$/m);
    expect(yml).toMatch(/^\s+contents: read$/m);
  });
});
