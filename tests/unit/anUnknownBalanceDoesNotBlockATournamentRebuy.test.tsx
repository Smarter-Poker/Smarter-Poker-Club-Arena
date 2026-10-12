/**
 * AN UNKNOWN BALANCE DOES NOT BLOCK A TOURNAMENT REBUY (launch audit
 * 2026-10-05). A balance that could not be read arrived at the prompt as 0:
 * red figure, Rebuy disabled, and the player was eliminated when the window
 * closed with the chips to stay in.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import RebuyModal from '../../src/components/table/RebuyModal';

function open(walletBalance: number | null) {
  return render(
    <RebuyModal
      isOpen
      rebuyCost={90}
      rebuyFee={10}
      rebuyChips={1500}
      walletBalance={walletBalance}
      onConfirm={vi.fn()}
      onClose={vi.fn()}
      isProcessing={false}
    />
  );
}

const confirm = () => screen.getByRole('button', { name: 'Rebuy 100' }) as HTMLButtonElement;

describe('an unknown balance does not block a tournament rebuy', () => {
  it('unknown: the attempt is allowed and no figure is invented', () => {
    open(null);
    expect(confirm().disabled).toBe(false);
    expect(screen.getByText('--')).toBeTruthy();
  });

  it('known and short: still refused before the server is asked', () => {
    open(99.99);
    expect(confirm().disabled).toBe(true);
  });

  it('known and enough: allowed', () => {
    open(100);
    expect(confirm().disabled).toBe(false);
  });

  it('the prompt is handed the balance as read, and re-reads it when it opens', () => {
    const layer = readFileSync(
      join(__dirname, '..', '..', 'src', 'components', 'table', 'TableModalsLayer.tsx'),
      'utf8'
    );
    expect(layer).toContain('walletBalance={accountBalance}');
    expect(layer).not.toContain('walletBalance={accountBalance || 0}');
    const page = readFileSync(join(__dirname, '..', '..', 'src', 'pages', 'TablePage.tsx'), 'utf8');
    expect(page).toContain('if (showRebuyModal) retryAccountBalance();');
  });
});
