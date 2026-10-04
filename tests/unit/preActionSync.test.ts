/**
 * ═══ A PRE-ACTION NEVER ARMS ITSELF (2026-10-04) ═════════════════════════════
 *
 * In the heads-up sit-and-go played beside the match Dan reported on
 * 2026-10-04, his seat folded thirteen hands in two and a quarter minutes as
 * `fold[pre_action]`, ten of them within half a second of the deal. He had
 * armed one pre-action. Each of three open tabs of the account was sending 68
 * to 98 refused /preaction requests a minute.
 *
 * The cause was the page, not the engine: a clear the engine answered with
 * "No active hand" was read as a failure, the pre-action was put back on the
 * bar, and putting it back SENT it again - into the next hand. The first
 * describe block replays that against the rule as it was. The rest pin the
 * rule that replaced it, driven with the engine's real replies.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceBlockAfter } from '../helpers/sourceWindow';

vi.mock('../../src/lib/authToken', () => ({
  getFreshAccessToken: async () =>
    JSON.parse(localStorage.getItem('smarter-poker-auth')!).access_token,
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  PRE_ACTION_REFUSED,
  PRE_ACTION_TABLE_NOT_RUNNING,
  classifyPreActionReply,
  serverPreActionFor,
  syncPreActionToEngine,
  type PreActionChoice,
  type PreActionReply,
  type PreActionSyncInput,
  type PreActionSyncRefs,
} from '@/lib/preActionSync';
import {
  resetEngineCircuitBreaker,
  sendHeartbeat,
  setPreAction as apiSetPreAction,
} from '../../src/services/GameServerAPI';

/* ── THE ENGINE'S REPLIES, AS THE API LAYER HANDS THEM TO THE PAGE ──────────── */
const OK: PreActionReply = { success: true };
const NO_ACTIVE_HAND: PreActionReply = {
  success: false,
  error: 'No active hand',
  code: PRE_ACTION_REFUSED,
};
const NOT_IN_HAND: PreActionReply = {
  success: false,
  error: 'Player not found at this table',
  code: PRE_ACTION_REFUSED,
};
const NO_GAME_FOR_TABLE: PreActionReply = {
  success: false,
  error: 'Table engine not found',
  code: PRE_ACTION_TABLE_NOT_RUNNING,
};
const UNREACHABLE: PreActionReply = { success: false, error: 'Server unreachable' };
/** What the API layer returned for the same 400 until 2026-10-04. */
const OLD_SHAPE_400: PreActionReply = { success: false, error: 'Server error (400)' };

/** retryAsync without the waiting: same attempts, same "network" filter. */
async function retryNow<T>(fn: () => Promise<T>, maxRetries: number): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof Error) || !err.message.toLowerCase().includes('network')) throw err;
    }
  }
  throw last;
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Sent {
  action: string;
  cap: number | undefined;
  handId: string | undefined;
  /** The hand on the engine when the request landed; 0 when none was running. */
  landedInHand: number;
}

/**
 * The engine, reduced to what /preaction does: it refuses everything when no
 * hand is running, and an arm lands in whatever hand is running when it
 * arrives.
 */
