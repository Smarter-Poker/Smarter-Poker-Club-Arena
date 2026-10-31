import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';

const workflow = YAML.parse(readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8'));
const fixtureJobs = [
  'private-record-client-proof',
  'stats-pagination-proof',
  'production-e2e',
  'live-table-e2e',
  'club-channel-lifecycle-e2e',
];
describe('production fixtures require installed scoped cleanup', () => {
  it.each(fixtureJobs)(
    '%s cannot enter any step, including always cleanup, before the dependency passes',
    (name) => {
      const job = workflow.jobs[name];
      expect([job.needs].flat()).toContain('certification-cleanup-safety');
      const condition = job.if || '';
      if (/\b(?:always|cancelled|failure|success)\s*\(/.test(condition)) {
        // An explicit status function removes Actions' implicit success().
        // Such a lane must itself refuse unsafe cleanup and cancellation,
        // including when another ancestor intentionally did not run.
        expect(condition).toContain("needs.certification-cleanup-safety.result == 'success'");
        expect(condition).toContain('!cancelled()');
        const admits = (cleanup: string, cancelled: boolean) => {
          const expression = condition
            .replaceAll('always()', 'true')
            .replaceAll('cancelled()', JSON.stringify(cancelled))
            .replaceAll('needs.certification-cleanup-safety.result', JSON.stringify(cleanup))
            .replaceAll('github.event_name', JSON.stringify('repository_dispatch'))
            .replaceAll('github.event.action', JSON.stringify('run-stats-pagination-proof'));
          return Function(`"use strict"; return (${expression});`)();
        };
        for (const cleanup of ['failure', 'skipped', 'cancelled', 'unknown'])
          expect(admits(cleanup, false), `${name}: ${cleanup} cleanup`).toBe(false);
        expect(admits('success', true), `${name}: cancelled run`).toBe(false);
      } else {
        // Unchanged lanes retain the dependency's default status protection.
        expect(condition).not.toMatch(/always\(|!cancelled\(|failure\(/);
      }
    }
  );
  it('keeps dependency failure visible in the terminal verdict', () => {
    expect(workflow.jobs['post-deploy-verdict'].needs).toContain('certification-cleanup-safety');
    const step = workflow.jobs['post-deploy-verdict'].steps.find(
      (s: any) => s.name === 'Record the production-verification verdict'
    );
    expect(step.env.LANES).toContain('needs.certification-cleanup-safety.result');
  });
});

import {
  awaitCleanupSafety,
  classifyProof,
  connectionConfig,
  EXPECTED,
  HELPER_HASH,
  NAME,
  POLL_MS,
  PROOF_SQL,
  readProof,
  VERSION,
  WAIT_MS,
} from '../../scripts/ci/await-certification-cleanup-safety.mjs';
const installed = () => ({
  history: [{ version: VERSION, name: NAME }],
  definitions: { ...EXPECTED },
  helper_owner_only: true,
  helper_hash: HELPER_HASH,
});

describe('catalog proof admits no unsafe fixture', () => {
  it('pins the deployed contract independently to the migration live-proof declaration', () => {
    const migration = readFileSync(`supabase/migrations/${VERSION}_${NAME}.sql`, 'utf8');
    const declaration = migration.split('\n').find((line) => line.startsWith('-- @live-proof:'))!;
    for (const [signature, hash] of Object.entries(EXPECTED)) {
      expect(declaration).toContain(
        `md5(pg_get_functiondef('${signature}'::regprocedure))='${hash}'`
      );
    }
    expect(Object.keys(EXPECTED)).toHaveLength(5);
    expect(classifyProof(installed())).toBe('ready');
  });
  it.each([null, {}, { history: null }, { history: 'missing' }])(
    'refuses unreadable history %j',
    (row) => {
      expect(() => classifyProof(row)).toThrow(/unreadable/);
    }
  );
  it.each(
    [
      [{ version: '20261029193108', name: NAME }],
      [{ version: VERSION, name: 'wrong' }],
      [
        { version: VERSION, name: NAME },
        { version: VERSION, name: NAME },
      ],
    ].map((history) => ({ history }))
  )('refuses wrong or duplicate migration identity %j', ({ history }) => {
    expect(() => classifyProof({ ...installed(), history })).toThrow(/identity differs/);
  });
  it.each(Object.keys(EXPECTED))('refuses missing or drifted function %s', (signature) => {
    for (const value of [null, 'wrong']) {
      const row = installed();
      row.definitions[signature] = value;
      expect(() => classifyProof(row)).toThrow(/identity differs/);
    }
  });
  it.each([false, null, undefined, 'true'])(
    'refuses unsafe or unreadable helper ACL %j',
    (helper_owner_only) => {
      expect(() => classifyProof({ ...installed(), helper_owner_only })).toThrow(
        /non-owner access/
      );
    }
  );
  it('waits only for absent history then accepts one complete atomic catalog answer', async () => {
    let clock = 0,
      reads = 0;
    expect(
      await awaitCleanupSafety({
        read: async () => (++reads === 1 ? { history: [] } : installed()),
        now: () => clock,
        pause: async (ms) => {
          expect(ms).toBe(POLL_MS);
          clock += ms;
        },
        report: () => {},
      })
    ).toBe(true);
    expect(reads).toBe(2);
  });
  it('terminates at the fixed deadline without admitting a fixture', async () => {
    let clock = 0,
      reads = 0;
    await expect(
      awaitCleanupSafety({
        read: async () => {
          reads++;
          return { history: [] };
        },
        now: () => clock,
        pause: async (ms) => {
          clock += ms;
        },
        report: () => {},
      })
    ).rejects.toThrow(/12-minute/);
    expect(clock).toBe(WAIT_MS);
    expect(reads).toBe(WAIT_MS / POLL_MS);
  });
  it('does not accept a correct answer returned after the deadline', async () => {
    let clock = 0;
    await expect(
      awaitCleanupSafety({
        read: async () => {
          clock = WAIT_MS;
          return installed();
        },
        now: () => clock,
        pause: async () => {
          throw Error('must not pause');
        },
      })
    ).rejects.toThrow(/12-minute/);
  });
  it('fails immediately on a query error or installed drift, without retrying', async () => {
    for (const read of [
      async () => {
        throw Error('catalog denied');
      },
      async () => ({ ...installed(), helper_owner_only: false }),
    ]) {
      await expect(
        awaitCleanupSafety({
          read,
          pause: async () => {
            throw Error('must not retry');
          },
        })
      ).rejects.toThrow(/denied|non-owner/);
    }
  });
  it('uses verified TLS and a read-only session even when connection options request otherwise', () => {
    const config = connectionConfig(
      'postgresql://postgres:fixture@db.kuklfnapbkmacvwxktbh.supabase.co/postgres?sslmode=disable&options=unsafe'
    );
    expect(config.ssl.rejectUnauthorized).toBe(true);
    expect(config.ssl.ca.some((ca: string) => ca.includes('BEGIN CERTIFICATE'))).toBe(true);
    expect(config.connectionString).not.toMatch(/sslmode|unsafe/);
    expect(config.options).toBe('-c default_transaction_read_only=on');
    expect(config.statement_timeout).toBe(5000);
    expect(() =>
      connectionConfig('postgresql://fixture:fixture@untrusted.invalid/postgres')
    ).toThrow(/Canonical/);
  });
  it('reads all evidence in one read-only transaction and rolls back even on failure', async () => {
    for (const fail of [false, true]) {
      const calls: unknown[][] = [];
      const client = {
        query: async (...args: unknown[]) => {
          calls.push(args);
          if (args[0] === PROOF_SQL) {
            if (fail) throw Error('catalog denied');
            return { rows: [installed()] };
          }
          return {};
        },
      };
      if (fail) await expect(readProof(client)).rejects.toThrow('catalog denied');
      else expect(await readProof(client)).toEqual(installed());
      expect(calls.map((c) => c[0])).toEqual([
        'BEGIN TRANSACTION READ ONLY',
        PROOF_SQL,
        'ROLLBACK',
      ]);
      expect(calls[1][1]).toEqual([VERSION, NAME, Object.keys(EXPECTED)]);
    }
    expect(PROOF_SQL).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CALL|CREATE|ALTER|DROP)\b/i);
    expect(PROOF_SQL).toContain('aclexplode');
    expect(PROOF_SQL).toContain('a.grantee<>p.proowner');
  });
  it('keeps special proof lanes and publication admission while blocking always-cleanup jobs', () => {
    const gate = workflow.jobs['certification-cleanup-safety'];
    expect(gate.needs).toBe('publication-gate');
    expect(gate.if).toContain("needs.publication-gate.outputs.should_run == 'true'");
    for (const action of ['run-stats-pagination-proof', 'run-private-record-client-proof'])
      expect(gate.if).toContain(action);
    expect(gate.steps.at(-1).env.DATABASE_URL).toBe('${{ secrets.DATABASE_URL }}');
    expect(gate.steps.at(-1).run).toBe('node scripts/ci/await-certification-cleanup-safety.mjs');
    expect(gate.steps.every((step: any) => !step['continue-on-error'])).toBe(true);
    expect(workflow.jobs['stood-down-is-not-green'].if).toContain(
      "needs.publication-gate.outputs.should_run != 'true'"
    );
  });
});

import {
  closeReadOnlyClient,
  safeFailure,
} from '../../scripts/ci/await-certification-cleanup-safety.mjs';
it('does not disclose transport errors, URLs, credentials or arbitrary database messages', () => {
  expect(safeFailure(Error('postgresql://user:password@example.invalid/postgres'))).not.toMatch(
    /password|postgresql|example/
  );
  expect(safeFailure(Error('Cleanup function identity differs: secret-password'))).not.toContain(
    'secret-password'
  );
  expect(safeFailure(Error('Cleanup migration history identity differs'))).toBe(
    'Cleanup migration history identity differs'
  );
});
it('bounds a stalled close and destroys only its own read-only socket', async () => {
  let destroyed = false;
  const client = {
    end: () => new Promise(() => {}),
    connection: {
      stream: {
        destroy: () => {
          destroyed = true;
        },
      },
    },
  };
  await expect(
    closeReadOnlyClient(client, {
      pause: async (ms: number) => {
        expect(ms).toBe(2000);
      },
    })
  ).rejects.toThrow(/did not close/);
  expect(destroyed).toBe(true);
});
it('rolls back a PostgreSQL statement timeout before any next catalog read', async () => {
  const calls: string[] = [];
  const client = {
    query: async (sql: string) => {
      calls.push(sql);
      if (sql === PROOF_SQL) throw Object.assign(Error('statement timeout'), { code: '57014' });
    },
  };
  await expect(readProof(client)).rejects.toThrow(/statement timeout/);
  expect(calls).toEqual(['BEGIN TRANSACTION READ ONLY', PROOF_SQL, 'ROLLBACK']);
});

it.each([null, undefined, 'wrong'])(
  'refuses admission helper body drift even with owner-only ACL %j',
  (helper_hash) => {
    expect(() => classifyProof({ ...installed(), helper_hash })).toThrow(/helper identity differs/);
  }
);
