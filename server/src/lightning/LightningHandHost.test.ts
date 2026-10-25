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
const { HorseLogic } = await import('../engine/HorseLogic.js');
const kit = await import('../testing/lightningHostTestKit.js');
const { lightningRequestId } = await import('./LightningHandHost.js');
const { LightningSeatProxy } = await import('./LightningSeatProxy.js');
const { buildHost, formedHand, flush, playOut, uid } = kit;

afterEach(() => {
  vi.useRealTimers();
});

describe('special fold intent belongs to its rendered hand', () => {
  for (const action of ['fast_fold', 'fold_watch']) {
    it(`${action} first delivery through the persistent room proxy cannot cross into the next hand`, async () => {
      const previous = formedHand(4, 6200);
      const old = buildHost(previous, [200, 200, 200, 200]);
      await old.host.start();
      await flush();
      const renderedIntent = `lightning-hand:${old.host.currentHandId}`;
      await playOut(old.host, mulberry32(6200));
      await flush();
      const next = buildHost(
        { ...previous, handId: uid(6299), instanceId: uid(6298) },
        [200, 200, 200, 200]
      );
      await next.host.start();
      await flush();
      const st = next.host.peekState()!;
      const actor = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
      const room = next.host.roomOf(actor.user_id)!;
      const proxy = new LightningSeatProxy(room, { hostForRoom: () => next.host } as any);
      expect(
        proxy.handlePlayerAction(actor.user_id, action, undefined, renderedIntent)
      ).toMatchObject({ success: false, code: 'STALE_ACTION' });
      expect(next.calls.fastFold).toEqual([]);
      expect(next.released).toEqual([]);
      expect(next.host.isWatching(actor.user_id)).toBe(true);
      expect(
        proxy.handlePlayerAction(
          actor.user_id,
          action,
          undefined,
          `lightning-hand:${next.host.currentHandId}`
        ).success
      ).toBe(true);
      await flush();
      expect(next.calls.fastFold).toHaveLength(1);
    });
    it(`${action} rejects first delivery from an older hand before any fold side effect`, async () => {
      const formed = formedHand(4, 6100);
      const t = buildHost(formed, [200, 200, 200, 200]);
      await t.host.start();
      await flush();
      const st = t.host.peekState()!;
      const actor = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
      const frames = t.hub.frames.length;
      for (const context of [undefined, null, `lightning-hand:${uid(610099)}`]) {
        expect(t.host.handlePlayerAction(actor.user_id, action, undefined, context)).toMatchObject({
          success: false,
          code: context == null ? 'ACTION_CONTEXT_REQUIRED' : 'STALE_ACTION',
        });
      }
      expect(t.calls.fastFold).toEqual([]);
      expect(t.released).toEqual([]);
      expect(t.hub.frames).toHaveLength(frames);
      expect(t.host.peekState()!.players.find((p) => p.user_id === actor.user_id)!.is_folded).toBe(
        false
      );
      expect(
        t.host.handlePlayerAction(
          actor.user_id,
          action,
          undefined,
          `lightning-hand:${formed.handId}`
        ).success
      ).toBe(true);
      const duplicate = t.host.handlePlayerAction(
        actor.user_id,
        action,
        undefined,
        `lightning-hand:${formed.handId}`
      );
      expect(duplicate.success).toBe(false);
      await flush();
      expect(t.calls.fastFold).toHaveLength(1);
    });
  }
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

/** The Daily Mission facts a settled Lightning hand carries (2026-10-19). */
function expectMissionFactsForEveryParticipant(
  settle: any,
  participants: Array<{ playerId: string }>
) {
  const events = settle.handRow.daily_mission_events as Array<any> | null;
  expect(Array.isArray(events)).toBe(true);
  expect(events!.map((e) => e.user_id).sort()).toEqual(participants.map((p) => p.playerId).sort());
  for (const e of events!) {
    expect(e.amounts.hands_played).toBe(1);
    const won = settle.results.find((r: any) => r.playerId === e.user_id)!.won;
    if (Math.floor(won) > 0) expect(e.amounts.hands_won).toBe(1);
    else expect(e.amounts.hands_won).toBeUndefined();
  }
}

describe('a Lightning hand is a hand: it carries its Daily Mission facts', () => {
  it('every participant dealt in, folded or not, gets the same facts a physical table records', async () => {
    for (let seed = 1; seed <= 20; seed++) {
      const rnd = mulberry32(seed);
      const n = 2 + (seed % 5);
      const formed = formedHand(n, 300 + seed * 10);
      const stacks = Array.from({ length: n }, () => 40 + Math.floor(rnd() * 300));
      const t = buildHost(formed, stacks);
      await t.host.start();
      await playOut(t.host, rnd);
      await flush();
      expect(t.calls.settle).toHaveLength(1);
      expectMissionFactsForEveryParticipant(t.calls.settle[0], t.participants);
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
  it.each([false, undefined])(
    'keeps original retry ownership when transport retryable is %s',
    async (retryable) => {
      const t = buildHost(formedHand(4, 2090), [200, 200, 200, 200]);
      await t.host.start();
      await flush();
      const fold = vi.mocked(t.backend.fastFold);
      fold.mockResolvedValue({
        ok: false,
        reason: 'original_outcome_unknown',
        transport: true,
        ...(retryable === false ? { retryable: false } : {}),
      });
      const state = t.host.peekState()!;
      const current = state.players.find((player) => player.seat === state.currentPlayerSeat)!;
      const waiting = state.players.find(
        (player) =>
          player.user_id !== current.user_id &&
          state.currentBet - player.bet > 0 &&
          !player.is_folded
      )!;
      expect(
        t.host.handlePlayerAction(
          waiting.user_id,
          'fast_fold',
          undefined,
          `lightning-hand:${t.host.currentHandId}`
        ).success
      ).toBe(true);
      await flush(40);
      expect(fold).toHaveBeenCalledTimes(retryable === false ? 1 : 3);
      expect(t.released).toEqual([]);
    }
  );
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
    const r = t.host.handlePlayerAction(
      waiting.user_id,
      'fast_fold',
      undefined,
      `lightning-hand:${t.host.currentHandId}`
    );
    expect(r.success).toBe(true);
    await flush();
    expect(t.calls.fastFold).toEqual([
      {
        playerId: waiting.user_id,
        requestId: lightningRequestId(formed.handId, `fold/${waiting.user_id}`),
        foldType: 'fast',
        // p_committed is ALWAYS sent: what the folder already put in the pot.
        committed: waiting.totalInvested,
      },
    ]);
    expect(t.released).toContainEqual({ playerId: waiting.user_id, why: 'fast' });
    expect(t.host.isWatching(waiting.user_id)).toBe(false);
    const framesAtFold = t.hub.inRoom(room).length;
    // The hand plays on without them; only its durable completion receipt
    // returns to their own pool room, never another hand/card/action frame.
    await playOut(t.host, mulberry32(7), (u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.host.lifecycle).toBe('complete');
    const afterFold = t.hub.inRoom(room).slice(framesAtFold);
    expect(afterFold).toHaveLength(1);
    expect(afterFold[0].payload).toMatchObject({
      type: 'hand_history_saved',
      table_id: room,
      pool_session_id: room,
      player_id: waiting.user_id,
      lightning_hand_id: formed.handId,
    });
    const saved = t.hub.frames.filter(
      (f) => f.kind === 'event' && f.payload.type === 'hand_history_saved'
    );
    expect(saved).toHaveLength(formed.players.length);
    for (const [i, playerId] of formed.players.entries()) {
      const ownRoom = uid(5000 + i);
      const receipts = saved.filter((f) => f.room === ownRoom);
      expect(receipts).toHaveLength(1);
      expect(receipts[0].payload).toEqual({
        type: 'hand_history_saved',
        table_id: ownRoom,
        pool_session_id: ownRoom,
        player_id: playerId,
        lightning_hand_id: formed.handId,
        hand_id: t.calls.postCommit[0],
        hand_number: t.calls.settle[0].handRow.hand_number,
        timestamp: expect.any(Number),
      });
    }
    const s = t.calls.settle[0];
    expect(s.results.find((x) => x.playerId === waiting.user_id)!.foldType).toBe('fast');
    expect(s.results.find((x) => x.playerId === waiting.user_id)!.won).toBe(0);
    const sum = s.results.reduce((a, x) => a + x.stackAfter, 0);
    expect(Math.round((sum + s.rake + s.bbj) * 100)).toBe(80000);
  });

  it('a free-check fold removes the BB immediately without stealing the turn or winning later', async () => {
    const formed = formedHand(3, 2100);
    const t = buildHost(formed, [100, 100, 100]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const bbSeat = t.participants.find((p) => p.playerId === formed.bb)!.seat;
    const bb = st.players.find((p) => p.seat === bbSeat)!;
    expect(st.currentPlayerSeat).not.toBe(bbSeat);
    expect(
      t.host.handlePlayerAction(
        bb.user_id,
        'fast_fold',
        undefined,
        `lightning-hand:${t.host.currentHandId}`
      ).success
    ).toBe(true);
    expect(t.host.peekState()!.players.find((p) => p.user_id === bb.user_id)!.is_folded).toBe(true);
    expect(t.host.peekState()!.currentPlayerSeat).toBe(st.currentPlayerSeat);
    await flush();
    expect(t.released).toContainEqual({ playerId: bb.user_id, why: 'fast' });
    await playOut(t.host, mulberry32(3), () => 'fold');
    await flush();
    const settled = t.calls.settle[0];
    expect(settled.results.find((p) => p.playerId === bb.user_id)!.won).toBe(0);
    expect(
      Math.round(
        (settled.results.reduce((sum, p) => sum + p.stackAfter, 0) + settled.rake + settled.bbj) *
          100
      )
    ).toBe(30000);
  });

  it('preselected auto_fold is final immediately, including with nothing owed', async () => {
    const formed = formedHand(3, 2150);
    const t = buildHost(formed, [100, 100, 100]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const actor = st.currentPlayerSeat;
    const bb = st.players.find((p) => p.user_id === formed.bb)!;
    expect(actor).not.toBe(bb.seat);
    expect(t.host.setPreAction(bb.user_id, 'auto_fold', undefined, 'old-hand').success).toBe(false);
    expect(t.host.setPreAction(bb.user_id, 'auto_fold', undefined, formed.handId).success).toBe(
      true
    );
    expect(t.host.peekState()!.players.find((p) => p.user_id === bb.user_id)!.is_folded).toBe(true);
    expect(t.host.peekState()!.currentPlayerSeat).toBe(actor);
    await flush();
    expect(t.released).toContainEqual({ playerId: bb.user_id, why: 'fast' });
    expect(t.host.setPreAction(bb.user_id, 'auto_fold', undefined, formed.handId).success).toBe(
      false
    );
    await playOut(t.host, mulberry32(3), () => 'fold');
    await flush();
    const result = t.calls.settle[0].results.find((p) => p.playerId === bb.user_id)!;
    expect(result.won).toBe(0);
    // The unmatched blind is returned by the original settlement, not
    // guessed/refunded when the player leaves for the next hand.
    expect(result.stackAfter).toBe(99);
  });

  it('legacy watch and explicit pre-fold still honor live feature pauses', async () => {
    const formed = formedHand(3, 2170);
    const flags = { fastFold: false, foldWatch: true };
    const t = buildHost(formed, [100, 100, 100], { deps: { foldFlags: () => flags } });
    await t.host.start();
    await flush();
    const bb = t.host.peekState()!.players.find((p) => p.user_id === formed.bb)!;
    const context = `lightning-hand:${formed.handId}`;
    expect(t.host.handlePlayerAction(bb.user_id, 'fold_watch', undefined, context)).toMatchObject({
      success: false,
      code: 'LIGHTNING_FOLD_DISABLED',
    });
    expect(t.host.setPreAction(bb.user_id, 'auto_fold', undefined, formed.handId)).toMatchObject({
      success: false,
      code: 'LIGHTNING_FOLD_DISABLED',
    });
    flags.fastFold = true;
    flags.foldWatch = false;
    expect(t.host.handlePlayerAction(bb.user_id, 'fold_watch', undefined, context)).toMatchObject({
      success: false,
      code: 'FOLD_WATCH_DISABLED',
    });
    expect(t.calls.fastFold).toEqual([]);
    expect(t.host.peekState()!.players.find((p) => p.user_id === bb.user_id)!.is_folded).toBe(
      false
    );
    await playOut(t.host, mulberry32(2170));
  });

  it('legacy fold_watch releases immediately through the fast-fold door', async () => {
    const formed = formedHand(3, 2200);
    const t = buildHost(formed, [150, 150, 150]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const current = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    const room = t.host.roomOf(current.user_id)!;
    expect(
      t.host.handlePlayerAction(
        current.user_id,
        'fold_watch',
        undefined,
        `lightning-hand:${t.host.currentHandId}`
      ).success
    ).toBe(true);
    await flush();
    expect(t.calls.fastFold[0]).toMatchObject({
      playerId: current.user_id,
      foldType: 'fast',
    });
    expect(t.released).toContainEqual({ playerId: current.user_id, why: 'fast' });
    expect(t.host.isWatching(current.user_id)).toBe(false);
    const before = t.hub.inRoom(room).length;
    await playOut(t.host, mulberry32(3), (u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    expect(t.hub.inRoom(room).length).toBeGreaterThan(before);
    expect(t.hub.inRoom(room).some((f) => f.payload.type === 'hand_complete')).toBe(false);
    expect(t.released.filter((x) => x.playerId === current.user_id)).toHaveLength(1);
    expect(t.calls.settle[0].results.find((x) => x.playerId === current.user_id)!.foldType).toBe(
      'fast'
    );
  });
});

describe('the clock, the time bank and a horse', () => {
  it.each([false, true])(
    'an early fold preserves the owed actor context and original clock (time bank %s)',
    async (bankActive) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
      });
      const formed = formedHand(3, 2270);
      const t = buildHost(formed, [100, 100, 100], { rules: { time_bank_enabled: bankActive } });
      await t.host.start();
      await flush();
      const actor = t.host.peekState()!.currentPlayerSeat;
      const current = t.host.peekState()!.players.find((p) => p.seat === actor)!;
      const room = t.host.roomOf(current.user_id)!;
      const turn = t.hub
        .inRoom(room)
        .filter((f) => f.payload.type === 'turn_change')
        .at(-1)!.payload;
      await vi.advanceTimersByTimeAsync(bankActive ? 15200 : 5000);
      expect(
        t.host.handlePlayerAction(
          formed.bb,
          'fast_fold',
          undefined,
          `lightning-hand:${formed.handId}`
        ).success
      ).toBe(true);
      await flush();
      const state = t.hub
        .inRoom(room)
        .filter((f) => f.payload.action_context)
        .at(-1)!.payload;
      expect(state.action_context).toBe(turn.action_context);
      expect(t.host.peekState()!.currentPlayerSeat).toBe(actor);
      expect(
        t.hub
          .inRoom(room)
          .filter((f) => f.payload.type === 'turn_change')
          .at(-1)!.payload
      ).toEqual(turn);
      await vi.advanceTimersByTimeAsync(bankActive ? 20500 : 10200);
      await flush();
      expect(
        t.host.peekState()!.players.find((p) => p.user_id === current.user_id)!.is_folded
      ).toBe(true);
      expect(t.calls.fastFold).toContainEqual(
        expect.objectContaining({ playerId: current.user_id, foldType: 'normal' })
      );
    }
  );

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

  /**
   * Pin a horse's tempo, keeping the real brain's action and amount. The live
   * tempo is a random mixture (V14): most answers land inside the clock, but
   * a "tank" deliberately runs into a usable bank, and a long hand runs well
   * past a minute. Left random, a test that asserts "no bank" or "done inside
   * 60 s" fails a few percent of the time (engine release 37021851186), so
   * each test below pins the tempo it is about.
   */
  function pinHorseTempo(
    t: ReturnType<typeof buildHost>,
    thinkTime: (decisionIndex: number) => number,
    staysIn: (decisionIndex: number) => boolean = () => false
  ): void {
    const brain = t.horseLane.raw.decideFast.getMockImplementation()!;
    let n = 0;
    t.horseLane.raw.decideFast.mockImplementation(async (...args: any[]) => {
      const r: any = await (brain as any)(...args);
      const snapshot = args[0];
      const onTurn = snapshot.player.seat === snapshot.gameState.currentPlayerSeat;
      const passive = snapshot.gameState.toCall > 0 ? 'call' : 'check';
      // An off-turn priced look has no action clock. It must not consume the
      // first TURN's tank, or randomly fast-fold the peer while that clock
      // is running. Fast-fold behavior has its own dedicated host tests.
      if (!onTurn) {
        return staysIn(0)
          ? { ...r, decision: { ...r.decision, action: passive, amount: undefined } }
          : r;
      }
      const i = n++;
      // Keep the clock under test alive with a legal passive action. A
      // random raise/all-in could otherwise price the peer into an early fold.
      const decision = staysIn(i)
        ? { ...r.decision, action: passive, amount: undefined }
        : r.decision;
      return { ...r, decision: { ...decision, thinkTime: thinkTime(i) } };
    });
  }

  /** Every voluntary action came through the horse's own decision, never the clock. */
  function everyActionWasTheHorses(t: ReturnType<typeof buildHost>): void {
    // Blinds are forced and an uncalled bet's return is the dealer's, not a seat's.
    const acted = (
      (t.host as any).actions as Array<{ origin?: string; historyEvent?: string }>
    ).filter((a) => a.origin !== 'forced' && !a.historyEvent);
    expect(acted.length).toBeGreaterThan(0);
    expect(acted.map((a) => a.origin)).toEqual(acted.map(() => 'horse_policy'));
  }

  /** Advance the fake clock a second at a time until the hand is done. */
  async function playHorsesOut(t: ReturnType<typeof buildHost>): Promise<void> {
    // A budget no legitimate hand can reach: every action is a few fake
    // seconds, and fake time costs nothing - the loop leaves when it is done.
    for (let i = 0; i < 1_800 && t.host.lifecycle === 'dealing'; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flush(4);
    }
  }

  it('a horse acts through the same clock and the same door, inside its deadline', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const formed = formedHand(2, 2400);
    const horses = new Set(formed.players);
    const t = buildHost(formed, [100, 100], { horses });
    // A considered beat on every decision: well inside the 15 s clock.
    pinHorseTempo(t, () => 4_000);
    await t.host.start();
    await playHorsesOut(t);
    expect(t.host.lifecycle).toBe('complete');
    expect(t.horseLane.calls.length).toBeGreaterThan(0);
    // No horse ever ran out its clock: no time bank was spent and nobody timed out.
    expect(t.hub.frames.some((f) => f.payload.type === 'TIME_BANK_ACTIVATED')).toBe(false);
    everyActionWasTheHorses(t);
    expect(t.calls.settle).toHaveLength(1);
    // A horse-only hand records its Daily Mission facts like any other hand.
    expectMissionFactsForEveryParticipant(t.calls.settle[0], t.participants);
  });

  it('a horse that tanks runs into its bank, not out of its clock, and still acts', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
    const formed = formedHand(2, 2450);
    const horses = new Set(formed.players);
    const t = buildHost(formed, [100, 100], { horses });
    // The first decision tanks (the brain's bank sentinel: clock + 2 s of bank),
    // every later one is a beat.
    // The tank stays in the hand: a fold would leave by the Lightning Fold
    // door before any think time, and the random brain folds it about half
    // the time.
    pinHorseTempo(
      t,
      (i) => (i === 0 ? HorseLogic.THINK_TIMEBANK_SENTINEL : 4_000),
      (i) => i === 0
    );
    await t.host.start();
    await playHorsesOut(t);
    expect(t.host.lifecycle).toBe('complete');
    const bank = t.hub.frames.filter((f) => f.payload.type === 'TIME_BANK_ACTIVATED');
    expect(bank.length).toBeGreaterThan(0);
    const tanker = bank[0].payload.playerId;
    // It acted inside the bank: the bank stopped on its action, never ran dry,
    // and the clock never folded it.
    expect(
      t.hub.frames.some(
        (f) => f.payload.type === 'TIME_BANK_STOPPED' && f.payload.playerId === tanker
      )
    ).toBe(true);
    expect(
      t.hub.frames.some(
        (f) => f.payload.type === 'TIME_BANK_EXPIRED' || f.payload.type === 'TIME_BANK_DEPLETED'
      )
    ).toBe(false);
    everyActionWasTheHorses(t);
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
    expect(t.hub.frames.filter((f) => f.payload.type === 'hand_history_saved')).toEqual([]);
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
    expect(t.hub.frames.filter((f) => f.payload.type === 'hand_history_saved')).toEqual([]);
  });
});

describe('the phase 6 contracts: frozen settlement, the room snapshot, pre-actions', () => {
  it('a settlement that froze the Cluster is terminal: never retried, never abandoned', async () => {
    const formed = formedHand(2, 3000);
    const frozen = vi.fn();
    const t = buildHost(formed, [100, 100], {
      settleScript: ['frozen'],
      deps: { onClusterFrozen: frozen },
    });
    await t.host.start();
    await playOut(t.host, mulberry32(14), (_u, legal) => (legal.includes('fold') ? 'fold' : null));
    await flush();
    expect(t.host.lifecycle).toBe('frozen');
    expect(t.calls.settle).toHaveLength(1);
    expect(t.calls.abandon).toEqual([]);
    expect(frozen).toHaveBeenCalledWith(formed.clusterId);
  });

  it('every room snapshot carries the hand id and the lightning block, with the fold rule per player', async () => {
    const formed = formedHand(3, 3100);
    const t = buildHost(formed, [100, 100, 100], { rules: { name: 'Lightning NLH 1/2' } });
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    for (const p of t.participants) {
      const snap = t.hub
        .inRoom(p.poolSessionId)
        .filter((f) => f.kind === 'publish')
        .at(-1)!.payload;
      expect(snap.hand_id).toBe(formed.handId);
      expect(snap.lightning).toEqual({
        hand_id: formed.handId,
        cluster_id: formed.clusterId,
        name: 'Lightning NLH 1/2',
        small_blind: 1,
        big_blind: 2,
        variant: 'nlh',
        // Every live, non-all-in player may explicitly fold now.
        fast_fold_available: true,
        // Lightning Phase 13: both controls offered while no flag says otherwise.
        fast_fold_enabled: true,
        fold_watch_enabled: true,
      });
      expect(JSON.stringify(snap)).not.toContain(formed.instanceId);
    }
  });

  it('an explicit fold pre-action requires its own hand and releases immediately', async () => {
    const formed = formedHand(3, 3200);
    const t = buildHost(formed, [100, 100, 100]);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const waiting = st.players.find(
      (p) => p.seat !== st.currentPlayerSeat && st.currentBet - p.bet > 0
    )!;
    expect(t.host.setPreAction(waiting.user_id, 'auto_fold', undefined, uid(1))).toMatchObject({
      success: false,
      code: 'STALE_HAND',
    });
    expect(
      t.host.setPreAction(waiting.user_id, 'auto_fold', undefined, formed.handId).success
    ).toBe(true);
    await playOut(t.host, mulberry32(15), (_u, legal) =>
      legal.includes('check') ? 'check' : 'call'
    );
    await flush();
    const folded = t.calls.settle[0].results.find((r) => r.playerId === waiting.user_id)!;
    expect(folded.foldType).toBe('fast');
    expect(t.calls.fastFold.find((f) => f.playerId === waiting.user_id)?.foldType).toBe('fast');
  });
});

describe('the idle room carries its own player’s balance (Dan 2026-10-24)', () => {
  /** Every idle frame names only its room's owner, never another player. */
  function balancesNameOnlyTheirOwner(t: ReturnType<typeof buildHost>) {
    let seen = 0;
    for (const f of t.hub.frames) {
      if (f.kind !== 'publish') continue;
      const balance = f.payload.lightning?.player_balance;
      if (!balance) continue;
      seen++;
      const owner = t.participants.find((p) => p.poolSessionId === f.room)!;
      expect(f.payload.stage).toBe('waiting');
      expect(balance.user_id).toBe(owner.playerId);
    }
    return seen;
  }

  it('a fold tells the folder’s room the chips behind them, and nobody else’s', async () => {
    const stacks = [180, 210, 240, 270];
    const t = buildHost(formedHand(4, 8800), stacks);
    await t.host.start();
    await flush();
    const st = t.host.peekState()!;
    const folder = st.players.find((p) => p.seat === st.currentPlayerSeat)!;
    const behind = folder.stack;
    const room = t.host.roomOf(folder.user_id)!;
    expect(
      t.host.handlePlayerAction(
        folder.user_id,
        'fast_fold',
        undefined,
        `lightning-hand:${t.host.currentHandId}`
      ).success
    ).toBe(true);
    await flush();
    const idle = t.hub
      .inRoom(room)
      .filter((f) => f.kind === 'publish')
      .at(-1)!.payload;
    expect(idle).toMatchObject({ stage: 'waiting', players: [], hand_id: null });
    expect(idle.lightning.player_balance).toEqual({ user_id: folder.user_id, stack: behind });
    expect(behind).toBeGreaterThan(0);
    // No other room was idled, so no other balance was sent anywhere.
    for (const p of t.participants) {
      if (p.playerId === folder.user_id) continue;
      expect(JSON.stringify(t.hub.inRoom(p.poolSessionId))).not.toContain('player_balance');
    }
    expect(balancesNameOnlyTheirOwner(t)).toBe(1);
  });

  it('every folder of a played-out hand is told only their own balance', async () => {
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = mulberry32(seed);
      const n = 2 + (seed % 5);
      const stacks = Array.from({ length: n }, () => 40 + Math.floor(rnd() * 300));
      const t = buildHost(formedHand(n, 8900 + seed * 10), stacks);
      await t.host.start();
      await playOut(t.host, rnd);
      await flush();
      balancesNameOnlyTheirOwner(t);
    }
  });

  it('an abandon tells each room its owner’s stack before the voided hand', async () => {
    const stacks = [100, 150, 175];
    const t = buildHost(formedHand(3, 8950), stacks);
    (t.backend.insertHoleCards as any).mockImplementation(async () => {
      throw new Error('insert_hole_cards failed');
    });
    await t.host.start();
    expect(t.host.lifecycle).toBe('abandoned');
    for (const p of t.participants) {
      const last = t.hub
        .inRoom(p.poolSessionId)
        .filter((f) => f.kind === 'publish')
        .at(-1)!.payload;
      expect(last.lightning.player_balance).toEqual({ user_id: p.playerId, stack: p.stackBefore });
    }
    expect(balancesNameOnlyTheirOwner(t)).toBe(3);
  });
});