function makeEngine(opts: { refusalShape?: 'old' | 'new' } = {}) {
  const engine = {
    hand: 7,
    handRunning: true,
    armed: null as string | null,
    sent: [] as Sent[],
    /** Start the next hand once this many requests have arrived. */
    dealNextHandAfter: null as number | null,
    /** End this hand and deal the next once this many requests have been ANSWERED. */
    dealNextHandOnceAnswered: null as number | null,
    /** Scripted replies, taken before the engine's own answer. */
    script: [] as PreActionReply[],
    armsLandedIn(hand: number) {
      return engine.sent.filter((s) => s.action !== 'clear' && s.landedInHand === hand).length;
    },
    endHand() {
      engine.handRunning = false;
      engine.armed = null; // preActionEngine.dispose at hand end
    },
    dealNextHand() {
      engine.hand += 1;
      engine.handRunning = true;
    },
    async answer(action: string, cap?: number, handId?: string): Promise<PreActionReply> {
      if (engine.dealNextHandAfter !== null && engine.sent.length >= engine.dealNextHandAfter) {
        engine.dealNextHandAfter = null;
        engine.dealNextHand();
      }
      engine.sent.push({
        action,
        cap,
        handId,
        landedInHand: engine.handRunning ? engine.hand : 0,
      });
      const reply = engine.reply(action);
      if (
        engine.dealNextHandOnceAnswered !== null &&
        engine.sent.length >= engine.dealNextHandOnceAnswered
      ) {
        engine.dealNextHandOnceAnswered = null;
        engine.endHand();
        engine.dealNextHand();
      }
      return reply;
    },
    reply(action: string): PreActionReply {
      const scripted = engine.script.shift();
      if (scripted) return scripted;
      if (!engine.handRunning) {
        return opts.refusalShape === 'old' ? OLD_SHAPE_400 : NO_ACTIVE_HAND;
      }
      if (action === 'clear') {
        engine.armed = null;
        return OK;
      }
      engine.armed = action;
      return { success: true, armedToCall: 15 };
    },
  };
  return engine;
}

/**
 * The effect as TablePage ran it until 2026-10-04, reduced to what it sent
 * and what it restored. Kept as a witness so the loop can be shown.
 */
function previousSync(input: PreActionSyncInput): void {
  const { tableId, preAction, serverSetPreAction, setPreAction, refs } = input;
  const retry = input.retry ?? retryNow;
  if (!tableId) return;
  if (preAction) {
    const serverAction = serverPreActionFor(preAction, refs.preActionCanCheckRef.current);
    refs.hadPreActionRef.current = true;
    refs.lastArmedPreActionRef.current = preAction;
    void retry(
      async () => {
        const res = await serverSetPreAction(tableId, serverAction, undefined);
        if (!res?.success) throw new Error(`network/preaction-arm: ${res?.error}`);
        return res;
      },
      2,
      400
    ).catch(() => {
      refs.hadPreActionRef.current = false;
      setPreAction(null);
      input.toastError('Could Not Arm That Pre-Action, Play It Manually.');
    });
  } else if (refs.hadPreActionRef.current) {
    refs.hadPreActionRef.current = false;
    const armed = refs.lastArmedPreActionRef.current;
    void retry(
      async () => {
        const res = await serverSetPreAction(tableId, 'clear');
        if (!res?.success) throw new Error(`network/preaction-clear: ${res?.error}`);
        return res;
      },
      2,
      400
    ).catch(() => {
      refs.hadPreActionRef.current = true;
      if (armed) setPreAction(armed);
      input.toastError('Could Not Cancel Your Pre-Action, It May Still Run This Hand.');
    });
  }
}

/**
 * The page around the sync: the `preAction` state, the refs, and the two
 * other writers of that state (the hand/street reset and the engine's own
 * pre_action frame). A state change re-runs the sync, as the effect does.
 */
