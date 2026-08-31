import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const PAGE = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.tsx'), 'utf8');
const CSS = readFileSync(resolve(ROOT, 'src/pages/CashierTradePage.module.css'), 'utf8');
const HERO = resolve(ROOT, 'public/images/cashier/cashier-vault-hero-v1.webp');

describe('the cashier is a rendered Club Arena room, not a generic dark dashboard', () => {
  it('ships a purpose-built, web-sized vault render through the Vite base path', () => {
    expect(existsSync(HERO)).toBe(true);
    expect(statSync(HERO).size).toBeLessThan(150_000);
    expect(PAGE).toContain(
      '`${import.meta.env.BASE_URL}images/cashier/cashier-vault-hero-v1.webp`'
    );
    expect(PAGE).toContain('fetchPriority="high"');
  });

  it('keeps all balances and access data live in HTML', () => {
    expect(PAGE).toContain('fmt(myBalance)');
    expect(PAGE).toContain('fmt(agentWallet)');
    expect(PAGE).toContain('roleLabel(myRole as ClubRole)');
  });

  it('uses the cashier visual system and respects reduced motion', () => {
    expect(CSS).toContain('#SMARTERCASINOREALISM');
    expect(CSS).toContain('--cashier-blue: #36a9ff');
    expect(CSS).toContain('@media (prefers-reduced-motion: reduce)');
  });
});

describe('cashier navigation and ledger controls stay operational', () => {
  it('implements a keyboard-operable tablist', () => {
    expect(PAGE).toContain('role="tablist"');
    expect(PAGE).toContain('aria-label="Cashier Actions"');
    expect(PAGE).toContain("['ArrowRight', 'ArrowLeft', 'Home', 'End']");
    expect(PAGE).toContain('aria-selected={tab === key}');
  });

  it('loads ledger pages with a truthful sentinel row', () => {
    expect(PAGE).toContain('.limit(recordsLimit + 1)');
    expect(PAGE).toContain('setRecordsHasMore((data || []).length > recordsLimit)');
    expect(PAGE).toContain('setRecordsLimit((limit) => Math.min(limit + 50, 250))');
  });

  it('provides local search and direction filters without widening the money path', () => {
    expect(PAGE).toContain("useState<'all' | 'in' | 'out'>('all')");
    expect(PAGE).toContain('row.counterparty.toLowerCase().includes(q)');
    expect(PAGE).toContain("supabase.rpc('fn_cashier_batch_transfer'");
  });
});
