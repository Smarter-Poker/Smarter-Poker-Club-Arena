import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('live-table Diamond Store wiring', () => {
  it('continues from wallet history into the real top-up checkout', () => {
    const source = readFileSync('src/components/table/TableModalsLayer.tsx', 'utf8');
    const walletMount = source.slice(
      source.indexOf('<DiamondWalletModal'),
      source.indexOf('{/* Bust Rebuy Modal */}')
    );

    expect(walletMount).toContain('onBuyClick={() =>');
    expect(walletMount).toContain('setShowDiamondTopUp(true)');
    expect(walletMount).toContain('<DiamondTopUpModal');
    expect(walletMount).toContain('isOpen={showDiamondTopUp}');
  });
});