function makePage(
  engine: ReturnType<typeof makeEngine>,
  opts: {
    sync?: (input: PreActionSyncInput) => void;
    lightning?: boolean;
  } = {}
) {
  const sync = opts.sync ?? syncPreActionToEngine;
  const refs: PreActionSyncRefs = {
    hadPreActionRef: { current: false },
    lastArmedPreActionRef: { current: null },
    preActionCanCheckRef: { current: false },
    preActionCallAmountRef: { current: 0 },
    preActionHeldByEngineRef: { current: null },
    preActionSendSeqRef: { current: 0 },
    lightningRoomRef: { current: opts.lightning ? { poolSessionId: 'room' } : null },
  };
  const page = {
    preAction: null as PreActionChoice | null,
    refs,
    toasts: [] as string[],
    reports: [] as string[],
    armsAnnounced: [] as string[],
    set(next: PreActionChoice | null) {
      if (page.preAction === next) return; // React: same value, no effect run
      page.preAction = next;
      run();
    },
    /** The player taps a pre-action on the bar. */
    arm(choice: PreActionChoice) {
      page.set(choice);
    },
    /** The player taps the armed control again to cancel it. */
    cancel() {
      page.set(null);
    },
    /** New street, hand over, or the hero acted: TablePage's reset effect. */
    boundary() {
      page.set(null);
    },
    /** The engine's own pre_action frame, as TablePage's handler applies it. */
    engineFrame(mapped: PreActionChoice | null, reason: string | null = null) {
      if (mapped === null && reason === null && page.preAction !== null) return;
      if (mapped === null) refs.hadPreActionRef.current = false;
      if (mapped !== null && page.preAction !== mapped) {
        refs.preActionHeldByEngineRef.current = mapped;
      }
      page.set(mapped);
    },
  };
  function run() {
    sync({
      tableId: 'table-1',
      preAction: page.preAction,
      refs,
      // The page's hand number follows the engine's: a new deal is a new number.
      handNumber: () => engine.hand,
      lightningArmHandId: () => (opts.lightning ? 'lightning-hand-1' : null),
      serverSetPreAction: (_table, action, cap, handId) => engine.answer(action, cap, handId),
      setPreAction: (next) => page.set(next),
      toastError: (message) => page.toasts.push(message),
      reportError: (_err, context) => page.reports.push(context),
      onArmSent: (serverAction) => page.armsAnnounced.push(serverAction),
      retry: retryNow,
    });
  }
  return page;
}

describe('the defect: one armed fold, replayed against the previous rule', () => {
  it('re-armed itself into the next hand after the engine said there was no hand', async () => {
    const engine = makeEngine({ refusalShape: 'old' });
    const page = makePage(engine, { sync: previousSync });

    page.arm('fold');
    await settle();
    expect(engine.armsLandedIn(7)).toBe(1);

    // The engine folds for the player and the hand is over. The page clears.
    engine.endHand();
    // The next hand is dealt while the page is still asking: after the three
    // refused clears and the first refused re-arm.
    engine.dealNextHandAfter = 5;
    page.boundary();
    await settle();

    // Three clears refused, then the "restore" sent the arm again, and it
    // landed in hand 8: a hand the player armed nothing in.
    expect(engine.sent.filter((s) => s.action === 'clear')).toHaveLength(3);
    expect(engine.armsLandedIn(8)).toBe(1);
    expect(page.preAction).toBe('fold');
    expect(page.toasts).toContain('Could Not Cancel Your Pre-Action, It May Still Run This Hand.');
  });
});

describe('a clear the engine has answered is finished', () => {
  it('"No active hand": one request, nothing restored, nothing said, nothing re-armed', async () => {
    const engine = makeEngine();
    const page = makePage(engine);

    page.arm('fold');
    await settle();
    engine.endHand();
    engine.dealNextHandAfter = 2; // the next hand starts right behind the clear
    page.boundary();
    await settle();
    engine.dealNextHand();
    await settle();

    expect(engine.sent.map((s) => s.action)).toEqual(['auto_fold', 'clear']);
    expect(engine.armsLandedIn(8)).toBe(0);
    expect(engine.armsLandedIn(9)).toBe(0);
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual([]);
    expect(page.reports).toEqual([]);
    expect(page.refs.hadPreActionRef.current).toBe(false);
  });

  it.each([
    ['the player is not in the hand', NOT_IN_HAND],
    ['the engine runs no game for the table', NO_GAME_FOR_TABLE],
    [
      'a Lightning hand the player has left',
      { success: false, error: 'You have left this hand', code: PRE_ACTION_REFUSED },
    ],
    [
      'the engine names it by code',
      {
        success: false,
        error: 'a sentence nobody has seen before',
        code: PRE_ACTION_REFUSED,
        hint: { engineCode: 'NO_ACTIVE_HAND' },
      },
    ],
  ] as Array<[string, PreActionReply]>)('%s: the same', async (_name, reply) => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('callAny');
    await settle();
    engine.script.push(reply);
    page.boundary();
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_call_any', 'clear']);
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual([]);
  });

  it('a clear the engine accepts is one request', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('check');
    await settle();
    page.cancel();
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_check', 'clear']);
    expect(engine.armed).toBeNull();
    expect(page.toasts).toEqual([]);
  });
});

