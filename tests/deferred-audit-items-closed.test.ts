/**
 * THE LAST THREE DEFERRED AUDIT ITEMS, CLOSED OR CORRECTED.
 *
 * Two of the four things I had recorded as open defects were NOT defects when
 * checked against main. Recording that matters as much as the fixes: acting on
 * a stale note is how you "fix" working code.
 *
 *   NOT A BUG - aria-controls IDREFs. Every target exists: stats-panel-${cat},
 *     market-panel, club-data-panel-games / -players. No change made.
 *   NOT A BUG - the CashierTradePage TDZ. loadPendingCount is a useCallback with
 *     deps [clubUuid]; setPendingCount appears only in the BODY, which runs when
 *     invoked (from an effect), long after the useState on the later line has
 *     executed. Nothing evaluates it at definition time. No change made.
 *   REAL - loadRef.current assigned during render (fixed here).
 *   REAL - balance_after means different things in different rows (documented
 *     in 20260826000000 rather than silently redefined).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceStatement } from './helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const STATS = read('src/pages/PlayerStatsPage.tsx');
const CASHIER = read('src/pages/CashierTradePage.tsx');
const MIGRATION = read('supabase/migrations/20260826000000_document_balance_after_ambiguity.sql');

describe('a ref is not mutated during render', () => {
  it('assigns loadRef inside a layout effect', () => {
    /**
     * Rendering must be free of side effects: React may double-invoke a render
     * (StrictMode) or abandon one entirely (concurrent). An abandoned render
     * could otherwise leave loadRef pointing at a loader for state that was
     * never committed - the exact stale-closure bug the ref exists to prevent.
     */
    expect(STATS).toMatch(
      /useLayoutEffect\(\(\) => \{\s*\n\s*loadRef\.current = loadAllData;\s*\n\s*\}\);/
    );
  });

  it('no longer assigns it at bare render scope', () => {
    // The old line, with no effect wrapper around it.
    expect(STATS).not.toMatch(/\n {2}loadRef\.current = loadAllData;\n/);
  });

  it('imports useLayoutEffect', () => {
    expect(STATS).toMatch(/import \{[^}]*useLayoutEffect[^}]*\} from 'react';/);
  });
});

describe('the balance_after ambiguity is documented, not silently redefined', () => {
  it('warns that the column is not comparable across rows', () => {
    expect(MIGRATION).toMatch(/NOT COMPARABLE ACROSS ROWS/);
  });

  it('names both writers and which party each stores', () => {
    expect(MIGRATION).toMatch(/fn_cashier_send_chips stores the RECIPIENT/);
    expect(MIGRATION).toMatch(/fn_issue_tournament_ticket stores the ISSUER/);
  });

  it('points at the unambiguous metadata keys instead', () => {
    expect(MIGRATION).toMatch(/from_balance_after/);
    expect(MIGRATION).toMatch(/issuer_balance_after/);
  });

  it('asserts the comment actually landed', () => {
    expect(MIGRATION).toMatch(/RAISE EXCEPTION 'the balance_after comment did not land'/);
  });
});

describe('the two items that were NOT bugs stay unchanged', () => {
  it('loadPendingCount counts only the requests the viewer can act on', () => {
    // 2026-08-26 cashier audit: fn_respond_chip_request lets agent-tier roles
    // answer only requests ADDRESSED to them, so the badge now scopes its
    // count the same way and legitimately depends on myRole and user?.id too.
    // All three are declared above the callback, so there is still no TDZ.
    expect(sliceStatement(CASHIER, 'const loadPendingCount = useCallback')).toMatch(
      /\}, \[clubUuid, myRole, user\?\.id\]\);/
    );
  });

  it('the aria-controls targets still exist, so nothing was "fixed" there', () => {
    expect(STATS).toMatch(/id=\{`stats-panel-\$\{category\}`\}/);
  });
});
