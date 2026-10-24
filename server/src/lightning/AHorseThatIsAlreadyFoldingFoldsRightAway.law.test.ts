/**
 * A HORSE THAT IS ALREADY FOLDING FOLDS RIGHT AWAY (Dan 2026-10-24, verbatim:
 * "YES, HORSES SHOULD FOLD RIGHT AWAY IF THEY WERE ALREADY FOLDING.")
 *
 * Measured 2026-10-24: Lightning horses never used the fast fold. They folded
 * only on their own turn (UTG p50 6.3 s after the deal, the button 15.6 s), so
 * their seats freed last and the pool waited for them.
 *
 * The law, as lightningHorseIsAlreadyFolding states it:
 *   - at the street's FIRST priced look (the moment the fast fold is open to it
 *     with chips owed, or its own turn if that comes first) a horse whose own
 *     policy answers fold folds at once, with no think time;
 *   - through the SAME door a person's Lightning Fold uses
 *     (handlePlayerAction 'fast_fold'), recorded as 'horse_policy' with
 *     fold_type 'fast';
 *   - a free check is never fast folded (the big blind unraised, any seat
 *     checked to);
 *   - a horse whose first answer was not a fold decides afresh at its turn, on
 *     its ordinary clock, and that later fold is an ordinary one;
 *   - a liveness fallback (worker down, brain exception) is not a decision to
 *     fold and never fast folds;
 *   - the operator's fast-fold switch stops horses exactly as it stops people.
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
const { lightningHorseIsAlreadyFolding } = await import('./LightningHorse.js');
const { buildHost, formedHand, flush } = kit;

const hosts: any[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.abort('test_complete').catch(() => undefined);
  vi.useRealTimers();
});

function fake() {
  // setImmediate stays real so flush() lets promises settle WITHOUT any clock
  // time passing: a fold seen after flush() alone had no think time.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
}

type Script = (snap: any, early: boolean) => 'fold' | 'call' | 'check' | 'raise' | null;

/** Three horses; the lane answers with the brain, then the script's action. */
async function scriptedHand(base: number, script: Script, deps: Record<string, unknown> = {}) {
  const formed = formedHand(3, base);
  const t = buildHost(formed, [100, 100, 100], {
    horses: new Set(formed.players),
    deps: { sleep: () => Promise.resolve(), ...deps },
  });
  hosts.push(t.host);
  const brain = t.horseLane.raw.decideFast.getMockImplementation()!;
  t.horseLane.raw.decideFast.mockImplementation(async (snap: any) => {
    const result = await brain(snap);
    const early = String(snap.fence).endsWith(':early');
    const want = script(snap, early);
    if (!want) return result;
    const amount =
      want === 'raise'
        ? snap.gameState.minRaiseTo
        : want === 'call'
          ? snap.gameState.toCall
          : undefined;
    return {
      ...result,
      decision: { ...result.decision, action: want, amount, thinkTime: 4_000 },
    };
  });
  await t.host.start();
  await flush();
  const h = t.host as any;
  return { ...t, h, formed };
}

const actionsBy = (t: { h: any }, user: string) =>
  (
    t.h.actions as Array<{ userId?: string; action: string; origin?: string; stage?: string }>
  ).filter((a) => a.userId === user && a.origin !== 'forced');
const lookCalls = (t: { horseLane: { calls: any[] } }, user: string, early: boolean) =>
  t.horseLane.calls.filter(
    (c) => c.player.user_id === user && String(c.fence).endsWith(':early') === early
  ).length;

describe('the already-folding rule (lightningHorseIsAlreadyFolding)', () => {
  const fold = { action: 'fold', workerFallback: false, fast: { decision: {} } };
  it('a policy fold facing a price with no free check is already folding', () => {
    expect(
      lightningHorseIsAlreadyFolding({
        decision: fold,
        legalActions: ['fold', 'call', 'raise'],
        toCall: 2,
      })
    ).toBe(true);
  });
  it('a free check is never fast folded', () => {
    expect(
      lightningHorseIsAlreadyFolding({
        decision: fold,
        legalActions: ['fold', 'check', 'raise'],
        toCall: 0,
      })
    ).toBe(false);
    // Even a price of zero with a menu that somehow lacks check is no fold.
    expect(
      lightningHorseIsAlreadyFolding({ decision: fold, legalActions: ['fold'], toCall: 0 })
    ).toBe(false);
  });
  it('a liveness fallback is not a decision to fold', () => {
    expect(
      lightningHorseIsAlreadyFolding({
        decision: { ...fold, workerFallback: true },
        legalActions: ['fold', 'call'],
        toCall: 2,
      })
    ).toBe(false);
    expect(
      lightningHorseIsAlreadyFolding({
        decision: { ...fold, fast: { decision: { policyFallback: 'brain_exception' } } },
        legalActions: ['fold', 'call'],
        toCall: 2,
      })
    ).toBe(false);
  });
  it('anything but a fold waits for the turn', () => {
    for (const action of ['call', 'raise', 'all_in', 'check'])
      expect(
        lightningHorseIsAlreadyFolding({
          decision: { ...fold, action },
          legalActions: ['fold', 'call', 'raise'],
          toCall: 2,
        })
      ).toBe(false);
  });
});