describe('a clear that could not be delivered', () => {
  it('is retried, then SHOWN again without being sent again', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('fold');
    await settle();

    engine.script.push(UNREACHABLE, UNREACHABLE, UNREACHABLE);
    page.cancel();
    await settle();

    // Three attempts at the clear. The control is back on the bar, because
    // the engine may still be holding it - and no arm was sent to put it there.
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_fold', 'clear', 'clear', 'clear']);
    expect(page.preAction).toBe('fold');
    expect(page.toasts).toEqual(['Could Not Cancel Your Pre-Action, It May Still Run This Hand.']);
    expect(page.reports).toEqual(['TablePage.PreAction_clear_refused']);
    // The marker was consumed by the run that showed it.
    expect(page.refs.preActionHeldByEngineRef.current).toBeNull();

    // And it can be cancelled again: this time the engine hears it.
    page.cancel();
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual([
      'auto_fold',
      'clear',
      'clear',
      'clear',
      'clear',
    ]);
    expect(page.preAction).toBeNull();
    expect(engine.armed).toBeNull();
  });

  it('is not shown again once the hand it belonged to has left the felt', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('fold');
    await settle();

    engine.script.push(UNREACHABLE, UNREACHABLE, UNREACHABLE);
    engine.dealNextHandAfter = 3; // hand 8 is on the felt before the last attempt
    engine.endHand();
    page.boundary();
    await settle();

    // The engine dropped it with hand 7. There is nothing to show and nothing
    // that "may still run".
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual([]);
    expect(engine.armsLandedIn(8)).toBe(0);
  });

  it('an answer this client does not recognise fails towards showing it', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('call');
    await settle();
    engine.script.push({
      success: false,
      error: 'Table is being audited',
      code: PRE_ACTION_REFUSED,
    });
    page.cancel();
    await settle();
    // Not retried (it was an answer), not re-armed, but visible.
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_call', 'clear']);
    expect(page.preAction).toBe('call');
    expect(page.toasts).toEqual(['Could Not Cancel Your Pre-Action, It May Still Run This Hand.']);
  });

  it('is never restored in a Lightning room', async () => {
    const engine = makeEngine();
    const page = makePage(engine, { lightning: true });
    page.arm('fold');
    await settle();
    expect(engine.sent[0]).toMatchObject({ action: 'auto_fold', handId: 'lightning-hand-1' });
    engine.script.push(UNREACHABLE, UNREACHABLE, UNREACHABLE);
    page.cancel();
    await settle();
    expect(page.preAction).toBeNull();
    expect(page.refs.preActionHeldByEngineRef.current).toBeNull();
  });
});

describe("the engine's own copy is shown, not sent back", () => {
  it('a tab that armed nothing adopts the frame and sends nothing', async () => {
    const engine = makeEngine();
    const otherTab = makePage(engine);

    otherTab.engineFrame('fold');
    await settle();

    expect(otherTab.preAction).toBe('fold');
    expect(engine.sent).toEqual([]);
    expect(otherTab.armsAnnounced).toEqual([]);
    expect(otherTab.refs.preActionHeldByEngineRef.current).toBeNull();
  });

  it('and can still cancel it', async () => {
    const engine = makeEngine();
    engine.armed = 'auto_fold';
    const otherTab = makePage(engine);
    otherTab.engineFrame('fold');
    await settle();
    otherTab.cancel();
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['clear']);
    expect(engine.armed).toBeNull();
  });

  it('four clients, one arm: the engine hears it once', async () => {
    const engine = makeEngine();
    const tabs = [makePage(engine), makePage(engine), makePage(engine), makePage(engine)];
    tabs[0].arm('fold');
    await settle();
    // The engine pushes its copy to every socket the player has open.
    for (const tab of tabs) tab.engineFrame('fold');
    await settle();
    expect(engine.sent.filter((s) => s.action !== 'clear')).toHaveLength(1);
    expect(tabs.map((t) => t.preAction)).toEqual(['fold', 'fold', 'fold', 'fold']);
  });

  it('the frame the page already shows changes nothing and leaves no marker', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('fold');
    await settle();
    page.engineFrame('fold');
    await settle();
    expect(engine.sent).toHaveLength(1);
    expect(page.refs.preActionHeldByEngineRef.current).toBeNull();
  });

  it('a real arm after an adopted frame is still sent', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.engineFrame('fold');
    await settle();
    page.engineFrame(null, 'cleared'); // the engine says it holds nothing now
    await settle();
    expect(engine.sent).toEqual([]);
    page.arm('fold'); // the player arms the same thing, for real
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_fold']);
  });

  it('a different choice made over an adopted frame is sent', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.engineFrame('fold');
    await settle();
    page.arm('callAny');
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_call_any']);
  });
});

