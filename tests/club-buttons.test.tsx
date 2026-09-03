import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  ArenaActionButton,
  ArenaModalFrame,
  ArenaTabs,
  ArenaWalletRow,
} from '../src/components/club-buttons';

describe('#ClubButtons production components', () => {
  it('preserves native button behavior and blocks duplicate loading actions', () => {
    const onClick = vi.fn();
    render(<ArenaActionButton label="Join Table" onClick={onClick} loading />);

    const button = screen.getByRole('button', { name: /join table/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps unknown wallet data distinct from zero', () => {
    const { rerender } = render(<ArenaWalletRow label="Club Bank" value="$0.00" />);
    expect(screen.getByText('$0.00')).toBeInTheDocument();

    rerender(<ArenaWalletRow label="Club Bank" dataState="error" />);
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('supports arrow, Home, and End navigation for tabs', () => {
    const onChange = vi.fn();
    const items = [
      { value: 'overview', label: 'Overview' },
      { value: 'players', label: 'Players' },
      { value: 'payouts', label: 'Payouts' },
    ];
    render(<ArenaTabs items={items} value="overview" onChange={onChange} />);

    const overview = screen.getByRole('tab', { name: 'Overview' });
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('players');
    fireEvent.keyDown(overview, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('payouts');
  });

  it('dismisses a modal with Escape', () => {
    const onClose = vi.fn();
    render(
      <ArenaModalFrame title="Tournament Registration" onClose={onClose}>
        Content
      </ArenaModalFrame>
    );

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
