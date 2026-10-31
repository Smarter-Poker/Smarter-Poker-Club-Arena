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
  PRIVATE_RECORD_ROSTER_READ_MS,
  PRIVATE_RECORD_CASE_MS,
  PRIVATE_RECORD_OBSERVATION_LIMIT,
  snapshotPrivateRecordFixtureProfile,
  readPrivateRecordFixturePlayerNumber,
  assertPrivateRecordFixtureRoster,
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
  authoritativeFixtureIdentity: true,
  rosterIdentityVerified: true,
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
  cosmeticWrites: 5,
  rosterGatewayVerified: true,
  rosterPaidVerified: true,
  memberPaidVerified: true,
  bothPreferredPathsInterrupted: true,
  allFaultsRestored: true,
  preferredReadyAfterPaid: true,
  cosmeticRestoreVerified: true,
  paidFallback: {
    member: { confirmedJoins: 1, receivedChanges: 1 },
    roster: { confirmedJoins: 1, receivedChanges: 1 },
  },
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
  it('fits both real roster refresh intervals and cleanup within the existing provider budget', () => {
    const roster = readFileSync('src/pages/ClubMembersPage.tsx', 'utf8');
    const interval = roster.match(/liveRosterRefreshPolicy = \{ minIntervalMs: ([\d_]+) \}/);
    expect(interval).not.toBeNull();
    const floor = Number(interval![1].replaceAll('_', ''));
    expect(PRIVATE_RECORD_ROSTER_READ_MS).toBeGreaterThanOrEqual(floor + 45_000);
    expect(PRIVATE_RECORD_CASE_MS).toBeGreaterThanOrEqual(
      2 * PRIVATE_RECORD_ROSTER_READ_MS + 150_000
    );
    expect(PRIVATE_RECORD_CASE_MS).toBeLessThanOrEqual(600_000);
    expect(PRIVATE_RECORD_OBSERVATION_LIMIT).toBeGreaterThan(
      (127 * PRIVATE_RECORD_CASE_MS) / 60_000
    );
    expect(PRIVATE_RECORD_OBSERVATION_LIMIT).toBeLessThanOrEqual(2048);
  });
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
      { authoritativeFixtureIdentity: false },
      { rosterIdentityVerified: false },
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
      { rosterGatewayVerified: false },
      { rosterPaidVerified: false },
      { memberPaidVerified: false },
      { bothPreferredPathsInterrupted: false },
      { allFaultsRestored: false },
      { preferredReadyAfterPaid: false },
      { cosmeticRestoreVerified: false },
      { paidFallback: undefined },
      {
        paidFallback: {
          member: { confirmedJoins: 1, receivedChanges: 0 },
          roster: { confirmedJoins: 1, receivedChanges: 1 },
        },
      },
      {
        paidFallback: {
          member: { confirmedJoins: 1, receivedChanges: 1 },
          roster: { confirmedJoins: 0, receivedChanges: 1 },
        },
      },
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
  it.each(['engine', 'gateway'] as const)(
    'faults only this context exact %s endpoint and restores normal connection creation',
    async (endpoint) => {
      let match!: (url: URL) => boolean, route!: (socket: any) => void;
      const context = {
        routeWebSocket: async (m: typeof match, r: typeof route) => {
          match = m;
          route = r;
        },
      };
      const control = await installPrivateRecordEngineInterruption(context as any, endpoint);
      const exact =
        endpoint === 'engine'
          ? 'wss://engine.smarter.poker/ws/channel'
          : 'wss://ca-static.smarter.poker/private-record/ws/channel';
      expect(match(new URL(exact))).toBe(true);
      for (const url of [
        'wss://engine.smarter.poker/ws/multi',
        'wss://engine.smarter.poker/ws/table/fixture',
        endpoint === 'engine'
          ? 'wss://ca-static.smarter.poker/private-record/ws/channel'
          : 'wss://engine.smarter.poker/ws/channel',
        'wss://untrusted.invalid/ws/channel',
        'wss://engine.smarter.poker:9443/ws/channel',
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
    }
  );
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
    const roster = readFileSync('src/pages/ClubMembersPage.tsx', 'utf8');
    expect(roster).toMatch(/<input\s+type="search"[\s\S]*?aria-label="Search Club Members"/);
    expect(source).toContain("getByRole('searchbox', { name: 'Search Club Members' })");
    expect(source).not.toContain("getByRole('textbox', { name: 'Search Club Members' })");
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

it('uses authorized player identity with a nullable alias and exact cosmetic snapshot', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const profile = { id, alias: null, avatar_url: null, arena_avatar_url: '/avatars/fixture.webp' };
  expect(snapshotPrivateRecordFixtureProfile([profile], id)).toEqual({
    id,
    avatar_url: null,
    arena_avatar_url: '/avatars/fixture.webp',
  });
  expect(
    readPrivateRecordFixturePlayerNumber({ identity: { user_id: id, player_number: '001042' } }, id)
  ).toBe('001042');
  for (const rows of [
    [],
    [profile, profile],
    [{ ...profile, id: 'foreign' }],
    [{ id }],
    [{ ...profile, avatar_url: 1 }],
  ])
    expect(() => snapshotPrivateRecordFixtureProfile(rows, id)).toThrow();
  for (const identity of [
    null,
    { user_id: 'foreign', player_number: '001042' },
    { user_id: id },
    { user_id: id, player_number: '' },
    { user_id: id, player_number: 1042 },
    { user_id: id, player_number: '1'.repeat(21) },
    { user_id: id, player_number: 'Alias Name' },
  ])
    expect(() => readPrivateRecordFixturePlayerNumber({ identity }, id)).toThrow();
});
it('requires one actual roster row for both the authoritative number and exact actor', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const row = { user_id: id, player_number: '001042', alias: null };
  expect(assertPrivateRecordFixtureRoster({ items: [row] }, id, '001042')).toBe(row);
  for (const items of [
    [],
    [row, row],
    [{ ...row, user_id: 'foreign' }],
    [{ ...row, player_number: '1042' }],
    [row, { ...row, user_id: 'foreign' }],
    [row, { ...row, player_number: '1043' }],
  ])
    expect(() => assertPrivateRecordFixtureRoster({ items }, id, '001042')).toThrow();
  expect(() => assertPrivateRecordFixtureRoster({}, id, '001042')).toThrow();
});
