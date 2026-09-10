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
import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const root = resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
const WF = read('.github/workflows/auto-deploy-hetzner.yml');
const SCRIPT = resolve(root, 'scripts/ci/prove-engine-version-moved.mjs');
const TARGET_SHA = '0123456789abcdef0123456789abcdef01234567';
const TARGET_SHORT = TARGET_SHA.slice(0, 8);
const TARGET_IMAGE = `sha256:${'1'.repeat(64)}`;

const DEDUPE = (() => {
  const start = WF.indexOf('name: Skip if production already serves this commit');
  const end = WF.indexOf('\n      - name: ', start + 1);
  if (start < 0 || end < 0) throw new Error('exact dedupe step not found');
  return WF.slice(start, end);
})();

const EXACT_AUTHORITY_PY = (() => {
  const marker = `printf '%s' "$inventory" | python3 -c '\n`;
  const start = DEDUPE.indexOf(marker) + marker.length;
  const end = DEDUPE.indexOf(
    `\n          ' "$CONTAINER" "$SEALED_IMAGE_ID" "$TARGET_SHA" "$SEALED_LEGACY" "$PORT"`,
    start
  );
  if (start < marker.length || end < start) throw new Error('exact authority Python not found');
  return DEDUPE.slice(start, end).replace(/^ {10}/gm, '');
})();

type DockerInspectRow = {
  Id: string;
  Name: string;
  Image: string;
  Config: { Labels: Record<string, string> };
  State: { Status: string; StartedAt: string };
  HostConfig: {
    RestartPolicy: { Name: string };
    PortBindings: Record<string, Array<{ HostIp: string; HostPort: string }>>;
  };
};

const exactEngineRow = (): DockerInspectRow => ({
  Id: 'container-id',
  Name: '/club-arena-engine',
  Image: TARGET_IMAGE,
  Config: {
    Labels: {
      'sp.role': 'engine',
      'sp.release.sha': TARGET_SHA,
      autoheal: 'true',
    },
  },
  State: { Status: 'running', StartedAt: '2026-09-10T05:00:00.000000000Z' },
  HostConfig: {
    RestartPolicy: { Name: 'always' },
    PortBindings: { '8080/tcp': [{ HostIp: '', HostPort: '8080' }] },
  },
});

