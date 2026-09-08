import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ prepare: vi.fn(), use: vi.fn(), error: vi.fn() }));
vi.mock('../../src/throwables/artwork', () => ({
  prepareThrowableArtwork: (...args: unknown[]) => state.prepare(...args),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../src/components/common/Toast', () => ({ useToast: () => ({ error: state.error }) }));
vi.mock('../../src/components/common/DiamondTopUpToast', () => ({ showDiamondTopUp: vi.fn() }));
vi.mock('../../src/services/SoundService', () => ({ haptic: { light: vi.fn() } }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: { subscribe: () => () => {} } }));
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
    getThrowAllowance: async () => ({ diamondCost: 1 }),
    useThrowable: (...args: unknown[]) => state.use(...args),
  },
}));
import { ThrowableSelector } from '../../src/components/table/ThrowableSelector';

beforeEach(() => {
  vi.clearAllMocks();
  state.use.mockResolvedValue({ success: true });
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