describe('an arm', () => {
  it('the engine refuses for want of a hand is not retried and not announced', async () => {
    const engine = makeEngine();
    engine.endHand();
    engine.dealNextHandAfter = 1; // a retry would land in the next hand
    const page = makePage(engine);
    page.arm('fold');
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_fold']);
    expect(engine.armsLandedIn(8)).toBe(0);
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual([]);
    expect(page.refs.hadPreActionRef.current).toBe(false);
  });

  it('refused for a reason this client does not know disarms with a word', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    engine.script.push({
      success: false,
      error: 'Invalid pre-action: auto_dance',
      code: PRE_ACTION_REFUSED,
    });
    page.arm('fold');
    await settle();
    expect(engine.sent).toHaveLength(1);
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual(['Could Not Arm That Pre-Action, Play It Manually.']);
    expect(page.reports).toEqual(['TablePage.PreAction_set_refused']);
  });

  it('that cannot be delivered is retried within its hand, then disarms with a word', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    engine.script.push(UNREACHABLE, UNREACHABLE, UNREACHABLE);
    page.arm('check');
    await settle();
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_check', 'auto_check', 'auto_check']);
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual(['Could Not Arm That Pre-Action, Play It Manually.']);
  });

  it('delivered on a retry is armed and says nothing', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    engine.script.push(UNREACHABLE);
    page.arm('check');
    await settle();
    expect(engine.sent).toHaveLength(2);
    expect(engine.armed).toBe('auto_check');
    expect(page.preAction).toBe('check');
    expect(page.toasts).toEqual([]);
  });

  it('is never retried into a later hand', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    engine.script.push(UNREACHABLE);
    engine.dealNextHandOnceAnswered = 1; // hand 8 is on the felt before the retry
    page.arm('fold');
    await settle();
    // The page saw the hand change and did not ask again: the engine would
    // have accepted it, in a hand the player armed nothing in.
    expect(engine.sent).toHaveLength(1);
    expect(engine.armsLandedIn(8)).toBe(0);
    expect(page.preAction).toBeNull();
    expect(page.toasts).toEqual([]);
  });

  it('carries the Call price for auto_call only, and adopts the engine number', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.refs.preActionCallAmountRef.current = 40;
    page.arm('call');
    await settle();
    expect(engine.sent[0]).toMatchObject({ action: 'auto_call', cap: 40 });
    expect(page.refs.preActionCallAmountRef.current).toBe(15);
    page.cancel();
    await settle();
    page.refs.preActionCallAmountRef.current = 40;
    page.arm('callAny');
    await settle();
    expect(engine.sent[2]).toMatchObject({ action: 'auto_call_any', cap: undefined });
  });

  it('maps the bar to the engine names, Check/Fold by what the bar was offering', () => {
    expect(serverPreActionFor('fold', false)).toBe('auto_fold');
    expect(serverPreActionFor('fold', true)).toBe('auto_check_fold');
    expect(serverPreActionFor('check', false)).toBe('auto_check');
    expect(serverPreActionFor('call', false)).toBe('auto_call');
    expect(serverPreActionFor('callAny', false)).toBe('auto_call_any');
  });
});

