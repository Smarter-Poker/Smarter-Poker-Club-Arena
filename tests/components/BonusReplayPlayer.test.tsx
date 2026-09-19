import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { BonusReplay } from '../../src/services/DiamondReplayService';
import BonusReplayPlayer from '../../src/components/games/BonusReplayPlayer';

type CrashProps = ComponentProps<typeof import('../../src/components/crash/CrashCurve').default>;
type ChoiceProps = ComponentProps<typeof import('../../src/components/games/ChoiceScene').default>;
type PlinkoProps = ComponentProps<typeof import('../../src/components/plinko/PlinkoBoard').default>;
const scenes = vi.hoisted(() => ({
  crash: null as CrashProps | null,
  choice: null as ChoiceProps | null,
  plinko: null as PlinkoProps | null,
  rpc: vi.fn(),
}));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: scenes.rpc } }));
vi.mock('../../src/components/crash/CrashCurve', () => ({
  default: (p: CrashProps) => {
    scenes.crash = p;
    return <div data-testid="crash" data-phase={p.phase} />;
  },
}));
vi.mock('../../src/components/games/ChoiceScene', () => ({
  default: (p: ChoiceProps) => {
    scenes.choice = p;
    return <div data-testid="choice" data-phase={p.phase} />;
  },
}));
vi.mock('../../src/components/plinko/PlinkoBoard', () => ({
  default: (p: PlinkoProps) => {
    scenes.plinko = p;
    return <div data-testid="plinko" />;
  },
}));

const base = {
  version: 1 as const,
  completed_at: '2026-09-19T12:00:00Z',
  diamonds: 100,
  boost: 1,
  payout_chips: 1.23,
};
const crash: BonusReplay = {
  ...base,
  game: 'crash',
  data: {
    status: 'cashed',
    elapsed_ms: 2000,
    growth_k: 0.12,
    cap_cents: 10000,
    cashout_cents: 127,
    crash_cents: 257,
    auto_cashout_cents: null,
  },
};
const choice = (
  game: 'mines' | 'crossing'
): Extract<BonusReplay, { game: 'mines' | 'crossing' }> => ({
  ...base,
  game,
  data: {
    status: 'lost',
    mode: game === 'mines' ? '5' : 'steady',
    picked: [0, 1],
    prizes: [1.1, 1.3],
    mine_cells: game === 'mines' ? [1, 2, 3, 4, 5] : [],
    road_end: game === 'crossing' ? 1 : null,
  },
});
const plinko: BonusReplay = {
  ...base,
  game: 'plinko',
  data: {
    multipliers_cents: Array(17).fill(100),
    diamonds_per_drop: 100,
    table_name: 'Lower Risk',
    drops: [{ index: 0, path_bits: 7, slot: 3, multiplier_cents: 100, payout_chips: 1.23 }],
  },
};
let now = 0,
  nextId = 0;
let frames = new Map<number, FrameRequestCallback>();
const step = (ms: number) =>
  act(() => {
    now += ms;
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(now));
  });
