import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  use: vi.fn(),
  error: vi.fn(),
  allowance: vi.fn(),
  entitlement: undefined as undefined | ((event: any) => void),
}));
vi.mock('../../src/throwables/artwork', () => ({
  prepareThrowableArtwork: (...args: unknown[]) => state.prepare(...args),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: state.error }) }));
vi.mock('../../src/components/common/DiamondTopUpToast', () => ({ showDiamondTopUp: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({ haptic: { light: vi.fn() } }));
vi.mock('../../src/core/MasterBus', () => ({
  masterBus: {
    subscribe: (_type: string, listener: (event: any) => void) => {
      state.entitlement = listener;
      return () => {
        if (state.entitlement === listener) state.entitlement = undefined;
      };
    },
  },
}));
vi.mock('../../src/components/table/ThrowableImage', () => ({
  ThrowableImage: () => null,
  preloadThrowableImages: vi.fn(),
}));
vi.mock('../../src/services/ThrowableService', () => ({
  throwableService: {
    getThrowablesByCategory: () => ({
      premium: [{ id: 'beer', name: 'Beer' }],
      throws: [],
      sports: [],
      cheers: [],
      reactions: [],
    }),
    getThrowAllowance: (...args: unknown[]) => state.allowance(...args),
    useThrowable: (...args: unknown[]) => state.use(...args),
  },
}));
import { ThrowableSelector } from '../../src/components/table/ThrowableSelector';

beforeEach(() => {
  vi.clearAllMocks();
  state.use.mockResolvedValue({ success: true });
  state.allowance.mockReset().mockResolvedValue({ diamondCost: 1 });
});
afterEach(cleanup);
describe('artwork before consumption', () => {
  it('waits for artwork, blocks a second tap, then consumes exactly once', async () => {
    let ready!: () => void;
    state.prepare.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      })
    );
    const selected = vi.fn();
    const closed = vi.fn();
    const view = render(<ThrowableSelector userId="user" onSelect={selected} onClose={closed} />);
    const button = await view.findByTitle('Beer');
    fireEvent.click(button);
    fireEvent.click(button);
    expect(state.use).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toBeDisabled());
    await act(async () => {
      ready();
    });
    expect(state.use).toHaveBeenCalledExactlyOnceWith('user', 'beer');
    expect(selected).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });
  it('does not consume allowance or diamonds for unavailable artwork and offers a retry', async () => {
    state.prepare.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(undefined);
    const selected = vi.fn();
    const view = render(<ThrowableSelector userId="user" onSelect={selected} onClose={vi.fn()} />);
    const button = await view.findByTitle('Beer');
    fireEvent.click(button);
    await waitFor(() => expect(state.error).toHaveBeenCalledOnce());
    expect(state.use).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(state.use).toHaveBeenCalledOnce());
  });
  it('cancels the uncharged intent if the picker closes while artwork is loading', async () => {
    let ready!: () => void;
    state.prepare.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      })
    );
    const selected = vi.fn();
    const view = render(<ThrowableSelector userId="user" onSelect={selected} onClose={vi.fn()} />);
    fireEvent.click(await view.findByTitle('Beer'));
    view.unmount();
    await act(async () => {
      ready();
    });
    expect(state.use).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });
});

describe('allowance response ownership', () => {
  it('ignores a previous account response after switching users', async () => {
    let finishOld!: (value: unknown) => void;
    state.allowance
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOld = resolve;
        })
      )
      .mockResolvedValueOnce({ isVip: true, freeThrowsRemaining: 7, diamondCost: 0 });
    const callbacks = { onSelect: vi.fn(), onClose: vi.fn() };
    const view = render(<ThrowableSelector userId="old-user" {...callbacks} />);
    view.rerender(<ThrowableSelector userId="new-user" {...callbacks} />);
    expect(await view.findByText('7 Free')).toBeInTheDocument();
    await act(async () => finishOld({ isVip: true, unlimited: true }));
    expect(view.queryByText('Unlimited')).not.toBeInTheDocument();
    expect(view.getByText('7 Free')).toBeInTheDocument();
  });
  it('keeps the newest entitlement response when refreshes finish out of order', async () => {
    let finishOlder!: (value: unknown) => void;
    const view = render(<ThrowableSelector userId="user" onSelect={vi.fn()} onClose={vi.fn()} />);
    await view.findByTitle('Beer');
    state.allowance
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finishOlder = resolve;
        })
      )
      .mockResolvedValueOnce({ packThrowsRemaining: 12, diamondCost: 0 });
    act(() => state.entitlement?.({ payload: { userId: 'user', category: 'throwable' } }));
    act(() => state.entitlement?.({ payload: { userId: 'user', category: 'throwable' } }));
    expect(await view.findByText('12 Pack')).toBeInTheDocument();
    await act(async () => finishOlder({ packThrowsRemaining: 3, diamondCost: 0 }));
    expect(view.getByText('12 Pack')).toBeInTheDocument();
    expect(view.queryByText('3 Pack')).not.toBeInTheDocument();
  });
});
