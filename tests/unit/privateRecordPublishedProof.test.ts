import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  hasLiveGatewayReady,
  type PrivateRecordObservation,
} from '../e2e/support/privateRecordObservation';
import {
  admitPrivateRecordClientProof,
  assertQualifiedGateway,
  readPrivateRecordClientPin,
  assertPrivateRecordClientProof,
  PRIVATE_RECORD_CLIENT_TITLE,
} from '../../scripts/ci/private-record-client-proof.mjs';
import { installPrivateRecordEngineInterruption } from '../e2e/support/privateRecordEngineInterruption';
const client = 'a'.repeat(40),
  gateway = 'b'.repeat(40);
const input = () => ({ clientSha: client, gatewaySha: gateway, gatewayRunId: '123' });
const environment = () => ({
  GITHUB_EVENT_NAME: 'repository_dispatch',
  RECORD_CLIENT_PROOF_ACTION: 'run-private-record-client-proof',
  GITHUB_REPOSITORY: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
  GITHUB_REPOSITORY_ID: '1132369872',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: 'c'.repeat(40),
});
const payload = () => ({ client_sha: client, gateway_sha: gateway, gateway_run_id: '123' });
const run = () => ({
  repository: { id: 1132369872, full_name: environment().GITHUB_REPOSITORY },
  id: 123,
  head_sha: gateway,
  head_branch: 'main',
  path: '.github/workflows/publish-club-arena.yml',
  event: 'repository_dispatch',
  status: 'completed',
  conclusion: 'success',
});
const jobs = () => [
  {
    name: 'run-publication / publish-record-gateway',
    status: 'completed',
    conclusion: 'success',
    steps: [
      'Activate only the prepared independent service',
      'Verify authenticated gateway record delivery',
      'Ensure the reserved gateway canary account is retired',
    ].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
  },
];
const gatewayEvidence = () => ({
  schema: 1,
  component: 'private-record-gateway-live',
  revision: gateway,
  genuineAuthAndSession: true,
  allowedRosterReady: true,
  deniedForeignTopic: true,
  cosmeticSourceInvalidation: true,
  readerReadback: true,
  cleanupVerified: true,
  paidRetirementQualified: false,
});
const pin = () => ({
  clientSha: client,
  gatewaySha: gateway,
  paidSourceEnabled: true,
  origins: [
    { url: 'https://smarter.poker/hub/club-arena/build-info.json', sha: client },
    { url: 'https://ca-static.smarter.poker/build-info.json', sha: client },
  ],
});
const browserEvidence = () => ({
  clientSha: client,
  gatewaySha: gateway,
  actualPublishedClient: true,
  genuineSession: true,
  engineReadyBefore: true,
  isolatedEngineChannelFault: true,
  gatewayReadyAfterFault: true,
  gatewayRecordChanged: true,
  readerReadback: true,
  visibleAvatarReadback: true,
  engineReadyAfterRestore: true,
  gatewayRecordChangedAfterRestore: true,
  secondVisibleAvatarReadback: true,
  faultRestored: true,
  cosmeticWrites: 2,
  syntheticFrames: 0,
  paidIsolation: {
    activeAtStart: 0,
    activeAtEnd: 0,
    joins: 0,
    matchingChangedFrames: 0,
    observedFrames: 0,
  },
  gatewayRetention: {
    openSocketsBeforeSecondWrite: 1,
    openSocketsAfterSecondWrite: 1,
    matchingChangesAfterRecovery: 1,
  },
  observationsOverflow: false,
  paidRetirementQualified: false,
});
function report(evidence = browserEvidence()) {
  return {
    errors: [],
    suites: [
      {
        specs: [
          {
            file: 'production-private-record-failover.spec.ts',
            title: PRIVATE_RECORD_CLIENT_TITLE,
            ok: true,
            tests: [
              {
                projectName: 'chromium',
                status: 'expected',
                expectedStatus: 'passed',
                results: [
                  {
                    status: 'passed',
                    retry: 0,
                    errors: [],
                    attachments: [
                      {
                        name: 'published-private-record-failover',
                        contentType: 'application/json',
                        body: Buffer.from(JSON.stringify(evidence)).toString('base64'),
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}
describe('finite published record client proof admission and verdict', () => {
  it('accepts retained readiness only on an open gateway with no later refusal', () => {
    const ready: PrivateRecordObservation = {
      endpoint: 'gateway',
      socket: 1,
      topic: 'member-record:fixture',
      type: 'PRIVATE_RECORD_STATUS',
      ready: true,
    };
    const frames = [ready];
    expect(hasLiveGatewayReady(frames, new Set([1]), ready.topic)).toBe(true);
    expect(hasLiveGatewayReady(frames, new Set(), ready.topic)).toBe(false);
    expect(hasLiveGatewayReady(frames, new Set([2]), ready.topic)).toBe(false);
    expect(hasLiveGatewayReady(frames, new Set([1]), 'foreign')).toBe(false);
    expect(hasLiveGatewayReady([{ ...ready, endpoint: 'engine' }], new Set([1]), ready.topic)).toBe(
      false
    );
    expect(
      hasLiveGatewayReady([...frames, { ...ready, ready: false }], new Set([1]), ready.topic)
    ).toBe(false);
    expect(
      hasLiveGatewayReady(
        [...frames, { ...ready, ready: false }, { ...ready, socket: 2 }],
        new Set([2]),
        ready.topic
      )
    ).toBe(true);
  });
  it('accepts only the fixed protected event and exact identity-only payload', () => {
    expect(admitPrivateRecordClientProof(payload(), environment())).toEqual(input());
    for (const patch of [
      { GITHUB_REF: 'refs/heads/feature' },
      { GITHUB_REPOSITORY_ID: '1' },
      { RECORD_CLIENT_PROOF_ACTION: 'other' },
      { GITHUB_EVENT_NAME: 'schedule' },
    ])
      expect(() =>
        admitPrivateRecordClientProof(payload(), { ...environment(), ...patch })
      ).toThrow();
    for (const value of [
      { ...payload(), url: 'https://untrusted.invalid' },
      { ...payload(), client_sha: 'main' },
      {},
      null,
    ])
      expect(() => admitPrivateRecordClientProof(value, environment())).toThrow();
  });
  it('requires the actual owning gateway provider steps and functional artifact', () => {
    expect(assertQualifiedGateway(input(), run(), jobs(), gatewayEvidence())).toBe(true);
    for (const patch of [
      { conclusion: 'failure' },
      { head_sha: client },
      { event: 'pull_request' },
      { head_branch: 'feature' },
      { id: 456 },
    ])
      expect(() =>
        assertQualifiedGateway(input(), { ...run(), ...patch }, jobs(), gatewayEvidence())
      ).toThrow();
    const skipped = jobs();
    skipped[0].steps[1].conclusion = 'skipped';
    expect(() => assertQualifiedGateway(input(), run(), skipped, gatewayEvidence())).toThrow();
    for (const patch of [
      { cleanupVerified: false },
      { revision: client },
      { cosmeticSourceInvalidation: false },
      { paidRetirementQualified: true },
    ])
      expect(() =>
        assertQualifiedGateway(input(), run(), jobs(), { ...gatewayEvidence(), ...patch })
      ).toThrow();
  });
  it('requires both actual client origins, exact gateway and paid flag on', async () => {
    const read = (bad?: string) =>
      vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(
              url.includes('/private-record/')
                ? {
                    service: 'private-record-gateway',
                    revision: bad === 'gateway' ? client : gateway,
                    sourceReady: true,
                    processReachable: true,
                  }
                : { ca_sha: bad === 'client' ? gateway : client }
            ),
            { status: 200 }
          )
      );
    expect(
      await readPrivateRecordClientPin(input(), { fetchImpl: read(), readPaid: async () => true })
    ).toMatchObject({ clientSha: client, gatewaySha: gateway, paidSourceEnabled: true });
    for (const bad of ['gateway', 'client'])
      await expect(
        readPrivateRecordClientPin(input(), { fetchImpl: read(bad), readPaid: async () => true })
      ).rejects.toThrow();
    await expect(
      readPrivateRecordClientPin(input(), { fetchImpl: read(), readPaid: async () => false })
    ).rejects.toThrow(/remain enabled/);
    await expect(readPrivateRecordClientPin(input(), { fetchImpl: read() })).rejects.toThrow(
      /readback/
    );
  });
  it('one actual modern browser case never qualifies paid retirement', () => {
    expect(
      assertPrivateRecordClientProof(report(), input(), pin(), pin(), { verified: true })
    ).toMatchObject({
      modernClientFailoverVerified: true,
      paidRetirementQualified: false,
      scope: 'modern-published-web-client-only',
    });
    for (const patch of [
      { gatewayReadyAfterFault: false },
      { gatewayRecordChangedAfterRestore: false },
      { genuineSession: false },
      { readerReadback: false },
      { faultRestored: false },
      { syntheticFrames: 1 },
      { paidIsolation: undefined },
      {
        paidIsolation: {
          activeAtStart: 1,
          activeAtEnd: 0,
          joins: 0,
          matchingChangedFrames: 0,
          observedFrames: 0,
        },
      },
      { gatewayRetention: undefined },
      {
        gatewayRetention: {
          openSocketsBeforeSecondWrite: 1,
          openSocketsAfterSecondWrite: 1,
          matchingChangesAfterRecovery: 0,
        },
      },
      {
        gatewayRetention: {
          openSocketsBeforeSecondWrite: 0,
          openSocketsAfterSecondWrite: 0,
          matchingChangesAfterRecovery: 1,
        },
      },
      { observationsOverflow: true },
      { cosmeticWrites: 1 },
    ])
      expect(() =>
        assertPrivateRecordClientProof(
          report({ ...browserEvidence(), ...patch }),
          input(),
          pin(),
          pin(),
          { verified: true }
        )
      ).toThrow();
    expect(() =>
      assertPrivateRecordClientProof(report(), input(), pin(), pin(), { verified: false })
    ).toThrow();
    const duplicate = pin();
    duplicate.origins[1] = duplicate.origins[0];
    expect(() =>
      assertPrivateRecordClientProof(report(), input(), duplicate, pin(), { verified: true })
    ).toThrow();
    for (const state of ['skipped', 'failed', 'interrupted']) {
      const value = report();
      value.suites[0].specs[0].tests[0].results[0].status = state;
      expect(() =>
        assertPrivateRecordClientProof(value, input(), pin(), pin(), { verified: true })
      ).toThrow();
    }
    const retried = report();
    retried.suites[0].specs[0].tests[0].results[0].retry = 1;
    expect(() =>
      assertPrivateRecordClientProof(retried, input(), pin(), pin(), { verified: true })
    ).toThrow();
  });
  it('faults only this context private engine channel and restores normal connection creation', async () => {
    let match!: (url: URL) => boolean, route!: (socket: any) => void;
    const context = {
      routeWebSocket: async (m: typeof match, r: typeof route) => {
        match = m;
        route = r;
      },
    };
    const control = await installPrivateRecordEngineInterruption(context as any);
    expect(match(new URL('wss://engine.smarter.poker/ws/channel'))).toBe(true);
    for (const url of [
      'wss://engine.smarter.poker/ws/multi',
      'wss://engine.smarter.poker/ws/table/fixture',
      'wss://ca-static.smarter.poker/private-record/ws/channel',
      'https://engine.smarter.poker/ws/channel',
    ])
      expect(match(new URL(url))).toBe(false);
    await expect(control.block()).rejects.toThrow(/No live/);
    const server = { close: vi.fn(async () => {}) };
    const socket = { connectToServer: vi.fn(() => server), close: vi.fn(async () => {}) };
    route(socket);
    expect(socket.connectToServer).toHaveBeenCalledTimes(1);
    await control.block();
    expect(server.close).toHaveBeenCalledWith({
      code: 4000,
      reason: 'Reserved Client Record Channel Qualification',
    });
    route(socket);
    expect(socket.connectToServer).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    control.restore();
    route(socket);
    expect(socket.connectToServer).toHaveBeenCalledTimes(2);
  });
  it('the existing provider owns one explicit browser proof without enabling exposure', async () => {
    const workflow = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
    const { parse } = await import('yaml');
    const job = parse(workflow).jobs['private-record-client-proof'];
    expect(job.needs).toBe('certification-cleanup-safety');
    expect(job.if).toBe(
      "always() && !cancelled() && needs.certification-cleanup-safety.result == 'success' && github.event_name == 'repository_dispatch' && github.event.action == 'run-private-record-client-proof'"
    );
    expect(workflow).toContain('private-record-client-proof:');
    expect(workflow).toContain(
      'npx playwright test tests/e2e/production-private-record-failover.spec.ts'
    );
    expect(workflow).toContain('node scripts/ci/private-record-client-proof.mjs verify');
    const source = readFileSync('tests/e2e/production-private-record-failover.spec.ts', 'utf8');
    expect(source).not.toMatch(/route\.fulfill|\.send\(|setContent\(/);
    expect(source).toContain('ca_club_member_detail');
    expect(source).toContain('arena_avatar_url');
    expect(source).toContain('finally');
  });
});

it('selects the verified independent fallback in both actual client build inputs', async () => {
  const { parse } = await import('yaml');
  for (const file of [
    '.github/workflows/publish-club-arena-client.yml',
    '.github/workflows/publish-club-arena-transaction.yml',
  ]) {
    const workflow = parse(readFileSync(file, 'utf8'));
    const builds = Object.values(workflow.jobs).flatMap((job: any) =>
      (job.steps ?? []).filter((step: any) =>
        Object.hasOwn(step.env ?? {}, 'VITE_PRIVATE_RECORD_FALLBACK_URL')
      )
    );
    expect(builds, file).toHaveLength(1);
    expect(builds[0].env.VITE_PRIVATE_RECORD_FALLBACK_URL, file).toBe(
      'https://ca-static.smarter.poker/private-record'
    );
  }
});
