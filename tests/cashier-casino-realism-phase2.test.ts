import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.module.css'), 'utf8');

describe('cashier phase 2 reports trustworthy operational state', () => {
  it('never calls a failed or partially unread cashier synchronized', () => {
    expect(PAGE).toContain("? 'Cashier sync requires attention'");
    expect(PAGE).toContain("? 'Agent wallet could not be verified'");
    expect(PAGE).toContain("? 'Unavailable'");
    expect(PAGE).toContain('securityDotWarning');
  });

  it('surfaces and retries a failed club-switcher query', () => {
    expect(PAGE).toContain("setMembershipsError('Could not load your club cashiers.')");
    expect(PAGE).toContain('setMembershipsReload((value) => value + 1)');
    expect(PAGE).toContain('[user?.id, membershipsReload]');
    expect(PAGE).toContain('if (live) setMembershipsLoading(false)');
  });

  it('gives a failed ledger read a real retry and a truthful filtered empty state', () => {
    expect(PAGE).toContain('setRecordsReload((value) => value + 1)');
    expect(PAGE).toContain('[tab, loadRecords, recordsReload]');
    expect(PAGE).toContain('No Ledger Entries Match Those Filters.');
  });
});

describe('cashier phase 2 hardens money intent math and retries', () => {
  it('computes batch totals in chip cents everywhere the total is used', () => {
    expect(PAGE).toMatch(/const batchAmount = \(amountPerTarget: number, targetCount: number\)/);
    expect(PAGE).toContain('const total = batchAmount(value, targets.length)');
    expect(PAGE).toContain('fmt(batchAmount(Number(amount) || 0, picked.length))');
  });

  it('retains a claim idempotency key until the server confirms success', () => {
    expect(PAGE).toContain('claimOpIdsRef.current.get(row.transaction_id) || newOpId()');
    expect(PAGE).toContain('p_op_id: heldOpId');
    expect(PAGE).toContain('claimOpIdsRef.current.delete(row.transaction_id)');
  });
});

describe('cashier phase 2 completes keyboard and structural semantics', () => {
  it('connects every tab to a labelled tab panel', () => {
    expect(PAGE).toContain('aria-controls={`cashier-panel-${key}`}');
    for (const key of ['trade', 'record', 'leaderboard', 'request', 'tickets']) {
      expect(PAGE).toContain(`id="cashier-panel-${key}"`);
      expect(PAGE).toContain(`aria-labelledby="cashier-tab-${key}"`);
    }
    expect(PAGE.match(/role="tabpanel"/g)).toHaveLength(5);
  });

  it('traps dialog focus and restores it to the opening control', () => {
    expect(PAGE).toContain("if (e.key !== 'Tab' || !dialogRef.current) return");
    expect(PAGE).toContain('dialogTriggerRef.current?.focus()');
    expect(PAGE.match(/ref=\{dialogRef\}/g)).toHaveLength(4);
  });

  it('makes the club picker dismissible and arrow-key navigable', () => {
    expect(PAGE).toContain("document.addEventListener('pointerdown', onPointerDown)");
    expect(PAGE).toContain("if (event.key !== 'Escape') return");
    expect(PAGE).toContain("['ArrowDown', 'ArrowUp', 'Home', 'End']");
    expect(PAGE).toContain(
      '(picker?.querySelector<HTMLElement>(\'[role="option"]\') || picker)?.focus()'
    );
  });

  it('only gives a pointer cursor to rows that actually select', () => {
    expect(CSS).toMatch(/\.row\s*\{[\s\S]*?cursor: default;/);
    expect(CSS).toMatch(/\.selectableRow\s*\{[\s\S]*?cursor: pointer;/);
    expect(PAGE).toContain('styles.selectableRow');
  });
});
