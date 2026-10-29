import '@testing-library/jest-dom/vitest';
import { type ComponentProps, type ComponentType } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const presence = vi.hoisted(() => ({
  calls: 0,
  answer: undefined as boolean | undefined,
  listeners: new Set<() => void>(),
}));
// The real row tree is measured; only the presence transport is replaced with
// a synchronous store so independent live updates can be exercised deterministically.
vi.mock('../../src/hooks/useProfilePresence', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useOnlineNow: (_id: string, loaded: boolean) => {
      presence.calls += 1;
      const live = useSyncExternalStore(
        (listener) => {
          presence.listeners.add(listener);
          return () => {
            presence.listeners.delete(listener);
          };
        },
        () => presence.answer
      );
      return live ?? loaded;
    },
  };
});
import { MemberRow } from '../../src/pages/ClubMembersPage';
import { mapRosterRow } from '../../src/services/ClubRosterService';

type Props = ComponentProps<typeof MemberRow>;
const columns: Props['columns'] = new Set(['wallets', 'fees', 'activity', 'downlines']);
function row(index = 0): Props {
  return {
    member: mapRosterRow({
      user_id: `test-player-${index}`,
      alias: `Player ${index}`,
      username: `player${index}`,
      player_number: `${index}`,
      role: 'player',
      can_view_financials: true,
      player_wallet: 250,
      agent_wallet: 10,
      total_fees: 87.5,
      downline_fees: 0,
    }),
    position: index + 1,
    total: 10_000,
    query: '',
    selectable: true,
    selected: false,
    onOpen: vi.fn(),
    onSelect: vi.fn(),
    columns,
  };
}

beforeEach(() => {
  presence.calls = 0;
  presence.answer = undefined;
  presence.listeners.clear();
});

describe('Phase 6 real roster row render budget', () => {
  it('avoids 192 unchanged row renders across eight parent commits', () => {
    const rows = Array.from({ length: 24 }, (_, index) => row(index));
    // React.memo retains the identical underlying function. This is the actual
    // pre-memo row, not a synthetic slow implementation or timing approximation.
    const UnmemoizedRow = (MemberRow as unknown as { type: ComponentType<Props> }).type;
    expect(typeof UnmemoizedRow).toBe('function');
    function Harness({ optimized, tick }: { optimized: boolean; tick: number }) {
      const Row = optimized ? MemberRow : UnmemoizedRow;
      return (
        <div role="list" data-parent-tick={tick}>
          {rows.map((props) => (
            <Row key={props.member.user_id} {...props} />
          ))}
        </div>
      );
    }
    const before = render(<Harness optimized={false} tick={0} />);
    expect(presence.calls).toBe(24);
    const initialBefore = presence.calls;
    for (let tick = 1; tick <= 8; tick++)
      before.rerender(<Harness optimized={false} tick={tick} />);
    expect(presence.calls - initialBefore).toBe(192);
    before.unmount();
    presence.calls = 0;
    const after = render(<Harness optimized tick={0} />);
    expect(presence.calls).toBe(24);
    const initialAfter = presence.calls;
    for (let tick = 1; tick <= 8; tick++) after.rerender(<Harness optimized tick={tick} />);
    expect(presence.calls - initialAfter).toBe(0);
    expect(screen.getAllByRole('listitem')).toHaveLength(24);
    expect(screen.getByRole('button', { name: 'Open Player 23, Player, Offline' })).toBeEnabled();
  });

  it('renders the one selected row while all unchanged siblings skip work', () => {
    const rows = Array.from({ length: 24 }, (_, index) => row(index));
    const view = render(
      <>
        {rows.map((props) => (
          <MemberRow key={props.member.user_id} {...props} />
        ))}
      </>
    );
    presence.calls = 0;
    view.rerender(
      <>
        {rows.map((props, index) => (
          <MemberRow key={props.member.user_id} {...props} selected={index === 7} />
        ))}
      </>
    );
    expect(presence.calls).toBe(1);
    expect(screen.getByRole('checkbox', { name: 'Select Player 7' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select Player 8' })).not.toBeChecked();
  });

  it('retains live presence changes inside memoized rows', () => {
    const props = row();
    render(<MemberRow {...props} />);
    presence.calls = 0;
    act(() => {
      presence.answer = true;
      presence.listeners.forEach((listener) => listener());
    });
    expect(presence.calls).toBe(1);
    expect(screen.getByRole('button', { name: 'Open Player 0, Player, Online' })).toBeEnabled();
    act(() => {
      presence.answer = false;
      presence.listeners.forEach((listener) => listener());
    });
    expect(screen.getByRole('button', { name: 'Open Player 0, Player, Offline' })).toBeEnabled();
  });

  it('applies new wallets, role, seating and revoked financial visibility immediately', () => {
    const props = row();
    const view = render(<MemberRow {...props} />);
    expect(screen.getByText('Player Wallet')).toBeVisible();
    const changed = {
      ...props.member,
      alias: 'Updated Player',
      role: 'agent' as const,
      player_wallet: 999,
      is_seated: true,
    };
    view.rerender(<MemberRow {...props} member={changed} />);
    expect(
      screen.getByRole('button', { name: 'Open Updated Player, Agent, At A Table' })
    ).toBeEnabled();
    expect(screen.getByText('999.00')).toBeVisible();
    view.rerender(<MemberRow {...props} member={{ ...changed, can_view_financials: false }} />);
    expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
    expect(screen.queryByText('999.00')).not.toBeInTheDocument();
  });

  it('propagates latest callbacks, selection authority, layout, query and accessible position', () => {
    const props = row();
    const view = render(<MemberRow {...props} />);
    const open = vi.fn();
    const select = vi.fn();
    const next = {
      ...props,
      onOpen: open,
      onSelect: select,
      query: 'Player',
      position: 61,
      total: 419,
      selected: true,
      simpleMode: true,
    };
    view.rerender(<MemberRow {...next} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Player 0, Player, Offline' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Player 0' }));
    expect(open).toHaveBeenCalledWith('test-player-0');
    expect(select).toHaveBeenCalledWith('test-player-0');
    expect(props.onOpen).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('aria-posinset', '61');
    expect(item).toHaveAttribute('aria-setsize', '419');
    expect(item.querySelector('mark')).toHaveTextContent('Player');
    // Simple mode leads with fees generated, never a wallet balance.
    expect(screen.getByText('87.50')).toBeVisible();
    expect(screen.getByText('Fees Generated')).toBeVisible();
    expect(screen.queryByText('250.00')).not.toBeInTheDocument();
    expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent Wallet')).not.toBeInTheDocument();
    view.rerender(
      <MemberRow {...next} selectable={false} simpleMode={false} columns={new Set()} />
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText('Player Wallet')).not.toBeInTheDocument();
  });
});
