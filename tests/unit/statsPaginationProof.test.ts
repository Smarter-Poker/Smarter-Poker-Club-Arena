import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  admitStatsPaginationProof,
  assertStatsPaginationProof,
  readStatsClientPin,
  STATS_PAGINATION_TITLE,
} from '../../scripts/ci/stats-pagination-proof.mjs';

const sha = 'a'.repeat(40);
const urls = [
  'https://smarter.poker/hub/club-arena/build-info.json',
  'https://ca-static.smarter.poker/build-info.json',
];
const pin = () => ({ sha, builds: urls.map((url) => ({ url, sha, build: { ca_sha: sha } })) });
const admission = () => ({
  GITHUB_EVENT_NAME: 'repository_dispatch',
  STATS_PROOF_ACTION: 'run-stats-pagination-proof',
  GITHUB_REPOSITORY: 'Smarter-Software-PIQ/Smarter-Poker-Club-Arena',
  GITHUB_REPOSITORY_ID: '1132369872',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_SHA: sha,
});
const evidence = () => ({
  clientSha: sha,
  syntheticReadResponses: true,
  actualPublishedAssets: true,
  blockedWrites: 0,
  reads: [
    { limit: 501, search: null },
    { limit: 1001, search: null },
    { limit: 501, search: 'river' },
  ],
  bracket: [
    { point: 'before', sha, reason: null },
    { point: 'after', sha, reason: null },
  ],
});
const attachment = (body = evidence()) => ({
  name: 'published-downline-pagination',
  contentType: 'application/json',
  body: Buffer.from(JSON.stringify(body)).toString('base64'),
});
const report = () => ({
  errors: [],
  suites: [
    {
      specs: [
        {
          file: 'stats-deep.spec.ts',
          title: STATS_PAGINATION_TITLE,
          ok: true,
          tests: [
            {
              projectName: 'chromium',
              status: 'expected',
              expectedStatus: 'passed',
              results: [{ status: 'passed', retry: 0, errors: [], attachments: [attachment()] }],
            },
          ],
        },
      ],
    },
  ],
});
const verify = (value = report(), before = pin(), after = pin(), cleanup = { verified: true }) =>
  assertStatsPaginationProof(value, before, after, cleanup);

