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
    expect(PAGE).toContain('formatWalletChips(myBalance)');
    expect(PAGE).toContain('formatWalletChips(agentWallet)');
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
    expect(PAGE).toContain("supabase.rpc('fn_cashier_history_feed'");
    expect(PAGE).toContain('p_limit: HISTORY_PAGE + 1');
    expect(PAGE).toContain('setRecordsHasMore(rows.length > HISTORY_PAGE)');
    // Older pages are read by cursor from the last row on screen.
    expect(PAGE).toContain('p_before_at: last.createdAt,');
    expect(PAGE).toContain('p_before_id: last.id,');
  });

  it('searches on the server and filters direction locally without widening the money path', () => {
    expect(PAGE).toMatch(
      /usePlayerPreference<'all' \| 'in' \| 'out'>\(\s*'CashierTradePage:recordDirection',\s*'all'/
    );
    // The search reaches the whole history on the server (a name or an invoice number).
    expect(PAGE).toContain('p_search: historySearch || null,');
    expect(PAGE).toContain("recordDirection === 'all' || row.direction === recordDirection");
    expect(PAGE).toContain("supabase.rpc('fn_cashier_batch_transfer'");
  });
});
