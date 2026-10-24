import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/*
 * 2026-10-24: three migrations merged in one PR were dispatched to Apply
 * Merged Migration in the same second. The workflow had ONE concurrency group,
 * and GitHub keeps at most one pending run per group, cancelling the older
 * pending run when a newer one arrives. One file applied; two runs ended
 * `cancelled` (not red), and two tournament fixes sat merged but uninstalled.
 *
 * The group is keyed by the migration file, so two different files can never
 * cancel each other, while one file dispatched twice still serialises.
 */
const workflow = parse(
  readFileSync(resolve(__dirname, '../../.github/workflows/apply-merged-migration.yml'), 'utf8')
) as { concurrency: { group: string; 'cancel-in-progress': boolean } };

describe('Apply Merged Migration never drops a dispatched file', () => {
  it('keys its concurrency group by the migration from both doors', () => {
    const { group } = workflow.concurrency;
    expect(group).toContain('inputs.migration');
    expect(group).toContain('github.event.client_payload.migration');
    expect(group).not.toBe('apply-merged-migration');
  });

  it('never cancels a run in progress', () => {
    expect(workflow.concurrency['cancel-in-progress']).toBe(false);
  });
});
