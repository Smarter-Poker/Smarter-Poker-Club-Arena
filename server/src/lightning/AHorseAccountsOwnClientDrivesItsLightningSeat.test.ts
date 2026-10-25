/**
 * A HORSE ACCOUNT'S OWN CLIENT DRIVES ITS LIGHTNING SEAT (2026-10-22).
 *
 * Lightning pilot witnesses play pilot horse accounts through the ordinary
 * client. While that client controls the seat (a live socket in its own room
 * plus a client claim), the hand host keeps the brain off the seat's turns:
 * the human clock, then the time bank, then the ordinary timeout. When the
 * client's last socket closes the brain takes the turn back.
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
const kit = await import('../testing/lightningHostTestKit.js');
const { LightningRegistry } = await import('./LightningRegistry.js');
const { LightningSeatProxy } = await import('./LightningSeatProxy.js');
const { playerActionContext } = await import('../engine/PlayerActionContext.js');
const { buildHost, formedHand, flush, uid } = kit;

const hosts: any[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.abort('test_complete').catch(() => undefined);
  vi.useRealTimers();
});

function fake() {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
}

async function horseHand(base: number, controlled: Set<string>) {
  const formed = formedHand(3, base);
  const t = buildHost(formed, [100, 100, 100], {
    horses: new Set(formed.players),
    deps: {
      sleep: () => Promise.resolve(),
      isClientControlling: (playerId: string) => controlled.has(playerId),
    },
  });
  hosts.push(t.host);
  // These tests own the turn clock, not the policy's cards: a horse that is
  // already folding folds at once through the Lightning Fold door (Dan
  // 2026-10-24), which would end the turn under test before it starts. So the
  // brain's answer here never folds; it calls or checks instead.
  const brain = t.horseLane.raw.decideFast.getMockImplementation()!;
  t.horseLane.raw.decideFast.mockImplementation(async (snapshot: any) => {
    const result = await brain(snapshot);
    if (result.decision.action !== 'fold') return result;
    const action = snapshot.gameState.toCall > 0 ? 'call' : 'check';
    return { ...result, decision: { ...result.decision, action, amount: undefined } };
  });
  await t.host.start();
  await flush();
  const h = t.host as any;
  const user = h.turnUser as string;
  expect(user).toBeTruthy();
  return { ...t, h, user, formed };
}

/** The lane requests made for one player (early looks included). */
const callsFor = (
  t: { horseLane: { calls: Array<{ player: { user_id: string } }> } },
  user: string
) => t.horseLane.calls.filter((c) => c.player.user_id === user).length;

const timeBankFrames = (t: Awaited<ReturnType<typeof horseHand>>, user: string) =>
  // One frame per room shown the hand; the player's own room is enough.
  t.hub
    .inRoom(t.host.roomOf(user)!)
    .filter((f) => f.payload.type === 'TIME_BANK_ACTIVATED' && f.payload.playerId === user);

const brainActed = (t: Awaited<ReturnType<typeof horseHand>>, user: string) =>
  (t.h.actions as Array<{ userId?: string; origin?: string }>).filter(
    (a) => a.userId === user && a.origin === 'horse_policy'
  ).length;

