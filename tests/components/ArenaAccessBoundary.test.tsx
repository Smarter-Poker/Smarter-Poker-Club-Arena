import { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), auth: vi.fn(), unsubscribe: vi.fn() }));
vi.mock('../../src/stores/useUserStore', () => ({
  useUserStore: { getState: () => ({ user: { id: 'account-a' } }) },
}));
vi.mock('../../src/services/ArenaContextService', () => ({ getArenaContext: mocks.access }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: { auth: { onAuthStateChange: mocks.auth } },
}));
import ArenaAccessBoundary from '../../src/components/arena/ArenaAccessBoundary';
const chip = {
  arena: { id: 'chip', kind: 'chip_club', asset: 'chips' },
  member: true,
  automaticMembership: false,
  role: 'player',
  capabilities: { join: true, hierarchy: true, chipWallet: true, diamondTransfers: false },
};
const diamond = {
  arena: { id: 'diamond', kind: 'diamond_arena', asset: 'diamonds' },
  member: true,
  automaticMembership: true,
  role: 'player',
  capabilities: { join: false, hierarchy: false, chipWallet: false, diamondTransfers: true },
};
/** Prints wherever the boundary sends us, so a navigation is assertable. */
function Here() {
  return <div data-testid="here">{useLocation().pathname}</div>;
}
const view = (key: string) => (
  <MemoryRouter>
    <ArenaAccessBoundary clubKey={key}>
      <div>Private Chip Lobby</div>
    </ArenaAccessBoundary>
    <Here />
  </MemoryRouter>
);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockReturnValue({ data: { subscription: { unsubscribe: mocks.unsubscribe } } });
});
describe('Arena entry before cached club content mounts', () => {
  it('admits joined chip members to the existing lobby', async () => {
    mocks.access.mockResolvedValue(chip);
    render(view('chip'));
    expect(await screen.findByText('Private Chip Lobby')).toBeTruthy();
  });
  it('requires an explicit join for an unjoined chip club', async () => {
    mocks.access.mockResolvedValue({ ...chip, member: false });
    render(view('chip'));
    // The join control is the console's painted primary plate now (2026-09-10,
    // #ClubArenaConsole), not a CSS link, so it is a button; what matters is
    // still that it is explicit and that it goes to the invite.
    const join = await screen.findByRole('button', { name: 'Join This Club' });
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
    fireEvent.click(join);
    await waitFor(() => expect(screen.getByTestId('here').textContent).toBe('/invite/chip'));
  });
  it('recognizes Diamond membership without mounting chip wallets or a join flow', async () => {
    mocks.access.mockResolvedValue(diamond);
    render(view('diamond'));
    expect(await screen.findByText('You Are Already A Member.')).toBeTruthy();
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join This Club' })).toBeNull();
  });
  it('does not show the previous club or accept a late response after switching', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    mocks.access.mockImplementation((key: string) =>
      key === 'old'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(diamond)
    );
    const page = render(view('old'));
    page.rerender(view('diamond'));
    await screen.findByText('You Are Already A Member.');
    await act(async () => {
      resolveOld(chip);
    });
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
  });
  it('removes private content on sign-out and unsubscribes on unmount', async () => {
    mocks.access.mockResolvedValue(chip);
    const page = render(view('chip'));
    await screen.findByText('Private Chip Lobby');
    act(() => mocks.auth.mock.calls[0][0]('SIGNED_OUT'));
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
    page.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
  it('refuses unknown identity instead of opening a chip lobby', async () => {
    mocks.access.mockResolvedValue(null);
    render(view('unknown'));
    expect(await screen.findByText('Arena Not Found')).toBeTruthy();
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
  });
  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, 'Delayed'],
    [{ code: '28000', message: 'Authentication Required' }, 'Sign In'],
    [new TypeError('Failed to fetch'), 'Connection'],
    [new Error('AbortError: signal is aborted without reason'), 'Delayed'],
    [new Error('Unexpected database failure'), 'Unavailable'],
  ])('reports an unreadable access result honestly: %s', async (error, pill) => {
    mocks.access.mockRejectedValue(error);
    render(view('chip'));
    expect(await screen.findByText(pill, { selector: '.sc__pill *' })).toBeTruthy();
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.queryByText(/Nothing Is Wrong With Your Account/)).toBeNull();
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
    expect(
      screen.getByRole('button', { name: pill === 'Sign In' ? 'Sign In' : 'Back To Clubs' })
    ).toBeTruthy();
  });
  it('shows loading during a retry and restores the verified page when it completes', async () => {
    let complete: (value: unknown) => void = () => {};
    mocks.access.mockRejectedValueOnce(new Error('Unavailable')).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        })
    );
    render(view('chip'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await act(async () => complete(chip));
    expect(await screen.findByText('Private Chip Lobby')).toBeTruthy();
  });
  it('retries a failed access read without treating the failure as a join requirement', async () => {
    mocks.access.mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValueOnce(chip);
    render(view('chip'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByText('Private Chip Lobby');
    expect(mocks.access).toHaveBeenCalledTimes(2);
  });
  it('removes private content if revalidation fails without navigating the host', async () => {
    mocks.access
      .mockResolvedValueOnce(chip)
      .mockRejectedValueOnce(new Error('Authentication Required'));
    render(view('chip'));
    await screen.findByText('Private Chip Lobby');
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText('Private Chip Lobby')).toBeNull());
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});