describe('an answer that belongs to an earlier choice stands down', () => {
  it('a failed arm does not darken the bar after the player armed something that worked', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    // The first arm cannot be delivered; while it is being retried the player
    // changes their mind, and that one arrives.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const answer = engine.answer.bind(engine);
    let first = true;
    engine.answer = async (action, cap, handId) => {
      if (first) {
        first = false;
        engine.sent.push({ action, cap, handId, landedInHand: 0 });
        await held;
        return UNREACHABLE;
      }
      return answer(action, cap, handId);
    };
    page.arm('call');
    await settle();
    page.arm('callAny');
    await settle();
    release();
    await settle();

    expect(page.preAction).toBe('callAny');
    expect(engine.armed).toBe('auto_call_any');
    expect(page.toasts).toEqual([]);
    // The stale arm was not retried over the new one.
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_call', 'auto_call_any']);
    expect(page.refs.hadPreActionRef.current).toBe(true);
  });

  it('a clear is not retried over an arm the player made since', async () => {
    const engine = makeEngine();
    const page = makePage(engine);
    page.arm('fold');
    await settle();

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const answer = engine.answer.bind(engine);
    let holdNext = true;
    engine.answer = async (action, cap, handId) => {
      if (holdNext && action === 'clear') {
        holdNext = false;
        engine.sent.push({ action, cap, handId, landedInHand: 0 });
        await held;
        return UNREACHABLE;
      }
      return answer(action, cap, handId);
    };
    page.cancel();
    await settle();
    page.arm('check');
    await settle();
    release();
    await settle();

    // One clear, then the new arm. A second clear landing after it would have
    // wiped the Check off the engine with the bar still showing it.
    expect(engine.sent.map((s) => s.action)).toEqual(['auto_fold', 'clear', 'auto_check']);
    expect(engine.armed).toBe('auto_check');
    expect(page.preAction).toBe('check');
    expect(page.toasts).toEqual([]);
  });
});

describe('reading the reply', () => {
  it.each([
    [OK, 'done'],
    [NO_ACTIVE_HAND, 'nothing_can_run'],
    [NOT_IN_HAND, 'nothing_can_run'],
    [NO_GAME_FOR_TABLE, 'nothing_can_run'],
    [{ success: false, error: 'That hand is over', code: PRE_ACTION_REFUSED }, 'nothing_can_run'],
    [
      { success: false, error: 'x', code: PRE_ACTION_REFUSED, hint: { engineCode: 'STALE_HAND' } },
      'nothing_can_run',
    ],
    [{ success: false, error: 'Invalid pre-action: x', code: PRE_ACTION_REFUSED }, 'refused'],
    [UNREACHABLE, 'not_delivered'],
    [{ success: false, error: 'Circuit breaker open - server unreachable' }, 'not_delivered'],
    [{ success: false, error: 'Server error (500)' }, 'not_delivered'],
    // The engine's sentence without the code that says the engine sent it is
    // not trusted: a proxy can say anything.
    [{ success: false, error: 'No active hand' }, 'not_delivered'],
    [null, 'not_delivered'],
    [undefined, 'not_delivered'],
  ] as Array<[PreActionReply | null | undefined, string]>)('%j is %s', (reply, outcome) => {
    expect(classifyPreActionReply(reply)).toBe(outcome);
  });
});