const runExactAuthorityValidator = (rows: DockerInspectRow[], legacy = 'false') =>
  spawnSync(
    'python3',
    ['-c', EXACT_AUTHORITY_PY, 'club-arena-engine', TARGET_IMAGE, TARGET_SHA, legacy, '8080'],
    { input: JSON.stringify(rows), encoding: 'utf8' }
  );

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

  it('dedupes only when public, database, durable seal, and exact host identity agree', () => {
    const sshAt = WF.indexOf('name: Setup SSH key');
    const dedupeAt = WF.indexOf('name: Skip if production already serves this commit');
    expect(sshAt).toBeGreaterThan(-1);
    expect(sshAt).toBeLessThan(dedupeAt);
    expect(WF.match(/name: Setup SSH key/g) ?? []).toHaveLength(1);

    expect(DEDUPE).toContain('MODE=match TARGET_SHA="$SHA" node "$ENGINE_RELEASE_PROOF_SCRIPT"');
    expect(DEDUPE).toContain('engine-release-seal.py get desired-sha');
    expect(DEDUPE).toContain('engine-release-seal.py get desired-image-id');
    expect(DEDUPE).toContain('classify-running --container "$CONTAINER" --with-sha');
    expect(DEDUPE).toContain('= "desired $TARGET_SHA"');
    expect(DEDUPE).toContain('docker ps -aq');
    expect(DEDUPE).toContain('docker container inspect $ids');
    expect(DEDUPE).toContain('sp.release.sha');
    expect(DEDUPE).toContain('sp-autoheal');
    expect(DEDUPE).toContain("curl -q -sf --noproxy '*'");
    expect(DEDUPE).toContain('docker tag "$SEALED_IMAGE_ID" "$CURRENT_IMAGE"');
    expect(DEDUPE).toContain('case "$HOST_RESULT:$FINAL_VER"');
    expect(DEDUPE.indexOf('echo "skip=true"')).toBeGreaterThan(
      DEDUPE.indexOf('case "$HOST_RESULT:$FINAL_VER"')
    );
    expect(DEDUPE).toMatch(
      /if \[ "\$PUBLIC_MATCH" != "true" \][\s\S]*?SINCE_SHIPPED_N.*MIN_RESTART_SPACING_SEC/
    );
  });

  it('executes the all-container validator and rejects incomplete or competing host authority', () => {
    const valid = runExactAuthorityValidator([exactEngineRow()]);
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout.trim()).toBe(`container-id|2026-09-10T05:00:00.000000000Z|${TARGET_IMAGE}`);

    const mutations: Array<(rows: DockerInspectRow[]) => void> = [
      (rows) => {
        rows[0].Config.Labels.autoheal = 'false';
      },
      (rows) => {
        rows[0].Config.Labels['sp.release.sha'] = 'f'.repeat(40);
      },
      (rows) => {
        rows[0].HostConfig.RestartPolicy.Name = 'no';
      },
      (rows) => {
        rows[0].HostConfig.PortBindings['8080/tcp'][0].HostIp = '127.0.0.1';
      },
      (rows) => {
        rows[0].Image = `sha256:${'2'.repeat(64)}`;
      },
      (rows) => {
        const rogue = exactEngineRow();
        rogue.Id = 'rogue-labelled';
        rogue.Name = '/rogue-labelled';
        rogue.State.Status = 'exited';
        rogue.HostConfig.PortBindings = {};
        rows.push(rogue);
      },
      (rows) => {
        const rogue = exactEngineRow();
        rogue.Id = 'rogue-publisher';
        rogue.Name = '/rogue-publisher';
        rogue.Config.Labels = {};
        rows.push(rogue);
      },
    ];

    for (const mutate of mutations) {
      const rows = [exactEngineRow()];
      mutate(rows);
      const rejected = runExactAuthorityValidator(rows);
      expect(rejected.status).toBe(1);
      expect(rejected.stdout).toBe('');
    }

    const legacy = exactEngineRow();
    delete legacy.Config.Labels['sp.release.sha'];
    expect(runExactAuthorityValidator([legacy], 'true').status).toBe(0);
    expect(runExactAuthorityValidator([legacy], 'false').status).toBe(1);
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
  let healthVersion = 'deadbeef';
  let leaderVersion: string | null = 'deadbeef';
  let leaderHeartbeatAgeS = 0;
  let leaderReadable = true;
  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/rest/v1/engine_leader')) {
        if (!leaderReadable) {
          res.statusCode = 503;
          res.end(JSON.stringify({ message: 'database unavailable' }));
          return;
        }
        res.end(
          JSON.stringify(
            leaderVersion === null
              ? []
              : [
                  {
                    engine_version: leaderVersion,
                    heartbeat_at: new Date(Date.now() - leaderHeartbeatAgeS * 1000).toISOString(),
                  },
                ]
          )
        );
        return;
      }
      res.end(JSON.stringify({ version: healthVersion, running: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());
  beforeEach(() => {
    healthVersion = 'deadbeef';
    leaderVersion = 'deadbeef';
    leaderHeartbeatAgeS = 0;
    leaderReadable = true;
  });

  // spawn, not spawnSync: the stub server lives on THIS event loop, and a
  // synchronous child would block it, so every fetch would hang for 15 s.
  const run = (env: Record<string, string>) =>
    new Promise<{ status: number | null; stdout: string }>((resolve) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: {
          PATH: process.env.PATH ?? '',
          ENGINE_URL: `http://127.0.0.1:${port}`,
          SUPABASE_URL: `http://127.0.0.1:${port}`,
          SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
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
    leaderVersion = 'deadbeef';
    const r = await run({ MODE: 'record' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pre-cutover engine version: deadbeef');
  });

  it('prove: FAILS when the version still equals the pre-cutover version', async () => {
    leaderVersion = 'deadbeef';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA,
      STRICT_PROOF: '1',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error title=DEPLOY SHIPPED NOTHING::');
    expect(r.stdout).toContain('did not move');
  });

  it('prove: FAILS when a third build is answering', async () => {
    leaderVersion = 'feedface';
    const r = await run({
      MODE: 'prove',
      TARGET_SHA,
      STRICT_PROOF: '1',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('A third build is answering');
  });

  it('prove: passes the moment the witness reports the target', async () => {
    leaderVersion = TARGET_SHORT;
    const r = await run({
      MODE: 'prove',
      TARGET_SHA,
      STRICT_PROOF: '1',
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PROVED');
  });

  it('prove: silence is a warning, never a failure and never a rollback', async () => {
    const r = await run({
      MODE: 'prove',
      ENGINE_URL: 'http://127.0.0.1:1',
      SUPABASE_URL: 'http://127.0.0.1:1',
      TARGET_SHA,
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
      SUPABASE_URL: 'http://127.0.0.1:1',
      TARGET_SHA,
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('The durable release seal was NOT advanced.');
  });

  it('match: permits dedupe only for a fresh exact database leader', async () => {
    leaderVersion = TARGET_SHORT;
    const exact = await run({ MODE: 'match', TARGET_SHA });
    expect(exact.status).toBe(0);
    expect(exact.stdout).toContain(`MATCHED: fresh engine_leader reports ${TARGET_SHORT}`);

    leaderHeartbeatAgeS = 120;
    healthVersion = TARGET_SHORT;
    const stale = await run({ MODE: 'match', TARGET_SHA });
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain('NOT MATCHED');
    expect(stale.stdout).not.toContain('DEPLOY SHIPPED NOTHING');
  });

  it('match: accepts bounded negative skew but rejects a future heartbeat beyond one minute', async () => {
    leaderVersion = TARGET_SHORT;
    leaderHeartbeatAgeS = -30;
    expect((await run({ MODE: 'match', TARGET_SHA })).status).toBe(0);

    leaderHeartbeatAgeS = -120;
    const future = await run({ MODE: 'match', TARGET_SHA });
    expect(future.status).toBe(1);
    expect(future.stdout).toContain('NOT MATCHED');
  });

  it('match: rejects an empty database row even when HTTP names the target', async () => {
    leaderVersion = null;
    healthVersion = TARGET_SHORT;
    const r = await run({ MODE: 'match', TARGET_SHA });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('database leader row is empty');
  });

  it('strict proof rejects HTTP-only agreement when the database is unreadable', async () => {
    leaderReadable = false;
    healthVersion = TARGET_SHORT;
    const r = await run({
      MODE: 'prove',
      STRICT_PROOF: '1',
      TARGET_SHA,
      PRE_CUTOVER_VERSION: 'deadbeef',
    });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('strict sealing still requires engine_leader');
  });

  it('rejects targets that are not one lowercase full commit SHA', async () => {
    leaderVersion = TARGET_SHORT;
    for (const invalid of [TARGET_SHA.slice(0, 16), TARGET_SHA.toUpperCase(), `${TARGET_SHA}00`]) {
      const r = await run({ MODE: 'match', TARGET_SHA: invalid });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('immutable lowercase 40-hex commit');
    }
  });

  it('prefers the engine_leader witness and says which one spoke', () => {
    const src = read('scripts/ci/prove-engine-version-moved.mjs');
    expect(src).toContain('FROM public.engine_leader WHERE id = true');
    expect(src).toContain('/rest/v1/engine_leader?select=engine_version,heartbeat_at');
    expect(src, 'a stale leader row is not proof').toContain('heartbeatAgeS <= 60');
    expect(src, 'future timestamps beyond bounded clock skew are not proof').toContain(
      'heartbeatAgeS >= -60'
    );
    expect(src, 'a SQL NULL heartbeat age is not coerced to zero').toContain(
      'rows[0].age === null ? null : Number(rows[0].age)'
    );
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
