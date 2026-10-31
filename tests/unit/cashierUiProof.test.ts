import { describe, expect, it } from 'vitest';
import {
  admitDispatch,
  assertCases,
  assertPins,
  CASES,
  COMPONENT_PATHS,
} from '../../scripts/verification-harness/cashier-ui-proof.mjs';
const sha = 'a'.repeat(40);
const env = {
  GITHUB_EVENT_NAME: 'repository_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_REPOSITORY_ID: '1132369872',
  GITHUB_SHA: sha,
  PROOF_RUN_ID: '123',
  GITHUB_REPOSITORY: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
};
const event = { action: 'verify-cashier-ui', client_payload: {} };
const report = () => ({
  suites: [
    {
      file: 'production-cashier.spec.ts',
      specs: CASES.map((title) => ({
        title,
        ok: true,
        tests: [
          {
            projectName: 'chromium',
            status: 'expected',
            expectedStatus: 'passed',
            results: [{ status: 'passed', retry: 0 }],
          },
        ],
      })),
    },
  ],
});
const pin = () => ({
  schema: 1,
  clientSha: sha,
  verificationSha: sha,
  runId: '123',
  publisherRunId: '456',
  publisherVerified: true,
  endpoints: ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'].map(
    (origin) => ({ origin, clientSha: sha, publisherRunId: '456' })
  ),
  components: Object.fromEntries(COMPONENT_PATHS.map((p) => [p, sha])),
});
describe('closed scoped cashier proof', () => {
  it('admits only the fixed protected dispatch', () => {
    expect(() => admitDispatch(env, event)).not.toThrow();
    for (const changed of [
      { GITHUB_EVENT_NAME: 'workflow_dispatch' },
      { GITHUB_REF: 'refs/heads/other' },
      { GITHUB_REPOSITORY_ID: '1' },
      { GITHUB_SHA: 'bad' },
      { PROOF_RUN_ID: '' },
    ])
      expect(() => admitDispatch({ ...env, ...changed }, event)).toThrow();
    for (const payload of [null, [], { grep: 'anything' }])
      expect(() => admitDispatch(env, { ...event, client_payload: payload })).toThrow();
  });
  it('requires exactly both cases once with no skips or retries', () => {
    expect(assertCases(report())).toHaveLength(2);
    for (const change of [
      (r) => r.suites[0].specs.pop(),
      (r) => r.suites[0].specs.push(r.suites[0].specs[0]),
      (r) => (r.errors = ['failure']),
      (r) => (r.suites[0].specs[0].tests[0].results[0].retry = 1),
      (r) => (r.suites[0].specs[0].tests[0].results[0].status = 'skipped'),
      (r) => (r.suites[0].specs[0].tests[0].projectName = 'firefox'),
    ]) {
      const value = report();
      change(value);
      expect(() => assertCases(value)).toThrow();
    }
  });
  it('requires stable two-origin publisher provenance and verified own cleanup', () => {
    expect(() => assertPins(pin(), pin(), { verified: true, runId: '123' })).not.toThrow();
    for (const change of [
      (p) => (p.clientSha = 'b'.repeat(40)),
      (p) => (p.publisherVerified = false),
      (p) => p.endpoints.pop(),
      (p) => (p.components = {}),
      (p) => (p.runId = '999'),
    ]) {
      const after = pin();
      change(after);
      expect(() => assertPins(pin(), after, { verified: true, runId: '123' })).toThrow();
    }
    expect(() => assertPins(pin(), pin(), { verified: true, runId: '999' })).toThrow();
    expect(() => assertPins(pin(), pin(), { verified: false, runId: '123' })).toThrow();
  });
});