/**
 * Dan 2026-09-11: "DIAMOND ARENA NEEDS TO BE A 1:1 CLONE OF THE CLUB ARENA.
 * (ONLY DIFFERENCE IS ITS ALL 'ONE OPEN CLUB' WITH NO UNIONS OR AGENTS AND ITS
 * PLAYED WITH DIAMONDS INSTEAD OF CHIPS)".
 *
 * The arena's lobby route therefore renders the SAME lobby a joined chip club
 * renders. What is NOT one-to-one is the operator surface underneath a club:
 * finance, agents and the rest are chip-club screens with no Diamond meaning,
 * and "no unions or agents" has to hold on a typed URL, so those keep the safe
 * shell. These replace the earlier pins on the placeholder cash board, which
 * the shared lobby now supersedes.
 */
describe('Diamond Arena renders the shared lobby, not a placeholder', () => {
  const lobby = (entry: string) => (
    <MemoryRouter initialEntries={[entry]}>
      <ArenaAccessBoundary clubKey="diamond">
        <div>Shared Club Lobby</div>
      </ArenaAccessBoundary>
    </MemoryRouter>
  );

  it('renders the shared lobby on the arena route while funded play is closed', async () => {
    mocks.access.mockResolvedValue(diamond);
    render(lobby('/clubs/diamond'));
    expect(await screen.findByText('Shared Club Lobby')).toBeTruthy();
    expect(screen.getByText('Diamond Games Are Not Open For Play Yet.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Join This Club' })).toBeNull();
  });

  it('drops the closed-games notice once the server opens funded play', async () => {
    mocks.access.mockResolvedValue({ ...diamond, cashGamesEnabled: true });
    render(lobby('/clubs/diamond'));
    expect(await screen.findByText('Shared Club Lobby')).toBeTruthy();
    expect(screen.queryByText('Diamond Games Are Not Open For Play Yet.')).toBeNull();
  });

  it('keeps chip operator routes on the safe shell, never on the lobby', async () => {
    mocks.access.mockResolvedValue({ ...diamond, cashGamesEnabled: true });
    render(lobby('/clubs/diamond/finance'));
    await screen.findByText('You Are Already A Member.');
    expect(screen.queryByText('Shared Club Lobby')).toBeNull();
  });

  it('restores the closed-games notice when fresh entitlement revokes the gate', async () => {
    mocks.access
      .mockResolvedValueOnce({ ...diamond, cashGamesEnabled: true })
      .mockResolvedValueOnce(diamond);
    render(lobby('/clubs/diamond'));
    await screen.findByText('Shared Club Lobby');
    fireEvent.focus(window);
    await screen.findByText('Diamond Games Are Not Open For Play Yet.');
    expect(screen.getByText('Shared Club Lobby')).toBeTruthy();
  });
});

function CashierDraft() {
  const [amount, setAmount] = useState('');
  return (
    <input aria-label="Amount" value={amount} onChange={(event) => setAmount(event.target.value)} />
  );
}
const draftView = () => (
  <MemoryRouter initialEntries={['/clubs/chip/cashier-classic']}>
    <ArenaAccessBoundary clubKey="chip">
      <CashierDraft />
    </ArenaAccessBoundary>
  </MemoryRouter>
);
const authEvent = (event: string, id?: string) =>
  mocks.auth.mock.calls[0][0](event, id ? { user: { id } } : null);

