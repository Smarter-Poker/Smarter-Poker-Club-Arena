import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelHub } from '../hub/ChannelHub.js';
import { supabase } from '../services/supabase.js';
import type { GameServer } from '../GameServer.js';
import { ServerTableEngine } from '../engine/ServerTableEngine.js';
import { TournamentManagerBase } from './TournamentManagerBase.js';

class BarrierHarness extends TournamentManagerBase {
  constructor() {
    super('aaaaaaaa-0000-4000-8000-000000000001', {} as GameServer);
    (this as any).lifecycleEpoch.begin();
    this.running = true;
    this.handForHandActive = true;
    this.gameServer.getTournamentHandForHand = () => this.getHandForHandPresentation();
  }

  add(id: string, engine: ServerTableEngine): void {
    this.tableEngines.set(id, engine);
  }

  hold(kind: 'synchronized' | 'addon'): void {
    if (kind === 'synchronized') this.onBreak = true;
    else (this as any).addOnBreakActive = true;
  }

  ready(): void {
    this.startHandForHandSync();
  }
  edge(): void {
    (this as any).advanceHandForHandBarrier();
  }
  finishAddon(): Promise<void> {
    return (this as any).finishAddOnBreak();
  }
  retire(id: string): void {
    this.retireManagedTableFromHandForHand(id);
  }

  protected override async clearPersistedBreak(): Promise<void> {}
  protected override async broadcast(): Promise<boolean> {
    return true;
  }
  protected override startBlindTimer(): void {}
  protected override startEliminationChecker(): void {}
  protected override async recalculateEliminatedPrizes(): Promise<boolean> {
    return true;
  }
}

function table(id: string) {
  const engine = new ServerTableEngine(id);
  const state = engine as any;
  state.running = true;
  engine.pauseAfterHand(420_000, { beforeNextHand: true });
  const released = vi.fn();
  state.handForHandResolve = released;
  return { engine, state, released };
}

