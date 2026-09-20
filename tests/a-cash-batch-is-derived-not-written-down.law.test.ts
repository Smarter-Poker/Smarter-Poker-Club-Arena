import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const settler = readFileSync(
  resolve(process.cwd(), 'server/src/services/RakebackSettlerService.ts'),
  'utf8'
);

/**
 * THE SETTLER'S BATCH SIZES ARE DERIVED, NOT WRITTEN DOWN.
 *
 * On 2026-09-17 the cash rakeback settler stopped for three days and 264,835
 * rake records carrying 485,712.99 piled up behind a cursor that never moved.
 * Nothing threw. Two literals - a 150-item credit batch and a 50-item retry -
 * had each been sized honestly against a constraint that later changed, and a
 * literal cannot notice that its own cost moved. CLAUDE.md 1.1.7.
 */
describe('a cash batch is derived, not written down', () => {
  it('does not write the credit batch size down as a literal', () => {
    expect(settler).not.toMatch(/const\s+CREDIT_BATCH_SIZE\s*=\s*\d+\s*;/);
    expect(settler).toMatch(/const\s+CREDIT_BATCH_SIZE\s*=\s*cashAccountingBatchSize\(/);
  });

  it('does not write the durable-refusal retry bound down as a literal', () => {
    expect(settler).not.toMatch(/p_limit:\s*\d+\s*,/);
    expect(settler).toMatch(/p_limit:\s*CASH_RETRY_LIMIT\s*,/);
    expect(settler).toMatch(/const\s+CASH_RETRY_LIMIT\s*=\s*cashAccountingBatchSize\(/);
  });

  it('derives both from the client timeout that actually binds them', () => {
    // Resolved through the import-free budget module, NOT by importing the
    // database client: four suites mock that module, and a constant imported
    // through a mock is a constant that disappears.
    expect(settler).toMatch(
      /import\s*\{[^}]*resolveClientTimeoutMs[^}]*\}\s*from\s*'\.\/cashAccountingBatchBudget\.js'/
    );
    expect(settler).toMatch(/cashAccountingBatchSize\(resolveClientTimeoutMs\(\)\)/);
    expect(settler).not.toMatch(/from\s*'\.\/supabase\/client\.js'/);
  });

  it('checks the retry response against the same derived bound it asked for', () => {
    // It used to ask for 50 and validate against a second, separate 50.
    expect(settler).toMatch(/retriedSources\.length\s*>\s*CASH_RETRY_LIMIT/);
  });
});
