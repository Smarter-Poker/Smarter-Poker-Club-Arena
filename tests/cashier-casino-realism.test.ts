import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.module.css'), 'utf8');

describe('the cashier is a rendered Club Arena room, not a generic dark dashboard', () => {
  it('uses the approved painted console master instead of the retired vault hero', () => {
    expect(PAGE).toContain('<SpadeConsole');
    expect(PAGE).not.toContain('cashier-vault-hero');
    expect(PAGE).not.toContain('CashierConsoleSurface');
  });

  it('keeps all balances and access data live in HTML', () => {
    expect(PAGE).toContain('fmt(myBalance)');
    expect(PAGE).toContain('fmt(agentWallet)');
    expect(PAGE).toContain('roleLabel(myRole as ClubRole)');
  });

  it('names #ClubArenaConsole as its visual authority and respects reduced motion', () => {
    expect(CSS).toContain('#ClubArenaConsole is the visual authority');
    expect(CSS).not.toContain('--cashier-blue');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('cashier navigation and ledger controls stay operational', () => {
  it('implements a keyboard-operable tablist', () => {
    expect(PAGE).toContain('role="tablist"');
    expect(PAGE).toContain('aria-label="Cashier Actions"');
    expect(PAGE).toContain('aria-busy={!roleResolved}');
    expect(PAGE).toContain("['ArrowRight', 'ArrowLeft', 'Home', 'End']");
    expect(PAGE).toContain('aria-selected={tab === key}');
  });

  it('loads ledger pages with a truthful sentinel row', () => {
    expect(PAGE).toContain("supabase.rpc('fn_club_trade_ledger'");
    expect(PAGE).toContain('p_limit: recordsLimit + 1');
    expect(PAGE).toContain('setRecordsHasMore((data || []).length > recordsLimit)');
    expect(PAGE).toContain('setRecordsLimit((limit) => Math.min(limit + 50, 250))');
  });

  it('provides local search and direction filters without widening the money path', () => {
    expect(PAGE).toContain("useState<'all' | 'in' | 'out' | 'managed'>('all')");
    expect(PAGE).toContain('row.counterparty.toLowerCase().includes(q)');
    expect(PAGE).toContain("supabase.rpc('fn_cashier_batch_transfer'");
  });
});