describe('a horse account driven by its own client plays on the human clock (Lightning)', () => {
  it('the brain never acts; the clock runs out into the time bank; the client action lands', async () => {
    fake();
    const controlled = new Set<string>();
    const formed = formedHand(3, 3100);
    formed.players.forEach((p) => controlled.add(p));
    const t = await horseHand(3100, controlled);
    // Fifteen seconds of action clock: no brain request, no action.
    await vi.advanceTimersByTimeAsync(14_000);
    await flush();
    expect(t.horseLane.calls.length).toBe(0);
    expect(t.h.turnUser).toBe(t.user);
    expect(brainActed(t, t.user)).toBe(0);
    // The clock expires into the time bank, as for any player.
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(timeBankFrames(t, t.user).length).toBe(1);
    expect(t.h.timeBankActive).toBe(true);
    expect(t.horseLane.calls.length).toBe(0);
    // The client's own action is accepted through the room's door.
    const legal = t.h.hc.getAuthoritativeActionState(t.user).legalActions as string[];
    const r = t.host.handlePlayerAction(
      t.user,
      legal.includes('call') ? 'call' : 'check',
      undefined,
      playerActionContext(t.h.hc)
    );
    expect(r.success).toBe(true);
    expect(t.h.turnUser).not.toBe(t.user);
  });

  it('the client decision is announced like any player, and a timeout folds through the ordinary path', async () => {
    fake();
    const controlled = new Set<string>();
    formedHand(3, 3150).players.forEach((p) => controlled.add(p));
    const decisions: string[] = [];
    const formed = formedHand(3, 3150);
    const t = buildHost(formed, [100, 100, 100], {
      horses: new Set(formed.players),
      deps: {
        sleep: () => Promise.resolve(),
        isClientControlling: (p: string) => controlled.has(p),
        onDecision: (p: string, d: unknown) => {
          if (d) decisions.push(p);
        },
      },
    });
    hosts.push(t.host);
    await t.host.start();
    await flush();
    const user = (t.host as any).turnUser as string;
    expect(decisions).toContain(user);
    await vi.advanceTimersByTimeAsync(15_500 + 20_500);
    await flush();
    const me = t.host.peekState()!.players.find((p) => p.user_id === user)!;
    expect(me.is_folded).toBe(true);
    expect(t.horseLane.calls.length).toBe(0);
  });

  it('a horse with no client acts on its own, inside the clock, with no time bank', async () => {
    fake();
    const t = await horseHand(3200, new Set());
    await vi.advanceTimersByTimeAsync(14_000);
    await flush();
    expect(t.horseLane.calls.length).toBeGreaterThan(0);
    expect(brainActed(t, t.user)).toBeGreaterThan(0);
    expect(timeBankFrames(t, t.user).length).toBe(0);
  });

  it('the client disconnecting hands the current turn back to the brain', async () => {
    fake();
    const controlled = new Set<string>();
    formedHand(3, 3300).players.forEach((p) => controlled.add(p));
    const t = await horseHand(3300, controlled);
    // This test owns the handoff, not the policy's randomized thinking rhythm.
    // Keep the real policy action while choosing a known in-clock delay for
    // the decision requested after the client releases its seat.
    const decide = t.horseLane.raw.decideFast.getMockImplementation()!;
    t.horseLane.raw.decideFast.mockImplementationOnce(async (snapshot) => {
      const result = await decide(snapshot);
      return { ...result, decision: { ...result.decision, thinkTime: 1_000 } };
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(t.horseLane.calls.length).toBe(0);
    controlled.delete(t.user);
    t.host.noteClientReleased(t.user);
    await vi.advanceTimersByTimeAsync(9_500);
    await flush();
    expect(t.horseLane.calls.length).toBeGreaterThan(0);
    expect(brainActed(t, t.user)).toBeGreaterThan(0);
    expect(timeBankFrames(t, t.user).length).toBe(0);
  });

  it('a client claim mid-turn stops the brain decision already in flight', async () => {
    fake();
    const controlled = new Set<string>();
    const t = await horseHand(3400, controlled);
    // The brain was asked and its answer is waiting out its think time.
    expect(callsFor(t, t.user)).toBe(1);
    controlled.add(t.user);
    t.host.noteClientControl(t.user);
    await vi.advanceTimersByTimeAsync(14_000);
    await flush();
    expect(t.h.turnUser).toBe(t.user);
    await vi.advanceTimersByTimeAsync(1_500);
    await flush();
    expect(timeBankFrames(t, t.user).length).toBe(1);
    expect(brainActed(t, t.user)).toBe(0);
  });
});

describe('the registry defines control: a live socket in the own room plus a client claim', () => {
  function registry() {
    const reg = new LightningRegistry({}) as any;
    const room = uid(8100);
    const owner = uid(8101);
    reg.rooms.set(room, { userId: owner, clusterId: null, sockets: 0 });
    return { reg, room, owner };
  }

  it('a socket alone is not control, and a claim alone is not control', () => {
    const a = registry();
    a.reg.connect(a.room, a.owner);
    expect(a.reg.isClientControlling(a.owner, a.room)).toBe(false);
    const b = registry();
    b.reg.noteClientClaim(b.room, b.owner);
    expect(b.reg.isClientControlling(b.owner, b.room)).toBe(false);
    b.reg.connect(b.room, b.owner);
    expect(b.reg.isClientControlling(b.owner, b.room)).toBe(true);
  });

  it('render ack and the room door claim; nobody else can claim; the last socket closing ends it', async () => {
    const { reg, room, owner } = registry();
    reg.connect(room, owner);
    reg.renderAck(room, uid(9999), 'x');
    expect(reg.isClientControlling(owner, room)).toBe(false);
    reg.renderAck(room, owner, 'x');
    expect(reg.isClientControlling(owner, room)).toBe(true);
    reg.connect(room, owner);
    reg.disconnect(room, owner);
    expect(reg.isClientControlling(owner, room)).toBe(true);
    reg.disconnect(room, owner);
    expect(reg.isClientControlling(owner, room)).toBe(false);
    // A new socket session needs a new claim: the old one died with the socket
    // (the empty room was pruned; the next admission records it again).
    expect(reg.rooms.has(room)).toBe(false);
    reg.rooms.set(room, { userId: owner, clusterId: null, sockets: 0 });
    reg.connect(room, owner);
    expect(reg.isClientControlling(owner, room)).toBe(false);
    const proxy = new LightningSeatProxy(room, reg);
    proxy.setPreAction(owner, 'auto_fold');
    expect(reg.isClientControlling(owner, room)).toBe(true);
  });

  it('tells the room host when control starts and when it ends', () => {
    const { reg, room, owner } = registry();
    const host = { noteClientControl: vi.fn(), noteClientReleased: vi.fn(), notePresence: vi.fn() };
    reg.hostByRoom.set(room, host);
    reg.connect(room, owner);
    expect(host.noteClientControl).not.toHaveBeenCalled();
    reg.noteClientClaim(room, owner);
    expect(host.noteClientControl).toHaveBeenCalledWith(owner);
    reg.disconnect(room, owner);
    expect(host.notePresence).toHaveBeenLastCalledWith(owner, false);
    expect(host.noteClientReleased).toHaveBeenCalledWith(owner);
  });
});
