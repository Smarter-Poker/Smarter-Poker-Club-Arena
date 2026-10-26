import { expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { buildHost, formedHand, flush, playOut } =
  await import('../testing/lightningHostTestKit.js');
const { HAND_COMPLETION, handCompletionHoldMs } = await import('../config/handCompletionSpec.js');

it.each([
  { stacks: [20, 20], groups: 1, riverOnly: false },
  { stacks: [20, 20], groups: 1, riverOnly: true },
  { stacks: [10, 20, 30], groups: 2, riverOnly: false },
])(
  'keeps the Lightning all-in winner and $groups award group(s) through the shared hold before releasing rooms',
  async ({ stacks, groups, riverOnly }) => {
    let release: (() => void) | undefined;
    let held = 0;
    const t = buildHost(formedHand(stacks.length, 511 + stacks.length), stacks, {
      deps: {
        sleep: (ms) => {
          if (t.hub.frames.some((f) => f.payload.type === 'pot_win')) {
            held = ms;
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return Promise.resolve();
        },
      },
    });
    try {
      await t.host.start();
      await playOut(
        t.host,
        () => 0.9,
        (_id, legal) =>
          (!riverOnly || t.host.peekState()?.stage === 'river') &&
          (legal.includes('raise') || legal.includes('bet'))
            ? 'all_in'
            : legal.includes('call')
              ? 'call'
              : 'check'
      );
      await flush();
      expect(t.hub.frames.some((f) => f.payload.type === 'pot_win')).toBe(true);
      expect(held).toBe(
        handCompletionHoldMs({
          wentToShowdown: true,
          showdownHands: stacks.length,
          potAwardGroups: groups,
          allInShowdown: true,
        }) - HAND_COMPLETION.SHOWDOWN_READ_BASE_MS
      );
      expect(t.host.lifecycle).toBe('settling');
      expect(t.calls.settle).toHaveLength(0);
      expect(t.released).toHaveLength(0);
      expect(t.host.peekState()?.communityCards).toHaveLength(5);
      let drained = false;
      const draining = t.host.abort('shutdown_during_showdown').then(() => {
        drained = true;
      });
      await flush();
      expect(drained).toBe(false);
      release!();
      await draining;
      await t.host.whenFinished();
      expect(t.calls.settle).toHaveLength(1);
      expect(t.released).toHaveLength(stacks.length);
    } finally {
      release?.();
      await t.host.abort('test_cleanup');
    }
  }
);

it('does not impose an all-in hold on a fold win', async () => {
  const waits: number[] = [];
  const t = buildHost(formedHand(2, 512), [20, 20], {
    deps: {
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  });
  try {
    await t.host.start();
    await playOut(
      t.host,
      () => 0,
      () => 'fold'
    );
    await t.host.whenFinished();
    expect(t.calls.settle).toHaveLength(1);
    expect(waits).not.toContain(HAND_COMPLETION.ALL_IN_SHOWDOWN_EXTRA_MS);
    expect(waits).not.toContain(
      handCompletionHoldMs({ wentToShowdown: true, allInShowdown: true }) -
        HAND_COMPLETION.SHOWDOWN_READ_BASE_MS
    );
  } finally {
    await t.host.abort('test_cleanup');
  }
});

it('holds every Lightning showdown (not only all-in ones) for the physical end-of-hand hold before releasing anyone', async () => {
  // 2026-10-26: a showdown that is NOT all in used to settle and free its
  // players the moment the pot was paid, so a fast next deal cut off the
  // winner's pot push on the client (Animation Law). It now holds the same
  // handCompletionHoldMs the physical table holds.
  let release: (() => void) | undefined;
  let held: number | null = null;
  const t = buildHost(formedHand(2, 531), [100, 100], {
    deps: {
      sleep: (ms) => {
        if (t.hub.frames.some((f) => f.payload.type === 'pot_win') && held === null) {
          held = ms;
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve();
      },
    },
  });
  try {
    await t.host.start();
    // Check it down: nobody all in, two hands shown at the river.
    await playOut(
      t.host,
      () => 0.5,
      (_id, legal) => (legal.includes('check') ? 'check' : 'call')
    );
    await flush();
    expect(t.host.peekState()?.communityCards).toHaveLength(5);
    expect(t.hub.frames.some((f) => f.payload.type === 'pot_win')).toBe(true);
    expect(held).toBe(
      handCompletionHoldMs({
        wentToShowdown: true,
        showdownHands: 2,
        potAwardGroups: 1,
        allInShowdown: false,
      }) - HAND_COMPLETION.SHOWDOWN_READ_BASE_MS
    );
    // Held BEFORE settlement: nothing settled, nobody freed for a next deal.
    expect(t.host.lifecycle).toBe('settling');
    expect(t.calls.settle).toHaveLength(0);
    expect(t.released).toHaveLength(0);
    release!();
    await t.host.whenFinished();
    expect(t.calls.settle).toHaveLength(1);
    expect(t.released).toHaveLength(2);
  } finally {
    release?.();
    await t.host.abort('test_cleanup');
  }
});

it('a hand won without a showdown is still not held', async () => {
  const waits: number[] = [];
  const t = buildHost(formedHand(3, 532), [50, 50, 50], {
    deps: {
      sleep: async (ms) => {
        if (t.hub.frames.some((f) => f.payload.type === 'pot_win')) waits.push(ms);
      },
    },
  });
  try {
    await t.host.start();
    await playOut(
      t.host,
      () => 0,
      () => 'fold'
    );
    await t.host.whenFinished();
    expect(t.calls.settle).toHaveLength(1);
    // After the pot is paid on a fold win, the host sleeps for nothing at all.
    expect(waits).toEqual([]);
  } finally {
    await t.host.abort('test_cleanup');
  }
});
