import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A capped-height or sideways-scrolling region with no control inside it must
 * take focus itself, or a keyboard user cannot scroll it (axe
 * scrollable-region-focusable, serious). Post-Deploy E2E run 37575691538 found
 * the Settlement Center ledger list and weekly summaries table; the chip
 * statement list on CSV Exports has the same shape.
 */
const source = (path: string) => readFileSync(path, 'utf8');

describe('financial scroll regions take keyboard focus', () => {
  it('the transaction ledger list', () => {
    expect(source('src/components/common/TransactionLedgerView.tsx')).toContain(
      '<ol className="tlv-list" tabIndex={0} aria-label="Ledger Rows">'
    );
    expect(source('src/components/common/TransactionLedgerView.css')).toContain(
      '.tlv-list:focus-visible'
    );
  });

  it('the chip statement movements list', () => {
    expect(source('src/components/wallet/ChipStatement.tsx')).toContain(
      '<ol className="chip-statement__legs" aria-label="Chip Movements" tabIndex={0}>'
    );
    expect(source('src/components/wallet/ChipStatement.css')).toContain(
      '.chip-statement__legs:focus-visible'
    );
  });

  it('the weekly summaries table', () => {
    expect(source('src/components/accounting/ClubWeeklyAccountingSummary.module.css')).toContain(
      '.tableScroll:focus-visible'
    );
  });
});
