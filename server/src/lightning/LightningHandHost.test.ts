/**
 * LIGHTNING PHASE 6: the hand host deals a formed hand through HandController,
 * publishes through the shared presentation, moves money only through
 * settlement, and frees a folding player while the hand plays on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning host fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning host fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { lightningRequestId } = await import('./LightningHandHost.js');
const { buildHost, formedHand, flush, playOut, uid } = kit;

afterEach(() => {
  vi.useRealTimers();
});

function conserve(settle: any, stacks: number[]) {
  const before = stacks.reduce((a, b) => a + b, 0);
  const after = settle.results.reduce((a: number, r: any) => a + r.stackAfter, 0);
  expect(Math.round((after + settle.rake + settle.bbj) * 100)).toBe(Math.round(before * 100));
  for (const r of settle.results) {
    const i = settle.__stacks.get(r.playerId);
    expect(Math.round((i - r.contributed + r.won) * 100)).toBe(Math.round(r.stackAfter * 100));
  }
}

describe('a full Lightning hand, dealt by the host', () => {
  it('deals through HandController with the barrier blinds and button, then settles once, conserving chips', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = mulberry32(seed);
      const n = 2 + (seed % 5);
      const formed = formedHand(n, 100 + seed * 10);
      const stacks = Array.from({ length: n }, () => 40 + Math.floor(rnd() * 300));
      const t = buildHost(formed, stacks);
      await t.host.start();
      expect(t.host.lifecycle).toBe('dealing');
      // The barrier's blinds were posted from exactly its seats, the button is its 'btn'.
      const st = t.host.peekState()!;
      const btn = t.participants.find((p) => p.position === 'btn')!;
      expect(st.dealerSeat).toBe(btn.seat);
      const posts = st.actionHistory.length === 0 ? null : st.actionHistory;
      void posts;
      const sbSeat = t.participants.find((p) => p.playerId === formed.sb)!.seat;
      const bbSeat = t.participants.find((p) => p.playerId === formed.bb)!.seat;
      expect(st.players.find((p) => p.seat === bbSeat)!.bet).toBe(2);
      expect(st.players.find((p) => p.seat === sbSeat)!.bet).toBe(1);
      // Hole cards: written once, in one batch, under the HOST table and hand number.
      expect(t.calls.insertHoleCards).toHaveLength(1);
      expect(t.calls.insertHoleCards[0].table).toBe(kit.HOST_TABLE);
      await playOut(t.host, rnd);
      await flush();
      expect(t.host.lifecycle).toBe('complete');
      expect(t.calls.settle).toHaveLength(1);
      const s = t.calls.settle[0] as any;
      s.__stacks = new Map(t.participants.map((p) => [p.playerId, p.stackBefore]));
      conserve(s, stacks);
      expect(s.requestId).toBe(lightningRequestId(formed.handId, 'settle'));
      expect(s.hostTableId).toBe(kit.HOST_TABLE);
      expect(s.leaseGeneration).toBe(uid(4242));
      expect(s.results).toHaveLength(n);
      expect(s.handRow.players.every((p: any) => p.cards.length === 0)).toBe(true);
      expect(t.calls.postCommit).toEqual([uid(7777)]);
      expect(t.calls.abandon).toEqual([]);
      // Every frame names the player's ROOM, never the instance.
      for (const f of t.hub.frames) {
        expect(JSON.stringify(f.payload)).not.toContain(formed.instanceId);
        expect(t.participants.map((p) => p.poolSessionId)).toContain(f.room);
      }
    }
  });
});

describe('cards reach only their owners (property)', () => {
  it('no room ever receives another player’s hole cards unless they were tabled at showdown', async () => {
    let tabledSeenByOthers = 0;
    for (let seed = 100; seed < 160; seed++) {
      const rnd = mulberry32(seed);
      const n = 2 + (seed % 5);
      const formed = formedHand(n, 300 + seed * 10);
      const stacks = Array.from({ length: n }, () => 30 + Math.floor(rnd() * 200));
      const t = buildHost(formed, stacks);
      await t.host.start();
      const hole = new Map<string, Array<{ rank: string; suit: string }>>();
      for (const f of t.hub.frames) {
        if (f.kind === 'private' && f.payload.kind === 'hole_cards') {
          const owner = t.participants.find((p) => p.poolSessionId === f.room)!;
          // Private frames go to the room's owner, about the owner only.
          expect(f.userId).toBe(owner.playerId);
          expect(f.payload.row.user_id).toBe(owner.playerId);
          hole.set(owner.playerId, f.payload.row.cards);
        }
      }
      expect(hole.size).toBe(n);
      await playOut(t.host, rnd);
      await flush();
      const shown = new Set(
        ((t.host as any).showdown as Array<{ userId: string; mucked?: boolean }>)
          .filter((r) => !r.mucked)
          .map((r) => r.userId)
      );
      const folded = new Set(
        t.host
          .peekState()!
          .players.filter((p) => p.is_folded)
          .map((p) => p.user_id)
      );
      for (const f of t.hub.frames) {
        if (f.kind === 'private') continue;
        const owner = t.participants.find((p) => p.poolSessionId === f.room)!;
        const json = JSON.stringify(f.payload);
        for (const [pid, cards] of hole) {
          if (pid === owner.playerId) continue;
          if (shown.has(pid) && !folded.has(pid)) {
            if (json.includes(`{"rank":"${cards[0].rank}","suit":"${cards[0].suit}"}`))
              tabledSeenByOthers++;
            continue;
          }
          for (const c of cards) {
            expect(json, `room ${f.room} saw ${pid}'s card`).not.toContain(
              `{"rank":"${c.rank}","suit":"${c.suit}"}`
            );
          }
        }
      }
    }
    // Not vacuous: tabled hands DID reach the other rooms, in this exact card shape.
    expect(tabledSeenByOthers).toBeGreaterThan(0);
  });
});

describe('fast fold and fold & watch', () => {
  it('a fast fold before the turn frees the player while the others finish the hand', async () => {
    const formed = formedHand(4, 2000);
    const stacks = [200, 200, 200, 200];
    const t = buildHost(formed, stacks);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    // Somebody not on the clock who faces the big blind.
    const waiting = st.players.find(
      (p) => p.user_id !== current.user_id && st.currentBet - p.bet > 0 && !p.is_folded
    )!;
    const room = t.host.roomOf(waiting.user_id)!;
    const r = t.host.handlePlayerAction(waiting.user_id, 'fast_fold');
    expect(r.success).toBe(true);
    await flush();
    expect(t.calls.fastFold).toEqual([
      {
        playerId: waiting.user_id,
        requestId: lightningRequestId(formed.handId, `fold/${waiting.user_id}`),
        foldType: 'fast',
      },
    ]);
    expect(t.released).toContainEqual({ playerId: waiting.user_id, why: 'fast' });
    expect(t.host.isWatching(waiting.user_id)).toBe(false);
    const framesAtFold = t.hub.inRoom(room).length;
    // The hand plays on without them, and their room hears nothing more.
    await playOut(t.host, mulberry32(7), (u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    expect(t.hub.inRoom(room).length).toBe(framesAtFold);
    const s = t.calls.settle[0];
    expect(s.results.find((x) => x.playerId === waiting.user_id)!.foldType).toBe('fast');
    expect(s.results.find((x) => x.playerId === waiting.user_id)!.won).toBe(0);
    const sum = s.results.reduce((a, x) => a + x.stackAfter, 0);
    expect(Math.round((sum + s.rake + s.bbj) * 100)).toBe(80000);
  });

  it('a fold ahead of the turn is refused when nothing is owed (the folded hand could be left alone)', async () => {
    const formed = formedHand(3, 2100);
    const t = buildHost(formed, [100, 100, 100]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const bbSeat = t.participants.find((p) => p.playerId === formed.bb)!.seat;
    const bb = st.players.find((p) => p.seat === bbSeat)!;
    expect(st.currentPlayerSeat).not.toBe(bbSeat);
    expect(t.host.handlePlayerAction(bb.user_id, 'fast_fold').success).toBe(false);
    expect(t.calls.fastFold).toEqual([]);
  });

  it('fold & watch keeps the room receiving the hand and frees the player only when it ends', async () => {
    const formed = formedHand(3, 2200);
    const t = buildHost(formed, [150, 150, 150]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    const room = t.host.roomOf(current.user_id)!;
    expect(t.host.handlePlayerAction(current.user_id, 'fold_watch').success).toBe(true);
    await flush();
    expect(t.calls.fastFold[0]).toMatchObject({
      playerId: current.user_id,
      foldType: 'fold_watch',
    });
    expect(t.released.find((x) => x.playerId === current.user_id)).toBeUndefined();
    const before = t.hub.inRoom(room).length;
    await playOut(t.host, mulberry32(3), (u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.hub.inRoom(room).length).toBeGreaterThan(before);
    expect(t.hub.inRoom(room).some((f) => f.payload.type === 'hand_complete')).toBe(true);
    expect(t.released).toContainEqual({ playerId: current.user_id, why: 'hand_end' });
    expect(t.calls.settle[0].results.find((x) => x.playerId === current.user_id)!.foldType).toBe(
      'fold_watch'
    );
  });
});

describe('the clock, the time bank and a horse', () => {
  it('an idle player gets the clock, then a time bank, then is folded and freed', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const formed = formedHand(3, 2300);
    const t = buildHost(formed, [100, 100, 100], { deps: { sleep: () => Promise.resolve() } });
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    const room = t.host.roomOf(current.user_id)!;
    const turn = t.hub
      .inRoom(room)
      .filter((f) => f.payload.type === 'turn_change')
      .at(-1)!;
    expect(turn.payload.deadline_ms - turn.payload.timestamp).toBe(15_000);
    await vi.advanceTimersByTimeAsync(15_200);
    await flush();
    expect(t.hub.frames.some((f) => f.payload.type === 'TIME_BANK_ACTIVATED')).toBe(true);
    expect(t.host.peekState()!.players.find((p) => p.user_id === current.user_id)!.is_folded).toBe(
      false
    );
    await vi.advanceTimersByTimeAsync(20_500);
    await flush();
    const after = t.host.peekState()!.players.find((p) => p.user_id === current.user_id)!;
    expect(after.is_folded).toBe(true);
    expect(t.calls.fastFold[0]).toMatchObject({ playerId: current.user_id, foldType: 'normal' });
    expect(t.released).toContainEqual({ playerId: current.user_id, why: 'normal' });
  });

  it('a stale action context from another turn is refused', async () => {
    const formed = formedHand(3, 2350);
    const t = buildHost(formed, [100, 100, 100]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    expect(t.host.handlePlayerAction(current.user_id, 'call', undefined, 'stale').code).toBe(
      'STALE_ACTION'
    );
  });

  it('a horse acts through the same clock and the same door, inside its deadline', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const formed = formedHand(2, 2400);
    const horses = new Set(formed.players);
    const t = buildHost(formed, [100, 100], { horses });
    await t.host.start();
    for (let i = 0; i < 60 && t.host.lifecycle === 'dealing'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush(4);
    }
    expect(t.host.lifecycle).toBe('complete');
    // No horse ever ran out its clock: no time bank was spent and nobody timed out.
    expect(t.hub.frames.some((f) => f.payload.type === 'TIME_BANK_ACTIVATED')).toBe(false);
    expect(t.calls.settle).toHaveLength(1);
  });
});

describe('fencing and settlement', () => {
  it('losing the host table lease abandons the hand before any chip moves', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    let leased = true;
    const formed = formedHand(3, 2500);
    const t = buildHost(formed, [100, 100, 100], {
      lease: () => (leased ? { instance: 'i', generation: uid(4242) } : null),
    });
    await t.host.start();
    await flush();
    leased = false;
    await vi.advanceTimersByTimeAsync(5_100);
    await flush();
    expect(t.host.lifecycle).toBe('abandoned');
    expect(t.calls.abandon).toEqual(['host_lease_lost']);
    expect(t.calls.settle).toEqual([]);
    const last = t.hub.frames.filter((f) => f.kind === 'publish').at(-1)!;
    expect(last.payload.stage).toBe('waiting');
  });

  it('a hand that cannot be begun or bound is abandoned and deals nothing', async () => {
    const formed = formedHand(3, 2600);
    const t = buildHost(formed, [100, 100, 100], {
      participantsOverride: (ps) =>
        ps.map((p) => (p.position === 'btn' ? { ...p, position: 'utg' } : p)),
    });
    await t.host.start();
    expect(t.host.lifecycle).toBe('abandoned');
    expect(t.calls.abandon).toEqual(['formation_button_disagrees']);
    expect(t.hub.frames.filter((f) => f.kind === 'private')).toEqual([]);
  });

  it('settlement retries with ONE request id and settles once', async () => {
    const formed = formedHand(2, 2700);
    const t = buildHost(formed, [100, 100], { settleScript: ['transport', 'transport', 'ok'] });
    await t.host.start();
    await playOut(t.host, mulberry32(11), (_u, legal) => (legal.includes('fold') ? 'fold' : null));
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    expect(t.calls.settle).toHaveLength(3);
    expect(new Set(t.calls.settle.map((s) => s.requestId)).size).toBe(1);
    expect(t.calls.postCommit).toHaveLength(1);
    expect(t.calls.abandon).toEqual([]);
  });

  it('an outcome still unknown after the retries is never abandoned and never re-keyed', async () => {
    const formed = formedHand(2, 2800);
    const t = buildHost(formed, [100, 100], { settleScript: ['transport'] });
    await t.host.start();
    await playOut(t.host, mulberry32(12), (_u, legal) => (legal.includes('fold') ? 'fold' : null));
    await flush();
    expect(t.host.lifecycle).toBe('settlement_unknown');
    expect(t.calls.settle.length).toBe(5);
    expect(new Set(t.calls.settle.map((s) => s.requestId)).size).toBe(1);
    expect(t.calls.abandon).toEqual([]);
  });

  it('a definite settlement refusal voids the instance (nothing moved)', async () => {
    const formed = formedHand(2, 2900);
    const t = buildHost(formed, [100, 100], { settleScript: ['refuse'] });
    await t.host.start();
    await playOut(t.host, mulberry32(13), (_u, legal) => (legal.includes('fold') ? 'fold' : null));
    await flush();
    expect(t.host.lifecycle).toBe('abandoned');
    expect(t.calls.abandon).toEqual(['settlement_refused:lease_mismatch']);
  });
});