describe('closed exact published Stats pagination proof', () => {
  it('admits only the fixed event from the exact protected-main identity with no dispatch inputs', () => {
    expect(admitStatsPaginationProof({}, admission())).toBe(true);
    for (const payload of [
      null,
      [],
      false,
      'x',
      { sha },
      { spec: 'arbitrary' },
      { engine_sha: sha },
    ])
      expect(() => admitStatsPaginationProof(payload, admission())).toThrow();
    for (const key of Object.keys(admission())) {
      expect(() => admitStatsPaginationProof({}, { ...admission(), [key]: 'other' })).toThrow();
    }
  });
  it('reads both maintained origins once with bounded uncached requests', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      text: async () => JSON.stringify({ ca_sha: sha }),
    }));
    const actual = await readStatsClientPin(fetchImpl);
    expect(actual.sha).toBe(sha);
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(urls);
    for (const call of fetchImpl.mock.calls) {
      expect(call[1].headers).toEqual({ 'Cache-Control': 'no-cache' });
      expect(call[1].signal).toBeInstanceOf(AbortSignal);
    }
  });
  it('refuses disagreement, an unreadable origin and malformed identity', async () => {
    for (const variant of ['different', 'http', 'malformed']) {
      let call = 0;
      await expect(
        readStatsClientPin(async () => {
          const second = call++ === 1;
          return {
            ok: !(second && variant === 'http'),
            status: 503,
            text: async () =>
              JSON.stringify({
                ca_sha: second
                  ? variant === 'different'
                    ? 'b'.repeat(40)
                    : variant === 'malformed'
                      ? 'bad'
                      : sha
                  : sha,
              }),
          };
        })
      ).rejects.toThrow();
    }
  });
  it('certifies exactly one first-attempt pass with its real browser evidence and cleanup', () => {
    expect(verify()).toEqual({
      clientSha: sha,
      executed: 1,
      passed: 1,
      skipped: 0,
      failed: 0,
      retries: 0,
      cleanupVerified: true,
    });
  });
  it('rejects skipped, failed, retried, duplicated, missing and differently selected cases', () => {
    const mutations = [
      (r: any) => {
        r.errors.push({ message: 'setup failed' });
      },
      (r: any) => {
        r.suites = [];
      },
      (r: any) => {
        r.suites[0].specs.push(r.suites[0].specs[0]);
      },
      (r: any) => {
        r.suites[0].specs[0].title = 'different';
      },
      (r: any) => {
        r.suites[0].specs[0].file = 'other.spec.ts';
      },
      (r: any) => {
        r.suites[0].specs[0].ok = false;
      },
      (r: any) => {
        r.suites[0].specs[0].tests[0].projectName = 'webkit-footer';
      },
      (r: any) => {
        r.suites[0].specs[0].tests[0].status = 'skipped';
      },
      (r: any) => {
        r.suites[0].specs[0].tests[0].results[0].status = 'failed';
      },
      (r: any) => {
        r.suites[0].specs[0].tests[0].results[0].retry = 1;
      },
      (r: any) => {
        r.suites[0].specs[0].tests[0].results.push(r.suites[0].specs[0].tests[0].results[0]);
      },
      (r: any) => {
        r.suites[0].specs[0].tests[0].results[0].attachments = [];
      },
    ];
    for (const change of mutations) {
      const r = report();
      change(r);
      expect(() => verify(r)).toThrow();
    }
  });
  it('refuses a missing interaction assertion, blocked write or release-bracket mismatch', () => {
    for (const change of [
      (e: any) => {
        e.clientSha = 'b'.repeat(40);
      },
      (e: any) => {
        e.blockedWrites = 1;
      },
      (e: any) => {
        e.actualPublishedAssets = false;
      },
      (e: any) => {
        e.syntheticReadResponses = false;
      },
      (e: any) => {
        e.reads.pop();
      },
      (e: any) => {
        e.bracket.pop();
      },
      (e: any) => {
        e.bracket[1].sha = 'b'.repeat(40);
      },
      (e: any) => {
        e.bracket[0].reason = 'build_info_unreadable';
      },
    ]) {
      const body = evidence();
      change(body);
      const r = report();
      r.suites[0].specs[0].tests[0].results[0].attachments = [attachment(body)];
      expect(() => verify(r)).toThrow();
    }
    const changed = pin();
    changed.builds[1].build.ca_sha = 'b'.repeat(40);
    expect(() => verify(report(), pin(), changed)).toThrow();
    expect(() => verify(report(), pin(), pin(), { verified: false })).toThrow();
  });
  it('wires one bounded zero-retry case with isolated setup and actual always-cleanup', () => {
    const workflow = parse(
      readFileSync(resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml'), 'utf8')
    );
    const job = workflow.jobs['stats-pagination-proof'];
    expect(workflow.on.repository_dispatch.types).toContain('run-stats-pagination-proof');
    expect(job.if).toBe(
      "github.event_name == 'repository_dispatch' && github.event.action == 'run-stats-pagination-proof'"
    );
    expect(workflow.jobs['publication-gate'].if).toBe(
      "github.event_name != 'repository_dispatch' || github.event.action != 'run-stats-pagination-proof'"
    );
    expect(workflow.jobs['production-e2e'].concurrency).toEqual({
      group: 'post-deploy-e2e-production',
      'cancel-in-progress': false,
    });
    expect(job.concurrency).toEqual({
      group: 'stats-pagination-proof-production',
      'cancel-in-progress': false,
    });
    expect(job.permissions).toEqual({ contents: 'read' });
    expect(job['timeout-minutes']).toBe(15);
    const proof = job.steps.find((s: any) => s.id === 'proof');
    expect(proof.run).toContain('tests/e2e/stats-deep.spec.ts');
    expect(proof.run).toContain(`--grep '^.*${STATS_PAGINATION_TITLE}$'`);
    expect(proof.run).toContain('--project=chromium --workers=1 --retries=0');
    expect(proof.env.E2E_STATS_PAGINATION_PROOF).toBe('1');
    const before = job.steps.findIndex((s: any) => s.id === 'pin');
    expect(job.steps[before + 1]).toBe(proof);
    expect(job.steps[before + 2].id).toBe('after_pin');
    const cleanup = job.steps.find((s: any) => s.id === 'cleanup');
    expect(cleanup.if).toContain('always()');
    expect(cleanup.run).toContain('await cleanupProductionE2EAccount() !== true');
    expect(job.steps.find((s: any) => s.name?.startsWith('Require one first-attempt')).if).toBe(
      'always()'
    );
    expect(
      job.steps.some((s: any) =>
        /prepare-staff|prepare-template|prepare-lightning|engine.smarter.poker/.test(s.run ?? '')
      )
    ).toBe(false);
    expect(readFileSync(resolve(__dirname, '../e2e/global-setup.ts'), 'utf8')).toContain(
      "process.env.E2E_STATS_PAGINATION_PROOF === '1'"
    );
  });
});