describe('a slow or dropped re-check keeps the verified page (2026-10-24)', () => {
  it.each([
    [{ code: '57014', message: 'canceling statement due to statement timeout' }],
    [new TypeError('Failed to fetch')],
    [new Error('AbortError: signal is aborted without reason')],
  ])('keeps the cashier draft through a transient re-check failure: %s', async (error) => {
    mocks.access.mockResolvedValueOnce(chip).mockRejectedValueOnce(error);
    render(draftView());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), {
      target: { value: '1,500' },
    });
    await act(async () => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(2));
    expect((screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement).value).toBe(
      '1,500'
    );
    expect(screen.queryByText('Access Not Verified')).toBeNull();
  });

  it('still applies the next real answer after a kept page', async () => {
    mocks.access
      .mockResolvedValueOnce(chip)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ ...chip, member: false });
    render(view('chip'));
    await screen.findByText('Private Chip Lobby');
    await act(async () => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(mocks.access).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Private Chip Lobby')).toBeTruthy();
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(await screen.findByRole('button', { name: 'Join This Club' })).toBeTruthy();
    expect(screen.queryByText('Private Chip Lobby')).toBeNull();
  });

  it('removes private content on an unclassified service failure, as before', async () => {
    mocks.access
      .mockResolvedValueOnce(chip)
      .mockRejectedValueOnce(new Error('Unexpected database failure'));
    render(view('chip'));
    await screen.findByText('Private Chip Lobby');
    fireEvent.focus(window);
    await waitFor(() => expect(screen.queryByText('Private Chip Lobby')).toBeNull());
    expect(await screen.findByText('Unavailable', { selector: '.sc__pill *' })).toBeTruthy();
  });

  it('re-reads a transient first-read failure by itself, without a Retry tap', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.access
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(chip);
      render(view('chip'));
      expect(await screen.findByText('Connection', { selector: '.sc__pill *' })).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });
      expect(await screen.findByText('Private Chip Lobby')).toBeTruthy();
      expect(mocks.access).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not schedule a re-read for a sign-in failure', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mocks.access.mockRejectedValue({ code: '28000', message: 'Authentication Required' });
      render(view('chip'));
      await screen.findByText('Sign In', { selector: '.sc__pill *' });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(mocks.access).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Cashier draft and authenticated arena lifetime', () => {
  it('keeps the mounted amount through same-account sign-in and token refresh', async () => {
    mocks.access.mockResolvedValue(chip);
    render(draftView());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), {
      target: { value: '1,500' },
    });
    mocks.access.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => {
      authEvent('SIGNED_IN', 'account-a');
    });
    expect((screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement).value).toBe(
      '1,500'
    );
    await act(async () => {
      authEvent('TOKEN_REFRESHED', 'account-a');
    });
    expect((screen.getByRole('textbox', { name: 'Amount' }) as HTMLInputElement).value).toBe(
      '1,500'
    );
  });

  it('retires drafts on a different account, including a batched A to B to A', async () => {
    mocks.access.mockResolvedValue(chip);
    render(draftView());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), {
      target: { value: '1,500' },
    });
    await act(async () => {
      authEvent('SIGNED_IN', 'account-b');
      authEvent('SIGNED_IN', 'account-a');
    });
    expect(
      ((await screen.findByRole('textbox', { name: 'Amount' })) as HTMLInputElement).value
    ).toBe('');
  });

  it('removes the previous account immediately and rejects its late response', async () => {
    let finish!: (value: unknown) => void;
    mocks.access.mockResolvedValueOnce(chip);
    render(draftView());
    fireEvent.change(await screen.findByRole('textbox', { name: 'Amount' }), {
      target: { value: '1,500' },
    });
    mocks.access.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () => {
      authEvent('TOKEN_REFRESHED', 'account-a');
    });
    mocks.access.mockResolvedValueOnce({ ...chip, member: false });
    await act(async () => {
      authEvent('SIGNED_IN', 'account-b');
    });
    expect(screen.queryByRole('textbox', { name: 'Amount' })).toBeNull();
    await act(async () => {
      finish(chip);
    });
    expect(screen.queryByRole('textbox', { name: 'Amount' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Join This Club' })).toBeTruthy();
  });

  it('never restores an in-flight access response after sign-out', async () => {
    let finish!: (value: unknown) => void;
    mocks.access.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    render(draftView());
    await act(async () => {
      authEvent('SIGNED_OUT');
      finish(chip);
    });
    expect(screen.queryByRole('textbox', { name: 'Amount' })).toBeNull();
  });
});