describe('the menu a seat would hold (HandController asIfToAct, read-only)', () => {
  it('off the turn: the price and menu of the seat, with no power to act', async () => {
    fake();
    const formed = formedHand(3, 4050);
    const t = buildHost(formed, [100, 100, 100], {
      horses: new Set(formed.players),
      deps: { sleep: () => Promise.resolve() },
    });
    hosts.push(t.host);
    // The lane never answers: nobody acts while the menus are read.
    t.horseLane.raw.decideFast.mockImplementation(() => new Promise(() => undefined) as never);
    await t.host.start();
    await flush();
    const hc = (t.host as any).hc;
    const sbSeat = hc.getState().players.find((p: any) => p.user_id === formed.sb).seat;
    const real = hc.getAuthoritativeActionState(formed.sb);
    expect(real.canAct).toBe(false);
    expect(real.legalActions).toEqual([]);
    const sb = hc.getAuthoritativeActionState(formed.sb, { asIfToAct: true });
    expect(sb.canAct).toBe(true);
    expect(sb.currentPlayerSeat).toBe(sbSeat);
    expect(sb.toCall).toBe(1);
    expect(sb.legalActions).toEqual(expect.arrayContaining(['fold', 'call', 'raise']));
    expect(sb.legalActions).not.toContain('check');
    const bb = hc.getAuthoritativeActionState(formed.bb, { asIfToAct: true });
    expect(bb.toCall).toBe(0);
    expect(bb.legalActions).toContain('check');
    // Reading it changed nothing: the turn is still the button's.
    expect(hc.getState().currentPlayerSeat).not.toBe(sbSeat);
    expect(hc.performAction(sbSeat, 'fold', undefined, 'horse_policy')).toBe(false);
  });
});

