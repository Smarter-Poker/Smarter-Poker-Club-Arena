/**
 * A DEGRADED ENGINE CAN STILL BE REPLACED (2026-09-11).
 *
 * /health answers 503 whenever the engine is not ROUTING-ready: `status` is
 * 'degraded' while the equity pool, the horse decision worker or the dealer
 * prerequisites are not ready. It sends the SAME body either way, and
 * server/src/handlers/health.ts says so in as many words, naming the deploy
 * verifier as the reader the body is kept for.
 *
 * The deploy train read it with `curl -sf`. `-f` turns every non-2xx answer
 * into an empty string, so from the moment the equity pool went 'failed'
 * (06:58 UTC, after the thaw surge) every read was "/health unreadable".
 * Run 34571396262 polled its break gate 175 times, logged that line every
 * time, and let a complete readyForRestart certificate go by: at 07:55:08
 * the body said counting_down, durable, 0 unparked, 290 s left. The build
 * that would have replaced the degraded engine could not ship BECAUSE the
 * engine was degraded, and the host's own locked re-check used the same
 * `-f`, so fixing the runner alone would still have refused the cutover.
 *
 * The rule pinned here: a read that asks WHAT the engine is (its restart
 * certificate, its version) reads the body whatever the HTTP code. Only the
 * post-cutover verification and the recovery verification keep `-f`, on
 * purpose: a new or recovered build is not verified until it answers a
 * routing-ready 200.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const WF = readFileSync(resolve(root, '.github/workflows/auto-deploy-hetzner.yml'), 'utf8');
const HEALTH_HANDLER = readFileSync(resolve(root, 'server/src/handlers/health.ts'), 'utf8');

/** Every step of the deploy job, keyed by its name. */
function steps(): Map<string, string> {
  const out = new Map<string, string>();
  const parts = WF.split(/\n(?= {6}- name: )/);
  for (const part of parts.slice(1)) {
    const name = part.slice('      - name: '.length, part.indexOf('\n')).replace(/^'|'$/g, '');
    out.set(name, part);
  }
  return out;
}

function step(prefix: string): string {
  const hit = [...steps().entries()].filter(([name]) => name.startsWith(prefix));
  expect(hit, `exactly one step named "${prefix}..."`).toHaveLength(1);
  return hit[0][1];
}

/** The literal `run: |` script of a step, dedented. */
function runScript(block: string): string {
  const lines = block.split('\n');
  const start = lines.findIndex((l) => /^ {8}run: \|\s*$/.test(l));
  expect(start, 'the step has a run: | block').toBeGreaterThan(-1);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

/** `curl` reads of /health that would discard a 503 body. */
function failingHealthReads(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && /\bcurl\b/.test(l) && /\/health\b/.test(l))
    .filter((l) => {
      const flags = l.slice(l.indexOf('curl'), l.indexOf('/health'));
      return /(^|\s)-(?!-)[A-Za-z]*f[A-Za-z]*(\s|$)|--fail\b/.test(flags);
    });
}

describe('the restart certificate and the version are read from the body, whatever the code', () => {
  it('the health handler still sends one body for 200 and 503 (the contract this law relies on)', () => {
    expect(HEALTH_HANDLER).toMatch(/sendJSON\(res, dealerReady \? 200 : 503, status\)/);
  });

  for (const name of [
    'Skip if production already serves this commit',
    'Wait for the maintenance break to park every table',
    'Cut over to the new image',
    'Commit the verified SHA/image-ID release seal',
    'Verdict — green only if production serves this commit',
  ]) {
    it(`"${name}" never reads /health with curl -f`, () => {
      const block = step(name);
      expect(block).toMatch(/\/health/);
      expect(failingHealthReads(block)).toEqual([]);
    });
  }

  it('only the two verification steps keep -f, and they say why', () => {
    const owners = [...steps().entries()]
      .filter(([, block]) => failingHealthReads(block).length > 0)
      .map(([name]) => name);
    expect(owners.sort()).toEqual(
      [
        'ROLLBACK — restore the last known-good image',
        'Verify — liveness AND that the running build is the one we shipped',
      ].sort()
    );
    expect(step('Verify — liveness')).toMatch(/`-f` is deliberate HERE and only here/);
  });

  it('the host re-check under the lock still fails closed when nothing answers', () => {
    const cutover = step('Cut over to the new image');
    // set -euo pipefail inside the ssh script: a refused connection aborts
    // before the mutation marker is printed.
    const script = runScript(cutover);
    const guard = script.indexOf('set -euo pipefail');
    const read = script.indexOf('BODY=\\$(curl -s --max-time 10 http://127.0.0.1:8080/health)');
    const marker = script.indexOf("echo '$MUTATION_MARKER'");
    expect(guard).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(guard);
    expect(marker).toBeGreaterThan(read);
  });
});

describe('the break gate, run for real against an engine that is degraded but certified', () => {
  const CERTIFIED_BUT_DEGRADED = {
    status: 'degraded',
    liveness: 'ok',
    running: true,
    version: 'c58dfafd',
    equityWorkerPool: {
      phase: 'failed',
      lastError: 'Equity worker operation timed out after 2500ms',
    },
    maintenance: {
      active: true,
      phase: 'counting_down',
      durableConfirmed: true,
      readyForRestart: true,
      unparkedTables: 0,
      remainingMs: 290_924,
    },
  };
  let server: Server;
  let url = '';

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify(CERTIFIED_BUT_DEGRADED));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((done) => server.close(() => done())));

  // spawn, not spawnSync: the stub server lives on THIS event loop.
  const run = (cmd: string, args: string[], env: Record<string, string>) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(cmd, args, { env: { ...process.env, ...env } });
      let out = '';
      child.stdout.on('data', (b) => (out += b));
      child.stderr.on('data', (b) => (out += b));
      const kill = setTimeout(() => child.kill('SIGKILL'), 45_000);
      child.on('close', (code) => {
        clearTimeout(kill);
        done({ code, out });
      });
    });

  it('the stub really is a 503, and the old `curl -sf` read really discarded it', async () => {
    // node:http, not fetch: the root suite runs under happy-dom, whose fetch
    // applies browser CORS rules to a loopback stub.
    const status = await new Promise<number | undefined>((done) =>
      get(`${url}/health`, (res) => {
        res.resume();
        done(res.statusCode);
      })
    );
    expect(status).toBe(503);
    const old = await run('curl', ['-sf', '--max-time', '10', `${url}/health`], {});
    expect(old.code).toBe(22);
    expect(old.out).toBe('');
  });

  it('accepts the certificate on the first poll and cuts over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'degraded-gate-'));
    const output = join(dir, 'github_output');
    writeFileSync(output, '');
    const script = runScript(step('Wait for the maintenance break to park every table'));
    const { code, out } = await run('bash', ['-e', '-c', script], {
      ENGINE_URL: url,
      GITHUB_OUTPUT: output,
      SHA: '0123456789abcdef0123456789abcdef01234567',
      IMAGE_REPO: 'club-arena-engine',
      DEPLOY_STARTED_AT: String(Math.floor(Date.now() / 1000)),
    });
    expect(out).not.toMatch(/unreadable/);
    expect(out).toMatch(
      /attempt 1\/\d+: break is running and every table is parked — restarting now/
    );
    expect(code).toBe(0);
    const recorded = readFileSync(output, 'utf8');
    expect(recorded).toMatch(/^skip=false$/m);
    expect(recorded).not.toMatch(/^skip=true$/m);
  }, 60_000);
});
