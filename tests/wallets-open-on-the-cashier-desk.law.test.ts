import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Dan 2026-10-16: "When you click the union bank wallet, promo wallet or
// diamond wallet, they should look feel and function like this cashier
// functionality. Remove the bulky generic frames."
const read = (p: string) => readFileSync(p, 'utf8');
const desk = read('src/components/wallet/WalletDesk.tsx');
const css = read('src/components/wallet/WalletDesk.css');
const union = read('src/components/union/UnionWalletModal.tsx');
const diamond = read('src/components/wallet/DiamondWalletModal.tsx');

describe('the union and diamond wallets open on the Cashier desk', () => {
  it('prints the Cashier heading, an identity row and the painted action dock', () => {
    // 2026-10-17: the heading is for assistive technology and the "?" holds
    // what the desk is for (Dan: "PAGES DON'T NEED TITLES LIKE THIS").
    expect(desk).toMatch(/<CashierWorkspace\s+compact\s+title="Cashier"\s+summary="[^"]+"/);
    expect(desk).not.toMatch(/<CashierWorkspace[^>]*eyebrow=/);
    expect(desk).toContain('className="wdesk__header"');
    expect(css).toContain("url('/images/cashier-actions/cashier-action-dock-v1.png')");
    expect(css).toContain("url('/images/cashier-actions/cashier-action-dock-tall-v1.png')");
    // The desk is a layout, not a popup: the metallic popup chassis stays off it.
    expect(desk).toContain('data-popup-chassis="none"');
  });

  it('draws no frame, pill, gradient or hover state in CSS', () => {
    expect(css).not.toMatch(/border-radius:\s*[1-9]/);
    expect(css).not.toMatch(/(linear|radial|conic)-gradient\(/);
    expect(css).not.toMatch(/:hover\b/);
  });

  it('opens the union bank, promo wallet and every union wallet on it, with Pull Back | Ledger | Send Out', () => {
    expect(union).toContain('<WalletDesk');
    expect(union).toContain("label: 'Pull Back'");
    expect(union).toContain("label: mode === 'ledger' ? 'Recipients' : 'Ledger'");
    expect(union).toContain("label: 'Send Out'");
    expect(union).toContain('<WalletDeskRow');
    // The union's own logo leads the desk, as the club's leads the Cashier.
    expect(union).toContain(".from('clubs')");
    expect(union).toContain('const art = unionLogo;');
  });

  it('opens the diamond wallet on it, with Send Diamonds | Buy Diamonds', () => {
    expect(diamond).toContain('<WalletDesk');
    expect(diamond).toContain("label: 'Send Diamonds'");
    expect(diamond).toContain("label: 'Buy Diamonds'");
    expect(diamond).toContain('<WalletDeskRow');
  });
});