describe('a Lightning horse that is already folding folds right away (the host)', () => {
  it('folds at the deal with no think time, through the Lightning Fold door, as the horse', async () => {
    fake();
    const t = await scriptedHand(4100, () => 'fold');
    const { sb, bb, btn } = t.formed;
    // No clock time has passed: both folds landed on the first look.
    for (const user of [sb, btn]) {
      const acts = actionsBy(t, user);
      expect(acts.map((a) => a.action)).toEqual(['fold']);
      expect(acts[0].origin).toBe('horse_policy');
      expect(acts[0].stage).toBe('preflop');
    }
    // The small blind was never on the turn: it was an early look.
    expect(lookCalls(t, sb, true)).toBe(1);
    // The button decided on its own turn (asked again if the small blind's
    // early fold landed first: the host refreshes a horse's view of the table).
    expect(lookCalls(t, btn, false)).toBeGreaterThanOrEqual(1);
    expect(lookCalls(t, btn, true)).toBe(0);
    // The big blind could check for free: no look, no fold, it wins the blinds.
    expect(lookCalls(t, bb, true)).toBe(0);
    expect(actionsBy(t, bb).filter((a) => a.action === 'fold')).toEqual([]);
    await flush();
    // The original fold door recorded both as fast folds, and settlement
    // carries the same fold types and the uncontested pot to the big blind.
    expect(t.calls.fastFold.map((f) => `${f.playerId}:${f.foldType}`).sort()).toEqual(
      [`${sb}:fast`, `${btn}:fast`].sort()
    );
    const settle = t.calls.settle[0];
    expect(settle).toBeTruthy();
    const byPlayer = new Map(settle.results.map((r) => [r.playerId, r]));
    expect(byPlayer.get(sb)?.foldType).toBe('fast');
    expect(byPlayer.get(btn)?.foldType).toBe('fast');
    expect(byPlayer.get(bb)?.foldType).toBe('none');
    expect(byPlayer.get(bb)?.won).toBeGreaterThan(0);
    expect(byPlayer.get(btn)?.contributed).toBe(0);
  });

  it('uses the same door a person uses: handlePlayerAction fast_fold with the hand context', async () => {
    fake();
    const formed = formedHand(3, 4150);
    const t = buildHost(formed, [100, 100, 100], {
      horses: new Set(formed.players),
      deps: { sleep: () => Promise.resolve() },
    });
    hosts.push(t.host);
    const brain = t.horseLane.raw.decideFast.getMockImplementation()!;
    t.horseLane.raw.decideFast.mockImplementation(async (snap: any) => {
      const r = await brain(snap);
      return { ...r, decision: { ...r.decision, action: 'fold', amount: undefined } };
    });
    const door = vi.spyOn(t.host, 'handlePlayerAction');
    await t.host.start();
    await flush();
    const handId = (t.host as any).handId;
    const fastFolds = door.mock.calls.filter((c) => c[1] === 'fast_fold');
    expect(fastFolds.length).toBe(2);
    for (const c of fastFolds) {
      expect(c[3]).toBe(`lightning-hand:${handId}`);
      expect((c[4] as { origin?: string } | undefined)?.origin).toBe('horse_policy');
    }
  });

  it('a free check is never folded: checked-to streets are checked, not folded', async () => {
    fake();
    // Preflop everybody calls or checks; after that the policy says fold
    // everywhere, and nobody ever bets.
    const t = await scriptedHand(4200, (snap) =>
      snap.gameState.stage === 'preflop' ? (snap.gameState.toCall > 0 ? 'call' : 'check') : 'fold'
    );
    for (let i = 0; i < 40 && t.h.state === 'dealing'; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      await flush();
    }
    for (const user of t.formed.players) {
      const post = actionsBy(t, user).filter((a) => a.stage !== 'preflop');
      expect(post.length).toBeGreaterThan(0);
      expect(post.every((a) => a.action === 'check')).toBe(true);
    }
    // No early look ever happened after preflop: nobody owed anything.
    const earlyAfterPreflop = t.horseLane.calls.filter(
      (c) => String(c.fence).endsWith(':early') && c.gameState.stage !== 'preflop'
    );
    expect(earlyAfterPreflop).toEqual([]);
    expect(t.calls.fastFold.length).toBe(0);
  });

  it('a horse whose first look was not a fold decides afresh at its turn, on its own clock', async () => {
    fake();
    const formed = formedHand(3, 4300);
    const t = await scriptedHand(4300, (snap, early) => {
      const me = snap.player.user_id;
      if (me === formed.btn) return 'raise';
      if (me === formed.sb) return early ? 'call' : 'fold';
      return 'fold';
    });
    const { sb } = t.formed;
    // The early look said call: the small blind is still in the hand.
    expect(lookCalls(t, sb, true)).toBe(1);
    expect(actionsBy(t, sb)).toEqual([]);
    // The button's raise lands after its think time; then the small blind's
    // turn decision folds on the ordinary clock, as an ordinary fold.
    await vi.advanceTimersByTimeAsync(4_100);
    await flush();
    expect(t.h.turnUser).toBe(sb);
    expect(actionsBy(t, sb)).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_100);
    await flush();
    const acts = actionsBy(t, sb);
    expect(acts.map((a) => a.action)).toEqual(['fold']);
    expect(acts[0].origin).toBe('horse_policy');
    expect(t.h.foldTypes.get(sb)).toBe('normal');
    expect(t.calls.fastFold.find((f) => f.playerId === sb)?.foldType).toBe('normal');
  });

  it("a horse account's own client taking the seat stops an early look's fold", async () => {
    fake();
    const formed = formedHand(3, 4350);
    const controlled = new Set<string>();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => (release = r));
    const t2 = buildHost(formed, [100, 100, 100], {
      horses: new Set(formed.players),
      deps: {
        sleep: () => Promise.resolve(),
        isClientControlling: (p: string) => controlled.has(p),
      },
    });
    hosts.push(t2.host);
    const brain = t2.horseLane.raw.decideFast.getMockImplementation()!;
    t2.horseLane.raw.decideFast.mockImplementation(async (snap: any) => {
      const r = await brain(snap);
      if (snap.player.user_id === formed.sb) await gate;
      const action = snap.player.user_id === formed.btn ? 'call' : 'fold';
      const amount = action === 'call' ? snap.gameState.toCall : undefined;
      return { ...r, decision: { ...r.decision, action, amount, thinkTime: 4_000 } };
    });
    await t2.host.start();
    await flush();
    expect(
      t2.horseLane.calls.filter(
        (c: any) => c.player.user_id === formed.sb && String(c.fence).endsWith(':early')
      ).length
    ).toBe(1);
    controlled.add(formed.sb);
    release!();
    await flush();
    const sbFolds = ((t2.host as any).actions as Array<{ userId?: string; action: string }>).filter(
      (a) => a.userId === formed.sb && a.action === 'fold'
    );
    expect(sbFolds).toEqual([]);
    expect(t2.calls.fastFold.find((f) => f.playerId === formed.sb)).toBeUndefined();
  });

  it("the operator's fast-fold switch stops horses as it stops people", async () => {
    fake();
    const t = await scriptedHand(4400, () => 'fold', {
      foldFlags: () => ({ fastFold: false, foldWatch: false }),
    });
    // No early look is asked, and the button's turn fold waits its think time.
    expect(t.horseLane.calls.filter((c) => String(c.fence).endsWith(':early'))).toEqual([]);
    expect(actionsBy(t, t.formed.btn)).toEqual([]);
    await vi.advanceTimersByTimeAsync(4_100);
    await flush();
    const acts = actionsBy(t, t.formed.btn);
    expect(acts.map((a) => a.action)).toEqual(['fold']);
    expect(t.h.foldTypes.get(t.formed.btn)).toBe('normal');
  });
});
