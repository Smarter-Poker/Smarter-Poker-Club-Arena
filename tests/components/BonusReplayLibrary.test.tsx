import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import BonusReplayLibrary from '../../src/components/games/BonusReplayLibrary';
import type { BonusReplay, BonusReplaySummary } from '../../src/services/DiamondReplayService';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  share: vi.fn(),
  post: vi.fn(),
  copied: vi.fn(),
  toast: vi.fn(),
  report: vi.fn(),
  open: vi.fn(),
  appShare: vi.fn(),
  /** How many times the replay player's module has been evaluated. */
  playerLoads: 0,
}));
vi.mock('../../src/services/DiamondReplayService', async (original) => ({
  ...(await original<typeof import('../../src/services/DiamondReplayService')>()),
  DiamondReplayService: {
    list: mocks.list,
    read: mocks.read,
    share: mocks.share,
    post: mocks.post,
  },
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/lib/openExternal', () => ({ openInBrowser: mocks.open }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: mocks.report }));
vi.mock('../../src/components/common/Toast', () => ({
  useToast: () => ({ success: mocks.toast }),
}));
vi.mock('../../src/components/games/BonusReplayPlayer', () => {
  /* Counted, not just stubbed: the whole point of the split is that this
     module is not evaluated until a player asks to watch something. */
  mocks.playerLoads++;
  return {
    default: ({ replay }: { replay: BonusReplay }) => (
      <div data-testid="player">{replay.payout_chips} Confirmed</div>
    ),
  };
});
/** The count at the instant the library module finished evaluating: a static
 *  import of the player makes this 1 no matter which test runs first. */
const playerLoadsAtImport = mocks.playerLoads;

const clubA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clubB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const date = '2026-09-19T12:00:00.000Z';
const row = (index: number): BonusReplaySummary => ({
  id: `11111111-1111-4111-8111-${index.toString(16).padStart(12, '0')}`,
  game: 'crash',
  created_at: date,
  diamonds: 100,
  boost: index % 2 === 0 ? 2 : 1,
  payout_chips: index === 0 ? 0 : 1.23,
});
const replay: BonusReplay = {
  version: 1,
  completed_at: date,
  game: 'crash',
  diamonds: 100,
  boost: 2,
  payout_chips: 1.23,
  data: {
    status: 'cashed',
    growth_k: 0.12,
    cap_cents: 10000,
    elapsed_ms: 2000,
    cashout_cents: 127,
    crash_cents: 257,
    auto_cashout_cents: null,
  },
};
const link = {
  id: '22222222-2222-4222-8222-222222222222',
  url: 'https://smarter.poker/hub/club-arena/bonus-replay/22222222-2222-4222-8222-222222222222',
};
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const resolve = async <T,>(pending: ReturnType<typeof deferred<T>>, value: T) => {
  await act(async () => pending.resolve(value));
};
const click = async (name: string) => {
  await act(async () => fireEvent.click(screen.getByRole('button', { name, exact: true })));
};
const showReplay = async () => {
  render(<BonusReplayLibrary clubId={clubA} />);
  await screen.findByRole('button', { name: 'Replay', exact: true });
  await click('Replay');
};
const showShare = async () => {
  await showReplay();
  await click('Share This Replay');
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockReset().mockResolvedValue([row(1)]);
  mocks.read.mockReset().mockResolvedValue(replay);
  mocks.share.mockReset().mockResolvedValue(link);
  mocks.post.mockReset().mockResolvedValue('33333333-3333-4333-8333-333333333333');
  mocks.copied.mockReset().mockResolvedValue(undefined);
  mocks.appShare.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    'navigator',
    Object.create(navigator, {
      clipboard: { value: { writeText: mocks.copied } },
      share: { value: mocks.appShare },
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the replay player is not on the way to the list', () => {
  /**
   * This library is rendered by DiamondWheelPage, the page every round starts
   * on. A static import of BonusReplayPlayer put PlinkoBoard, CrashCurve and
   * ChoiceScene - and with them the whole three.js chunk, 511kB raw / 125kB
   * gzipped - on the wheel's first paint, for a component that renders only
   * after somebody picks a row.
   */
  it('does not evaluate the player module until a replay is selected', async () => {
    expect(playerLoadsAtImport).toBe(0);
    render(<BonusReplayLibrary clubId={clubA} />);
    await screen.findByRole('button', { name: 'Replay', exact: true });
    expect(mocks.playerLoads).toBe(0);
    await click('Replay');
    expect(await screen.findByTestId('player')).toBeInTheDocument();
    expect(mocks.playerLoads).toBe(1);
  });
});

describe('private bonus replay library', () => {
  it('loads exact normal/Super amounts without sharing or posting automatically', async () => {
    mocks.list.mockResolvedValue([row(0), row(1)]);
    render(<BonusReplayLibrary clubId={clubA} />);
    await screen.findByText('0.00 Chips');
    expect(screen.getByText('1.23 Chips')).toBeInTheDocument();
    expect(screen.getByText('Super Crash')).toBeInTheDocument();
    expect(screen.getByText('Diamond Crash')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith(clubA, undefined);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('rejects a previous club list and an old replay read after the club changes', async () => {
    const oldList = deferred<BonusReplaySummary[]>();
    mocks.list.mockReturnValueOnce(oldList.promise).mockResolvedValueOnce([row(2)]);
    const view = render(<BonusReplayLibrary clubId={clubA} />);
    view.rerender(<BonusReplayLibrary clubId={clubB} />);
    await screen.findByRole('button', { name: 'Replay', exact: true });
    await resolve(oldList, [row(1)]);
    expect(screen.getAllByRole('button', { name: 'Replay', exact: true })).toHaveLength(1);
    expect(screen.getByText('Super Crash')).toBeInTheDocument();
    const oldRead = deferred<BonusReplay>();
    mocks.read.mockReturnValueOnce(oldRead.promise);
    await click('Replay');
    view.rerender(<BonusReplayLibrary clubId={clubA} />);
    await resolve(oldRead, replay);
    expect(screen.queryByTestId('player')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back To Replays' })).not.toBeInTheDocument();
  });
  it('keeps both keyset cursor fields for 25-row pages and retries only the failed older page', async () => {
    const first = Array.from({ length: 25 }, (_, index) => row(index));
    mocks.list
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(new Error('History Unavailable'))
      .mockResolvedValueOnce([row(25)]);
    render(<BonusReplayLibrary clubId={clubA} />);
    await screen.findByRole('button', { name: 'Older Replays' });
    await click('Older Replays');
    expect(screen.getByRole('alert')).toHaveTextContent('History Unavailable');
    expect(screen.getAllByRole('button', { name: 'Replay', exact: true })).toHaveLength(25);
    await click('Try Again');
    expect(mocks.list).toHaveBeenNthCalledWith(2, clubA, first[24]);
    expect(mocks.list).toHaveBeenNthCalledWith(3, clubA, first[24]);
    expect(screen.getAllByRole('button', { name: 'Replay', exact: true })).toHaveLength(26);
    expect(screen.queryByRole('button', { name: 'Older Replays' })).not.toBeInTheDocument();
  });
  it('offers an initial-load retry and a meaningful empty state', async () => {
    mocks.list.mockRejectedValueOnce(new Error('Connection Lost')).mockResolvedValueOnce([]);
    render(<BonusReplayLibrary clubId={clubA} />);
    await screen.findByRole('alert');
    await click('Try Again');
    expect(
      screen.getByText('Finish A Bonus Game To Watch And Share Its Replay Here.')
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('does not attach a share that finishes after Back To Replays', async () => {
    const pending = deferred<typeof link>();
    mocks.share.mockReturnValueOnce(pending.promise);
    await showReplay();
    await click('Share This Replay');
    await click('Back To Replays');
    await resolve(pending, link);
    expect(screen.queryByRole('textbox', { name: 'Replay Link' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay', exact: true })).toBeEnabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('posts only on the explicit social action and keeps repeated clicks to one request', async () => {
    await showShare();
    expect(mocks.share).toHaveBeenCalledExactlyOnceWith(row(1).id);
    expect(mocks.post).not.toHaveBeenCalled();
    const pending = deferred<string>();
    mocks.post.mockReturnValueOnce(pending.promise);
    const post = screen.getByRole('button', { name: 'Share To My Smarter.Poker Page' });
    act(() => {
      fireEvent.click(post);
      fireEvent.click(post);
    });
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(link.id);
    await resolve(pending, '33333333-3333-4333-8333-333333333333');
    expect(screen.getByRole('button', { name: 'Shared To Smarter.Poker' })).toBeDisabled();
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('Replay Shared To Your Smarter.Poker Page');
  });
  it('copies only once while pending and discards success after leaving that replay', async () => {
    await showShare();
    const pending = deferred<void>();
    mocks.copied.mockReturnValueOnce(pending.promise);
    const copy = screen.getByRole('button', { name: 'Copy Link' });
    act(() => {
      fireEvent.click(copy);
      fireEvent.click(copy);
    });
    expect(mocks.copied).toHaveBeenCalledExactlyOnceWith(link.url);
    expect(copy).toBeDisabled();
    await click('Back To Replays');
    await resolve(pending, undefined);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('keeps a selectable exact link when the Clipboard API is unavailable', async () => {
    vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: undefined } }));
    await showShare();
    await click('Copy Link');
    expect(screen.getByRole('alert')).toHaveTextContent('Select The Replay Link To Copy It');
    const input = screen.getByRole('textbox', { name: 'Replay Link' }) as HTMLInputElement;
    expect(input).toHaveValue(link.url);
    fireEvent.focus(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(link.url.length);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
  it('retains failed-share errors for retry without social publication', async () => {
    mocks.share.mockRejectedValueOnce(new Error('Share Unavailable')).mockResolvedValueOnce(link);
    await showReplay();
    await click('Share This Replay');
    expect(screen.getByRole('alert')).toHaveTextContent('Share Unavailable');
    await click('Share This Replay');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Replay Link' })).toHaveValue(link.url);
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('does not report stale post errors after unmount', async () => {
    const pending = deferred<string>();
    mocks.post.mockReturnValueOnce(pending.promise);
    await showShare();
    await click('Share To My Smarter.Poker Page');
    cleanup();
    await act(async () => pending.reject(new Error('Old Post Unavailable')));
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it('treats cancelling a native share as cancellation and opens external share intents only after a click', async () => {
    mocks.appShare.mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError'));
    await showShare();
    expect(mocks.open).not.toHaveBeenCalled();
    await click('Share To An App');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await click('X');
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(
      `https://twitter.com/intent/tweet?text=Super%20Crash&url=${encodeURIComponent(link.url)}`
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