describe('the API layer keeps what the engine said', () => {
  const reply = (status: number, body: unknown) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });

  beforeEach(() => {
    mockFetch.mockReset();
    resetEngineCircuitBreaker();
    localStorage.setItem(
      'smarter-poker-auth',
      JSON.stringify({
        access_token: `e30.${btoa(JSON.stringify({ sub: 'user-1', session_id: 'login-1', exp: 4102444800 }))}.sig`,
      })
    );
  });

  it('a 400 carries the engine sentence and says the engine answered', async () => {
    mockFetch.mockResolvedValue(reply(400, { success: false, error: 'No active hand' }));
    const res = await apiSetPreAction('table-1', 'clear');
    expect(res).toEqual({ success: false, error: 'No active hand', code: PRE_ACTION_REFUSED });
    expect(classifyPreActionReply(res)).toBe('nothing_can_run');
  });

  it("the engine's own code travels too", async () => {
    mockFetch.mockResolvedValue(
      reply(400, { success: false, error: 'That hand is over', code: 'STALE_HAND' })
    );
    const res = await apiSetPreAction('table-1', 'auto_fold', undefined, 'hand-1');
    expect(res.hint).toEqual({ engineCode: 'STALE_HAND' });
    expect(res.code).toBe(PRE_ACTION_REFUSED);
  });

  it('a 400 with no readable body is still an answer', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => {
        throw new Error('not json');
      },
    });
    const res = await apiSetPreAction('table-1', 'clear');
    expect(res).toEqual({
      success: false,
      error: 'Server error (400)',
      code: PRE_ACTION_REFUSED,
    });
    // Unrecognised: for a clear that fails towards showing the control.
    expect(classifyPreActionReply(res)).toBe('refused');
  });

  it('a 404 is "no game for this table", and never counts toward the shared breaker', async () => {
    mockFetch.mockResolvedValue(reply(404, { success: false, error: 'Table engine not found' }));
    for (let i = 0; i < 4; i++) {
      const res = await apiSetPreAction('closed-table', 'clear');
      expect(res.code).toBe(PRE_ACTION_TABLE_NOT_RUNNING);
      expect(classifyPreActionReply(res)).toBe('nothing_can_run');
    }
    // Four of them, and a live table's heartbeat still goes out.
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(reply(200, { success: true }));
    const beat = await sendHeartbeat('live-table');
    expect(beat.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a 500 is not an answer: no code, and it does count', async () => {
    mockFetch.mockResolvedValue(reply(500, {}));
    const res = await apiSetPreAction('table-1', 'clear');
    expect(res).toEqual({ success: false, error: 'Server error (500)' });
    expect(classifyPreActionReply(res)).toBe('not_delivered');
    await apiSetPreAction('table-1', 'clear');
    await apiSetPreAction('table-1', 'clear');
    mockFetch.mockClear();
    const open = await apiSetPreAction('table-1', 'clear');
    expect(open.error).toMatch(/Circuit breaker open/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(classifyPreActionReply(open)).toBe('not_delivered');
  });

  it('a request that throws is not an answer', async () => {
    mockFetch.mockRejectedValue(new Error('Failed to fetch'));
    const res = await apiSetPreAction('table-1', 'auto_fold');
    expect(res).toEqual({ success: false, error: 'Server unreachable' });
  });
});

describe('TablePage hands the rule its refs and keeps no copy of it', () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const RAW_PAGE = readFileSync(resolve(__dirname, '../../src/pages/TablePage.tsx'), 'utf8');
  const PAGE = strip(RAW_PAGE);

  it('the effect calls the sync with the page refs, and nothing else sends a pre-action', () => {
    expect(PAGE).toMatch(/syncPreActionToEngine\(\{\s*tableId,\s*preAction,\s*refs: \{/);
    expect(PAGE).toMatch(/preActionHeldByEngineRef,\s*preActionSendSeqRef,\s*lightningRoomRef,/);
    expect(PAGE).toMatch(/handNumber: \(\) => tableStateRef\.current\.handNumber \?\? 0,/);
    // The only reference to the API call left on the page is the one handed
    // to the sync: no second sender.
    expect(PAGE.match(/serverSetPreAction/g)).toHaveLength(2);
    expect(PAGE).toMatch(/setPreAction as serverSetPreAction,/);
    expect(PAGE).not.toMatch(/serverSetPreAction\(/);
  });

  it("the engine's frame is marked as the engine's own before it is shown", () => {
    // The whole handler block, however long it grows.
    const handler = strip(sliceBlockAfter(RAW_PAGE, "if (ev.kind === 'pre_action') {"));
    const marker = handler.indexOf(
      'if (mapped !== null && preActionArmedRef.current !== mapped) {'
    );
    const shown = handler.indexOf('setPreAction((cur) => (cur === mapped ? cur : mapped));');
    expect(marker).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(marker);
    expect(handler.slice(marker, shown)).toMatch(/preActionHeldByEngineRef\.current = mapped;/);
  });
});