beforeEach(() => {
  now = 0;
  nextId = 0;
  frames = new Map();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('immutable bonus replay playback', () => {
  it.each([crash, plinko, choice('mines'), choice('crossing')])(
    'waits for Watch Replay for $game, including Super receipts',
    (replay) => {
      const view = render(<BonusReplayPlayer replay={{ ...replay, boost: 2 }} />);
      expect(screen.getByRole('heading')).toHaveTextContent('Super');
      expect(screen.getByRole('button', { name: 'Watch Replay' })).toBeEnabled();
      expect(screen.queryByText('Prize Awarded: 1.23 Chips')).not.toBeInTheDocument();
      if (replay.game === 'plinko') expect(scenes.plinko?.batchPathBits).toBeNull();
      else
        expect(replay.game === 'crash' ? scenes.crash?.phase : scenes.choice?.phase).toBe('idle');
      expect(scenes.rpc).not.toHaveBeenCalled();
      view.unmount();
      expect(frames.size).toBe(0);
    }
  );
  it.each([1, 2])(
    'retains the exact Crash ending with boost %s and waits for the submitted counterfactual reveal before completion',
    (boost) => {
      render(<BonusReplayPlayer replay={{ ...crash, boost }} />);
      fireEvent.click(screen.getByRole('button', { name: 'Watch Replay' }));
      step(1000);
      expect(scenes.crash?.replayElapsedMs).toBe(1000);
      expect(scenes.crash?.phase).toBe('open');
      step(1000);
      expect(scenes.crash?.phase).toBe('cashed');
      expect(scenes.crash?.cashoutCents).toBe(127);
      expect(scenes.crash?.crashCents).toBe(257);
      expect(screen.getByRole('button', { name: 'Playing Replay' })).toBeDisabled();
      expect(screen.queryByText('Prize Awarded: 1.23 Chips')).not.toBeInTheDocument();
      act(() => scenes.crash?.onSettled?.());
      expect(screen.getByText('Prize Awarded: 1.23 Chips')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Watch Again' })).toBeEnabled();
      expect(scenes.rpc).not.toHaveBeenCalled();
    }
  );
  it.each(['mines', 'crossing'] as const)(
    'plays %s choices in order and keeps the terminal reveal visible until rendering completes',
    (game) => {
      render(<BonusReplayPlayer replay={choice(game)} />);
      fireEvent.click(screen.getByRole('button', { name: 'Watch Replay' }));
      step(1500);
      expect(scenes.choice?.picked).toEqual([0]);
      expect(scenes.choice?.phase).toBe('open');
      step(1500);
      expect(scenes.choice?.picked).toEqual([0, 1]);
      expect(scenes.choice?.phase).toBe('lost');
      expect(scenes.choice?.mines).toEqual(choice(game).data.mine_cells);
      expect(scenes.choice?.roadEnd).toBe(choice(game).data.road_end);
      expect(screen.queryByText('Prize Awarded: 1.23 Chips')).not.toBeInTheDocument();
      act(() => scenes.choice?.onSettled?.());
      expect(screen.getByRole('button', { name: 'Watch Again' })).toBeEnabled();
      expect(screen.getByText('Prize Awarded: 1.23 Chips')).toBeInTheDocument();
    }
  );
  it('does not consume replay time while hidden, including repeated hidden notifications', () => {
    const hidden = vi.spyOn(document, 'hidden', 'get');
    hidden.mockReturnValue(false);
    render(<BonusReplayPlayer replay={crash} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch Replay' }));
    step(500);
    hidden.mockReturnValue(true);
    fireEvent(document, new Event('visibilitychange'));
    step(10000);
    fireEvent(document, new Event('visibilitychange'));
    step(10000);
    hidden.mockReturnValue(false);
    fireEvent(document, new Event('visibilitychange'));
    step(500);
    expect(scenes.crash?.replayElapsedMs).toBe(1000);
    expect(scenes.crash?.phase).toBe('open');
  });
  it('ends a late recovered Crash at its sealed crash instead of replaying the acknowledgment delay', () => {
    render(
      <BonusReplayPlayer
        replay={{
          ...crash,
          payout_chips: 0,
          data: {
            ...crash.data,
            status: 'crashed',
            cashout_cents: null,
            crash_cents: 110,
            elapsed_ms: 172800000,
          },
        }}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Watch Replay' }));
    step(800);
    expect(scenes.crash?.phase).toBe('crashed');
    expect(scenes.crash?.finalCents).toBe(110);
    expect(screen.queryByText('Prize Awarded: 0.00 Chips')).not.toBeInTheDocument();
    act(() => scenes.crash?.onSettled?.());
    expect(screen.getByText('Prize Awarded: 0.00 Chips')).toBeInTheDocument();
  });
  it.each(['mines', 'crossing'] as const)(
    'keeps the recorded %s cashout and counterfactual reveal before completing',
    (game) => {
      const saved = choice(game);
      const replay: BonusReplay = {
        ...saved,
        boost: 2,
        payout_chips: 17.37,
        data: {
          ...saved.data,
          status: 'cashed',
          picked: [0],
          road_end: game === 'crossing' ? 2 : null,
        },
      };
      render(<BonusReplayPlayer replay={replay} />);
      fireEvent.click(screen.getByRole('button', { name: 'Watch Replay' }));
      step(1500);
      expect(scenes.choice?.phase).toBe('cashed');
      expect(scenes.choice?.picked).toEqual([0]);
      expect(scenes.choice?.mines).toEqual(saved.data.mine_cells);
      expect(scenes.choice?.roadEnd).toBe(game === 'crossing' ? 2 : null);
      expect(screen.queryByText('Prize Awarded: 17.37 Chips')).not.toBeInTheDocument();
      act(() => scenes.choice?.onSettled?.());
      expect(screen.getByText('Prize Awarded: 17.37 Chips')).toBeInTheDocument();
    }
  );
  it.each([1, 2])(
    'replays saved Plinko paths with boost %s, ignores idle/stale completion, and clears the previous prize on Watch Again',
    (boost) => {
      render(<BonusReplayPlayer replay={{ ...plinko, boost }} />);
      act(() => scenes.plinko?.onLanded?.());
      expect(screen.queryByText('Prize Awarded: 1.23 Chips')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Watch Replay' }));
      const previousFinish = scenes.plinko!.onLanded!;
      expect(scenes.plinko?.batchPathBits).toEqual([7]);
      act(() => {
        scenes.plinko?.onProgress?.(1);
        scenes.plinko?.onLanded?.();
      });
      expect(screen.getByRole('status')).toHaveTextContent('1 / 1 Drops');
      fireEvent.click(screen.getByRole('button', { name: 'Watch Again' }));
      act(() => previousFinish());
      expect(screen.getByRole('button', { name: 'Playing Replay' })).toBeDisabled();
      expect(screen.queryByText('Prize Awarded: 1.23 Chips')).not.toBeInTheDocument();
    }
  );
});
