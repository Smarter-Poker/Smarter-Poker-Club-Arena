/**
 * A DEPLOY THAT PROVES ITSELF (2026-09-05).
 *
 * A deploy run reported success and shipped nothing: the container came back
 * on the OLD image and /health.version never changed. Every check the
 * workflow had compared what the engine SAID over HTTP against the target;
 * none remembered what was running BEFORE, and none asked the database what
 * the engine WROTE about itself. These pins keep the two halves of the fix
 * wired to each other and behaving.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');
const SCRIPT = resolve(root, 'scripts/ci/prove-engine-version-moved.mjs');

describe('the workflow records before and proves after', () => {
  it('records the pre-cutover version at the START of the job, best-effort', () => {
    const at = WF.indexOf('name: Record the version production runs before the cutover');
    expect(at).toBeGreaterThan(-1);
    expect(at, 'recorded before the dedupe decides anything').toBeLessThan(
      WF.indexOf('name: Skip if production already serves this commit')
    );
    const block = WF.slice(at, WF.indexOf('- name:', at + 10));
    expect(block).toContain('continue-on-error: true');
    expect(block).toContain('MODE: record');
    expect(block).toContain('node "$ENGINE_RELEASE_PROOF_SCRIPT"');
  });

  it('proves after the promote and before the rollback, so a failed proof rolls back', () => {
    const prove = WF.indexOf("name: 'PROVE the version moved");
    expect(prove).toBeGreaterThan(-1);
    expect(prove).toBeGreaterThan(WF.indexOf('name: Promote :current to the verified build'));
    expect(prove).toBeLessThan(WF.indexOf('name: ROLLBACK'));
    const block = WF.slice(prove, WF.indexOf('- name:', prove + 10));
    expect(block).toContain('id: prove');
    expect(block).toContain('MODE: prove');
    expect(block).toContain("STRICT_PROOF: '1'");
    expect(block).toMatch(/TIMEOUT_S: '240'/);
    expect(block, 'the same gate as the cutover itself').toContain(
      "if: steps.dedupe.outputs.skip != 'true' && steps.drain.outputs.skip != 'true'"
    );
    expect(block, 'no continue-on-error: a failed proof is a failed deploy').not.toContain(
      'continue-on-error'
    );
  });

  it('the database is told a deploy shipped only after exact cutover and proof success', () => {
    expect(WF).toMatch(/SHIPPED: .*steps\.cutover\.outcome == 'success'/);
    expect(WF).toMatch(/SHIPPED: .*steps\.cutover\.outputs\.success == 'true'/);
    expect(WF).toMatch(/SHIPPED: .*steps\.prove\.outcome == 'success'/);
    expect(WF).not.toMatch(/SHIPPED: .*steps\.prove\.outcome != 'failure'/);
    expect(WF).toMatch(
      /SHIPPED: .*steps\.rollback\.outcome == 'success'.*steps\.rollback\.outputs\.target_committed == 'true'/
    );
    expect(WF).toContain("steps.prove.outcome == 'failure' &&");
  });

  it('the job budget grew by the proof, in both places the number lives', () => {
    const timeout = Number(WF.match(/timeout-minutes: (\d+)/)![1]);
    const jobTimeout = Number(WF.match(/JOB_TIMEOUT_S=\$\(\( (\d+) \* 60 \)\)/)![1]);
    expect(jobTimeout, 'the gate must know the real timeout').toBe(timeout);
    const reserve = Number(WF.match(/CUTOVER_RESERVE_S=(\d+)/)![1]);
    expect(reserve, 'reserve covers cutover + verify + a 4-minute proof').toBeGreaterThanOrEqual(
      300 + 240
    );
  });
});

describe('prove-engine-version-moved.mjs', () => {
  let server: Server;
  let port = 0;
  let version = 'deadbeef';
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ version, running: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  // spawn, not spawnSync: the stub server lives on THIS event loop, and a
  // synchronous child would block it, so every fetch would hang for 15 s.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          PATH: process.env.PATH ?? '',
          ENGINE_URL: `http://127.0.0.1:${port}`,
          POLL_S: '1',
          TIMEOUT_S: '1',
          ...env,
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stdout += d.toString()));
      child.on('close', (status) => resolve({ status, stdout }));
    });

  it('record: reads the running version and never fails', async () => {
    version = 'deadbeef';
    const r = await run({ MODE: 'record' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pre-cutover engine version: deadbeef');
  });

  it('prove: FAILS when the version still equals the pre-cutover version', async () => {
    version = 'deadbeef';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=DEPLOY SHIPPED NOTHING::');
    expect(r.stdout).toContain('did not move');
  });

  it('prove: FAILS when a third build is answering', async () => {
    version = 'feedface';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('A third build is answering');
  });

  it('prove: passes the moment the witness reports the target', async () => {
    version = '01234567';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA: '0123456789abcdef',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PROVED');
  });

  it('prove: silence is a warning, never a failure and never a rollback', async () => {
    const r = await run({
      MODE: 'prove',
      ENGINE_URL: 'http://127.0.0.1:1',
      TARGET_SHA: '0123456789abcdef',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::warning title=DEPLOY PROOF INCONCLUSIVE::');
  });

  it('prove: strict release sealing fails closed when every witness is silent', async () => {
    const r = await run({
      MODE: 'prove',
      STRICT_PROOF: '1',
      ENGINE_URL: 'http://127.0.0.1:1',
      TARGET_SHA: '0123456789abcdef',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('The durable release seal was NOT advanced.');
  });

  it('prefers the engine_leader witness and says which one spoke', () => {
    const src = read('scripts/ci/prove-engine-version-moved.mjs');
    expect(src).toContain('FROM public.engine_leader WHERE id = true');
    expect(src).toContain('/rest/v1/engine_leader?select=engine_version,heartbeat_at');
    expect(src, 'a stale leader row is not proof').toContain('heartbeatAgeS <= 60');
    expect(src, 'strict release authority requires the database witness').toContain(
      "!STRICT_PROOF || r.source === 'engine_leader'"
    );
    expect(src, 'the fallback busts the cache').toContain('/health?nocache=');
    expect(src, 'raises the in-app notification publish-watchdog raises').toContain(
      '/rest/v1/rpc/fn_raise_notification'
    );
    expect(src).toContain('ca_incident_recipients?scope=eq.platform&active=eq.true');
  });
});
