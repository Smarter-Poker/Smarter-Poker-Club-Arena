import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  assertInstalled,
  requirements,
  verifyInstalled,
} from '../../scripts/ci/check-mtt-payout-publication.mjs';

const expected = requirements(process.cwd());
const installed = () => expected.map((migration) => ({ ...migration, statement_count: 1 }));

describe('the 15% creation UI follows its installed database authority', () => {
  it('admits exactly installed source bytes', () => {
    expect(expected).toHaveLength(2);
    expect(() => assertInstalled(expected, installed())).not.toThrow();
  });
  for (const index of [0, 1]) {
    it(`refuses missing or changed migration ${index + 1}`, () => {
      expect(() =>
        assertInstalled(
          expected,
          installed().filter((_, i) => i !== index)
        )
      ).toThrow();
      for (const field of ['name', 'sql_md5', 'statement_count']) {
        const rows = installed();
        (rows[index] as any)[field] = field === 'statement_count' ? 2 : 'changed';
        expect(() => assertInstalled(expected, rows)).toThrow();
      }
      expect(() => assertInstalled(expected, [...installed(), installed()[index]])).toThrow();
    });
  }
  for (const failure of [false, true]) {
    it(`closes its read-only transaction on ${failure ? 'refusal' : 'success'}`, async () => {
      const queries: string[] = [];
      const client = {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: failure ? [] : installed() };
        },
      };
      if (failure) await expect(verifyInstalled(client, expected)).rejects.toThrow();
      else await verifyInstalled(client, expected);
      expect(queries[0]).toBe('BEGIN READ ONLY');
      expect(queries.at(-1)).toBe('ROLLBACK');
      expect(queries.join('\n')).not.toMatch(/INSERT|UPDATE|DELETE|CREATE|ALTER|COMMIT/);
    });
  }
  it('refuses unreadable history and still closes its transaction', async () => {
    const queries: string[] = [];
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        if (sql.includes('SELECT')) throw Error('unreadable');
        return { rows: [] };
      },
    };
    await expect(verifyInstalled(client, expected)).rejects.toThrow('unreadable');
    expect(queries.at(-1)).toBe('ROLLBACK');
  });
  it('adds only this actual DB dependency before any origin mutation', () => {
    const workflow = parse(
      readFileSync('.github/workflows/publish-club-arena-transaction.yml', 'utf8')
    );
    const steps = workflow.jobs['publish-to-origin'].steps;
    const gate = steps.findIndex(
      (step: any) => step.name === 'Verify installed MTT payout policy before origin publication'
    );
    expect(gate).toBeGreaterThan(0);
    expect(steps[gate]).toEqual({
      name: 'Verify installed MTT payout policy before origin publication',
      env: { DATABASE_URL: '${{ secrets.DATABASE_URL }}' },
      run: 'timeout 30s node scripts/ci/check-mtt-payout-publication.mjs',
    });
    expect(steps[gate - 1].run).toBe(
      'npm ci --prefix server --omit=dev --ignore-scripts --no-audit --no-fund'
    );
    expect(gate).toBeLessThan(
      steps.findIndex((step: any) => step.name === 'Install the origin key and pin the host key')
    );
    const source = readFileSync('scripts/ci/check-mtt-payout-publication.mjs', 'utf8');
    expect(source).not.toMatch(/engine\.smarter|readyForRestart|CONTINUATION_DOORS/);
    expect(source).toContain('rejectUnauthorized: true');
    expect(source).toContain("new URL('./certificates/supabase-prod-ca-2021.crt'");
  });
});
