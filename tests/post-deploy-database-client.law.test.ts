import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/post-deploy-e2e.yml'),
  'utf8'
);

describe('the post-deploy database contract has its database client', () => {
  it('provisions psql before invoking the live contract', () => {
    const provision = workflow.indexOf('name: Ensure PostgreSQL client is available');
    const contract = workflow.indexOf('name: Certify the live cashier database contract');

    expect(provision).toBeGreaterThan(-1);
    expect(workflow.slice(provision, contract)).toContain('command -v psql');
    expect(workflow.slice(provision, contract)).toContain('postgresql-client');
    expect(provision).toBeLessThan(contract);
  });
});
