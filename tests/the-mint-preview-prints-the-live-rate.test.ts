/**
 * THE MINT PREVIEW PRINTS THE LIVE RATE (2026-10-06)
 *
 * fn_mint_chips_from_diamonds charges at public.fn_ca_bridge_rate() (diamonds
 * per chip, a row in ca_bridge_rate; 100 since 2026-09-07). The Club Bank
 * Cashier's Chip Mint still printed the 2026-08-21 rate ("100 Diamonds = 10K
 * Chips") while the server credited 1 chip, and the classic Cashier's Mint tab
 * quoted 1 diamond per 100 chips. Every preview now reads the same function
 * the server charges at, through useBridgeRate, and carries no literal rate.
 * Recorded in docs/changelog/2026-10-06-the-mint-tabs-charge-the-live-rate.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string) => readFileSync(resolve(__dirname, '..', p), 'utf8');
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the mint previews print the rate the server charges', () => {
  it('useBridgeRate reads fn_ca_bridge_rate and treats a failed read as no rate', () => {
    const hook = code('src/hooks/useBridgeRate.ts');
    expect(hook).toContain("supabase.rpc('fn_ca_bridge_rate')");
    expect(hook).toContain('setState({ diamondsPerChip: null, failed: true })');
  });

  it('the Club Bank Chip Mint derives chips and its subtitle from the live rate', () => {
    const mint = code('src/components/wallet/ChipMintModal.tsx');
    expect(mint).toContain('useBridgeRate(isOpen)');
    expect(mint).toContain('Math.round((d / rate) * 100) / 100');
    expect(mint).toContain('`${fmt(rate)} Diamonds = 1 Chip`');
    expect(mint).toContain('rate !== null');
    expect(mint).not.toMatch(/CHIPS_PER_DIAMOND/);
    expect(mint).not.toMatch(/10K Chips/);
  });

  it('the classic Cashier mint quote uses the live rate and mints whole chips', () => {
    const cashier = code('src/pages/CashierPage.tsx');
    expect(cashier).toContain('useBridgeRate()');
    expect(cashier).toContain('* mintRate).toLocaleString()} Diamonds Required');
    expect(cashier).not.toMatch(/DIAMOND_RATE_(NUM|DEN)/);
    expect(cashier).toContain("'Mint Whole Chips Only'");
  });

  it('the legacy mint service reports the diamonds the route actually spent', () => {
    const svc = code('src/services/WalletService.ts');
    expect(svc).toContain('Number(mintData.diamondsSpent) || 0');
    expect(svc).not.toMatch(/Math\.ceil\(chipAmount \/ 100\)/);
  });
});