function field() {
  const manager = new BarrierHarness();
  const a = table('81818181-8181-4181-8181-818181818181');
  const b = table('82828282-8282-4282-8282-828282828282');
  manager.add('a', a.engine);
  manager.add('b', b.engine);
  return { manager, a, b };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('hand-for-hand respects tournament break ownership', () => {
  it.each(['synchronized', 'addon'] as const)(
    'cannot release a %s break when every table is parked',
    (kind) => {
      const { manager, a, b } = field();
      manager.hold(kind);
      manager.ready();
      manager.edge();
      expect(a.released).not.toHaveBeenCalled();
      expect(b.released).not.toHaveBeenCalled();
      expect(a.state.pauseMaxWaitMs).toBe(420_000);
      expect(a.engine.isWaitingForHandForHand()).toBe(true);
    }
  );

  it('cannot shorten a break that begins before the next-hand re-pause fires', () => {
    const { manager, a, b } = field();
    manager.ready();
    expect(a.released).toHaveBeenCalledOnce();
    manager.hold('synchronized');
    for (const entry of [a, b]) entry.engine.pauseAfterHand(420_000, { beforeNextHand: true });
    vi.advanceTimersByTime(500);
    expect(a.state.pauseMaxWaitMs).toBe(420_000);
    expect(b.state.pauseMaxWaitMs).toBe(420_000);
  });

  it('rechecks the parked barrier when the synchronized break ends, without another table event', async () => {
    const { manager, a, b } = field();
    manager.hold('synchronized');
    // Seed the roster without offering a completion edge during the break.
    (manager as any).handForHandTableIds = new Set(['a', 'b']);
    await manager.resumeFromBreak();
    expect(a.released).toHaveBeenCalledOnce();
    expect(b.released).toHaveBeenCalledOnce();
  });

  it('rechecks the parked barrier when the add-on break ends', async () => {
    const { manager, a, b } = field();
    manager.hold('addon');
    (manager as any).handForHandTableIds = new Set(['a', 'b']);
    await manager.finishAddon();
    expect(a.released).toHaveBeenCalledOnce();
    expect(b.released).toHaveBeenCalledOnce();
  });

  it('keeps an overlapping add-on break parked after the synchronized break ends', async () => {
    const { manager, a, b } = field();
    manager.hold('synchronized');
    manager.hold('addon');
    (manager as any).handForHandTableIds = new Set(['a', 'b']);
    await manager.resumeFromBreak();
    expect(a.released).not.toHaveBeenCalled();
    await manager.finishAddon();
    expect(a.released).toHaveBeenCalledOnce();
    expect(b.released).toHaveBeenCalledOnce();
  });

  it('releases an inherited add-on pause after hand-for-hand has ended', async () => {
    const { manager, a, b } = field();
    manager.hold('addon');
    (manager as any).handForHandActive = false;
    (manager as any).addOnBreakOwnsPause = false;
    await manager.finishAddon();
    expect(a.released).toHaveBeenCalledOnce();
    expect(b.released).toHaveBeenCalledOnce();
  });

  it('releases one barrier once despite duplicate edges and a late table retirement', () => {
    const { manager, a, b } = field();
    manager.ready();
    manager.edge();
    manager.retire('b');
    manager.edge();
    expect(a.released).toHaveBeenCalledOnce();
    expect(b.released).toHaveBeenCalledOnce();
  });

  it('does not advance until every authoritative table has parked', () => {
    const { manager, a, b } = field();
    b.state.handForHandResolve = null;
    manager.ready();
    expect(a.released).not.toHaveBeenCalled();
    b.state.handForHandResolve = b.released;
    manager.edge();
    expect(a.released).toHaveBeenCalledOnce();
    expect(b.released).toHaveBeenCalledOnce();
  });
});

describe('hand-for-hand public presentation remains an observation', () => {
  it('observes the actual manager state without changing barrier ownership', () => {
    const { manager, a, b } = field();
    expect(manager.getHandForHandPresentation()).toBe(true);
    (manager as any).handForHandActive = false;
    expect(manager.getHandForHandPresentation()).toBe(false);
    (manager as any).tournamentLeaseGeneration = 'expired';
    (manager as any).tournamentLeaseProofDeadlineMonotonicMs = -1;
    expect(manager.getHandForHandPresentation()).toBeNull();
    expect((manager as any).stopFenceApplied).toBe(false);
    expect(a.released).not.toHaveBeenCalled();
    expect(b.released).not.toHaveBeenCalled();
  });
  it('cannot prevent the existing stop fence when presentation transport throws', () => {
    const { manager } = field();
    vi.spyOn(channelHub, 'broadcastToTournament').mockImplementation(() => {
      throw new Error('display transport unavailable');
    });
    expect(() => (manager as any).applyStopFence()).not.toThrow();
    expect((manager as any).running).toBe(false);
    expect((manager as any).stopFenceApplied).toBe(true);
  });
  it('publishes actual transition state and unknown when the existing manager retires', async () => {
    const { manager } = field();
    const published = vi.spyOn(channelHub, 'broadcastToTournament');
    vi.spyOn(supabase, 'channel').mockReturnValue({
      httpSend: vi.fn().mockResolvedValue({ success: true }),
    } as any);
    const announce = (TournamentManagerBase.prototype as any).broadcast.bind(manager);
    await announce('hand_for_hand', { active: true });
    expect(published.mock.calls.at(-1)?.[1]).toMatchObject({
      event: { type: 'tournament_presentation', payload: { handForHand: true } },
    });
    (manager as any).handForHandActive = false;
    await announce('bubble_burst', {});
    expect(published.mock.calls.at(-1)?.[1]).toMatchObject({
      event: { payload: { handForHand: false } },
    });
    (manager as any).applyStopFence();
    expect(published.mock.calls.at(-1)?.[1]).toMatchObject({
      event: { payload: { handForHand: null } },
    });
    // The old manager may finish an awaited broadcast after its replacement
    // owns the slot. It may only publish that current manager's observation.
    (manager as any).gameServer.getTournamentHandForHand = () => true;
    await announce('bubble_burst', {});
    expect(published.mock.calls.at(-1)?.[1]).toMatchObject({
      event: { payload: { handForHand: true } },
    });
  });
});
