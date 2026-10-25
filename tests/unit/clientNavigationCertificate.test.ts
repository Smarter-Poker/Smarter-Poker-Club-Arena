import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  admitClientNavigation,
  assertClientNavigationReports,
} from '../../scripts/ci/client-navigation-certificate.mjs';

const workflow = parse(
  readFileSync(resolve(__dirname, '../../.github/workflows/post-deploy-e2e.yml'), 'utf8')
);
const client = workflow.jobs['production-e2e'];
const selected = client.steps.find(
  (step: any) => step.name === 'Verify only the two client navigation repairs'
);
const tableTitle = 'no surface scrolls sideways on a phone';
const lobbyTitle = 'compact rows open details and filters stay at their original position';
const spec = (file: string, title: string, projectName: string) => ({
  file,
  title,
  ok: true,
  tests: [
    {
      projectName,
      status: 'expected',
      expectedStatus: 'passed',
      results: [{ status: 'passed', retry: 0 }],
    },
  ],
});
const reports = () => [
  {
    errors: [],
    suites: [{ specs: [spec('production-table-management.spec.ts', tableTitle, 'chromium')] }],
  },
  {
    errors: [],
    suites: [
      {
        specs: [
          spec('production-mobile-lobby-chrome.spec.ts', lobbyTitle, 'chromium'),
          spec('production-mobile-lobby-chrome.spec.ts', lobbyTitle, 'webkit-footer'),
        ],
      },
    ],
  },
];

describe('closed client navigation recovery certificate', () => {
  it('admits only the literal closed mode, with no engine, arbitrary selection or mobile observation', () => {
    expect(admitClientNavigation({ client_navigation: true })).toBe(true);
    for (const payload of [
      null,
      {},
      { client_navigation: 'true' },
      { client_navigation: false },
      { client_navigation: 1 },
      { client_navigation: true, engine_sha: null },
      { client_navigation: true, engine_sha: 'a'.repeat(40) },
      { client_navigation: true, mobile_multirun: true },
      { client_navigation: true, spec: 'x' },
      { client_navigation: true, code: 'x' },
    ])
      expect(() => admitClientNavigation(payload)).toThrow();
  });
  it('executes the actual dispatch gate without letting invalid mode borrow engine admission', () => {
    const gate = workflow.jobs['publication-gate'].steps.find((step: any) => step.id === 'origin');
    const cwd = resolve(__dirname, '../..');
    const dir = mkdtempSync(join(tmpdir(), 'client-navigation-admission-'));
    try {
      for (const value of [true, 'true', false, null, 1]) {
        const payload =
          value === true
            ? { client_navigation: true }
            : { client_navigation: value, engine_sha: 'a'.repeat(40) };
        const result = spawnSync('bash', ['-c', gate.run], {
          cwd,
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            EVENT_NAME: 'repository_dispatch',
            GITHUB_OUTPUT: join(dir, 'output'),
            CLIENT_NAVIGATION_JSON: JSON.stringify(value),
            CLIENT_NAVIGATION_PAYLOAD: JSON.stringify(payload),
            ENGINE_TRIGGER_JSON: JSON.stringify(payload.engine_sha ?? null),
            ENGINE_TRIGGER_SHA: payload.engine_sha ?? '',
          },
        });
        expect(result.status, result.stderr).toBe(value === true ? 0 : 1);
      }
      expect(readFileSync(join(dir, 'output'), 'utf8')).toContain('client_navigation=true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('requires exactly the three browser cases, each passed once', () => {
    const [table, lobby] = reports();
    expect(assertClientNavigationReports(table, lobby)).toBe(true);
    const changes = [
      (a: any) => {
        a.suites = [];
      },
      (a: any) => {
        a.errors = [{ message: 'setup failed' }];
      },
      (a: any) => {
        a.suites[0].specs[0].tests[0].results[0].status = 'skipped';
      },
      (a: any) => {
        a.suites[0].specs[0].tests[0].results[0].retry = 1;
      },
      (a: any) => {
        a.suites[0].specs[0].tests[0].results.push({ status: 'passed', retry: 1 });
      },
      (a: any) => {
        a.suites[0].specs[0].tests[0].projectName = 'webkit-footer';
      },
      (a: any) => {
        a.suites[0].specs.push(a.suites[0].specs[0]);
      },
    ];
    for (const change of changes) {
      const [a, b] = reports();
      change(a);
      expect(() => assertClientNavigationReports(a, b)).toThrow();
    }
    expect(() => assertClientNavigationReports(undefined, lobby)).toThrow();
  });
  it('reuses the client fixture, provenance, serialization and unconditional cleanup', () => {
    expect(client.concurrency.group).toBe('post-deploy-e2e-production');
    expect(selected.if).toContain("steps.template_access.outcome == 'success'");
    expect(selected.env.E2E_REQUIRE_AUTH).toBe('1');
    for (const command of ['create', 'prepare-staff', 'prepare-template-staff', 'cleanup']) {
      const step = client.steps.find(
        (s: any) => s.run === `node scripts/ci/production-e2e-account.mjs ${command}`
      );
      expect(step).toBeDefined();
      expect(step.if).not.toContain("client_navigation != 'true'");
    }
    expect(client.steps.find((s: any) => s.id === 'account_cleanup').if).toContain('always()');
    expect(client.steps.find((s: any) => s.id === 'align')).toBeDefined();
    const final = client.steps.find(
      (s: any) => s.name === 'Require exact client navigation release and fixture cleanup'
    );
    expect(final.if).toContain('always()');
    expect(final.env.RELEASE_CERTIFIED).toBe('${{ steps.release_window.outputs.certified }}');
  });
  it('selects only the unchanged phone and compact-row cases and excludes unrelated lanes', () => {
    expect(selected.run.match(/npx playwright test/g)).toHaveLength(2);
    expect(selected.run).toContain(`--grep '^.*${tableTitle}$'`);
    expect(selected.run).toContain(`--grep '^.*${lobbyTitle}$'`);
    expect(selected.run).toContain('--project=chromium --project=webkit-footer');
    expect(selected.run.match(/--retries=0/g)).toHaveLength(2);
    expect(selected.run).toContain('node "$RUNNER_TEMP/client-navigation-certificate.mjs" reports');
    for (const name of [
      'Run the specs that need a deployed page',
      'Certify the authenticated production Cashier',
      'Certify the authenticated Lightning operator cold loads',
      'Provision an isolated first-run account',
      'Did every Phase 1 customization journey pass exactly?',
    ]) {
      expect(client.steps.find((s: any) => s.name === name).if).toContain(
        "client_navigation != 'true'"
      );
    }
    for (const name of ['live-table-e2e', 'club-channel-lifecycle-e2e', 'post-deploy-verdict']) {
      expect(workflow.jobs[name].if).toContain("client_navigation != 'true'");
    }
    expect(workflow.jobs['seo-contract'].if).toContain("github.event_name == 'workflow_run'");
  });
  it('preserves the trusted validator before aligning to a retained older runtime', () => {
    const stage = client.steps.find((s: any) => s.id === 'navigation_validator');
    expect(stage.if).toBe("needs.publication-gate.outputs.client_navigation == 'true'");
    expect(stage.run).toBe(
      'cp scripts/ci/client-navigation-certificate.mjs "$RUNNER_TEMP/client-navigation-certificate.mjs"'
    );
    expect(client.steps.indexOf(stage)).toBeLessThan(
      client.steps.findIndex((s: any) => s.id === 'align')
    );
    expect(selected.run).not.toContain('node scripts/ci/client-navigation-certificate.mjs');
  });
});
