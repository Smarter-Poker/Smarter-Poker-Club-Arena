/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE TABLE HEARS WHAT THE ENGINE ANNOUNCES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ServerTableEngineBase builds its sub-engines with an `onEvent` callback and
 * that callback is the ONLY consumer of everything they raise. For three
 * families of event the callback did something real but private, so nothing
 * read as lost — and the browser, which had a subscriber waiting for each of
 * them, was never told.
 *
 * WHAT THAT COST THE PLAYER.
 *
 *   TIME_BANK_STOPPED / _EXPIRED / _DEPLETED
 *     TIME_BANK_ACTIVATED reaches the client through its own hand-written
 *     hub broadcast (ServerTableEngineTurns.activateTimeBank). The three
 *     events that END a bank had no such path: the callback here does DB
 *     accounting (onTimeBankAccounting) and stops. TablePage's
 *     persistTimeBankState is the only caller of setTimeBankActive(false) and
 *     it is subscribed to exactly these three, so the badge went on at
 *     activation and never came off — it cleared only if a later snapshot
 *     happened to disagree with it.
 *
 *   PRE_ACTION_EXECUTED
 *     The callback returns early for this type on purpose (the executed
 *     action must NOT disarm the hero's own bar ahead of the snapshot — see
 *     the comment at that return). The early return also dropped it for
 *     everyone else. useTableChat builds "Player 1a2b auto-folded" from this
 *     event, so a pre-action was the one way to act at this table without the
 *     table being told.
 *
 *   STRADDLE_TOGGLED / _POSTED
 *     Already bridged on 2026-09-08. Pinned below so the leg that works is
 *     not the one a later edit removes.
 *
 * WHY IT COULD NOT WORK. `this.emitEvent` inside each sub-engine is private
 * and calls the single constructor-supplied callback. Nothing in that callback
 * touched `this.hub`, and `hub.emitEvent` is the only path to a socket. No
 * client change could recover an event that never left the process.
 *
 * THE FIX IS A SECOND CONSUMER, NOT A DIFFERENT ONE: the accounting call and
 * the private pre-action frame are untouched; the hub broadcast is added
 * beside them, narrowed to the fields the client subscribers read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

type Emitted = Record<string, unknown>;

function harness(bank?: { remainingSeconds?: number; usesRemaining?: number }) {
  const engine = new ServerTableEngine(TABLE) as any;
  engine.engineTelemetry.dispose();
  engine.hub = { emitEvent: vi.fn(), sendToUser: vi.fn() };
  engine.timeBankEngine.configure(TABLE, { secondsPerUse: 20 });
  engine.timeBankEngine.initializePlayer(TABLE, 'u1', {
    remainingSeconds: bank?.remainingSeconds ?? 40,
    usesRemaining: bank?.usesRemaining ?? 2,
  });
  return engine;
}

/** Every payload the engine put on the hub, in order. */
const sent = (engine: any): Emitted[] => engine.hub.emitEvent.mock.calls.map((c: any[]) => c[1]);
const ofType = (engine: any, type: string): Emitted[] =>
  sent(engine).filter((p) => p.type === type);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a time bank that ends says so on the table hub', () => {
  it('broadcasts TIME_BANK_STOPPED when the player acts inside the bank', () => {
    const engine = harness();
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    engine.timeBankEngine.playerActed(TABLE, 'u1');

    const stopped = ofType(engine, 'time_bank_stopped');
    expect(stopped).toHaveLength(1);
    // The fields persistTimeBankState reads, with the engine's own numbers:
    // one 20s bank spent out of 40s / 2 uses.
    expect(stopped[0]).toMatchObject({
      type: 'time_bank_stopped',
      table_id: TABLE,
      tableId: TABLE,
      playerId: 'u1',
      secondsUsed: 20,
      remainingSeconds: 20,
      usesRemaining: 1,
    });
    engine.preciseTimer.dispose();
  });

  it('broadcasts TIME_BANK_EXPIRED when the bank runs out with uses left', () => {
    const engine = harness();
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    engine.timeBankEngine.onTimeBankExpired(TABLE, 'u1');

    expect(ofType(engine, 'time_bank_expired')).toHaveLength(1);
    expect(ofType(engine, 'time_bank_depleted')).toHaveLength(0);
    expect(ofType(engine, 'time_bank_expired')[0]).toMatchObject({
      playerId: 'u1',
      remainingSeconds: 20,
      usesRemaining: 1,
    });
    engine.preciseTimer.dispose();
  });

  it('broadcasts TIME_BANK_DEPLETED when that was the last one', () => {
    const engine = harness({ remainingSeconds: 20, usesRemaining: 1 });
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    engine.timeBankEngine.onTimeBankExpired(TABLE, 'u1');

    expect(ofType(engine, 'time_bank_depleted')).toHaveLength(1);
    expect(ofType(engine, 'time_bank_expired')).toHaveLength(0);
    expect(ofType(engine, 'time_bank_depleted')[0]).toMatchObject({
      playerId: 'u1',
      remainingSeconds: 0,
      usesRemaining: 0,
    });
    engine.preciseTimer.dispose();
  });

  it('still runs the database accounting it has always run', () => {
    const engine = harness();
    const accounting = vi.spyOn(engine, 'onTimeBankAccounting');
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    engine.timeBankEngine.playerActed(TABLE, 'u1');

    // The hub broadcast is an ADDITIONAL consumer. The accounting path that
    // was the only one before must still see every event, activation included.
    expect(accounting).toHaveBeenCalled();
    expect(accounting.mock.calls.map((c: any[]) => (c[0] as { type: string }).type)).toContain(
      'TIME_BANK_STOPPED'
    );
    engine.preciseTimer.dispose();
  });

  it('activation is not re-broadcast from here (ServerTableEngineTurns owns it)', () => {
    const engine = harness();
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    // Only the three terminal types are forwarded. A second activation frame
    // from this callback would double the client's reset of the turn clock.
    expect(ofType(engine, 'time_bank_activated')).toHaveLength(0);
    expect(ofType(engine, 'time_bank_refilled')).toHaveLength(0);
    engine.preciseTimer.dispose();
  });

  it('forwards nothing beyond the fields the client reads', () => {
    const engine = harness();
    engine.timeBankEngine.activate(TABLE, 'u1', () => {});
    engine.timeBankEngine.playerActed(TABLE, 'u1');

    // TimeBankEvent carries an open index signature; this frame goes to every
    // seat, so the forwarded object is named field by field rather than spread.
    expect(Object.keys(ofType(engine, 'time_bank_stopped')[0]).sort()).toEqual([
      'playerId',
      'remainingSeconds',
      'secondsUsed',
      'tableId',
      'table_id',
      'timestamp',
      'type',
      'usesRemaining',
    ]);
    engine.preciseTimer.dispose();
  });
});

describe('a pre-action that played itself says so on the table hub', () => {
  it('broadcasts PRE_ACTION_EXECUTED with the move that was made', () => {
    const engine = harness();
    engine.preActionEngine.setPreAction(TABLE, 'u1', 'auto_fold');
    expect(engine.preActionEngine.executePreAction(TABLE, 'u1', false, 100, 1000)).toMatchObject({
      executed: true,
      action: 'fold',
    });

    const executed = ofType(engine, 'pre_action_executed');
    expect(executed).toHaveLength(1);
    // useTableChat reads tableId, playerId and action to build the notice.
    expect(executed[0]).toMatchObject({
      table_id: TABLE,
      tableId: TABLE,
      playerId: 'u1',
      action: 'fold',
    });
    engine.preciseTimer.dispose();
  });

  it('never broadcasts what a player has merely ARMED', () => {
    const engine = harness();
    engine.preActionEngine.setPreAction(TABLE, 'u1', 'auto_call', undefined, 50);
    engine.preActionEngine.clearPreAction(TABLE, 'u1');
    engine.preActionEngine.setPreAction(TABLE, 'u1', 'auto_check');
    // A raise invalidates a check that is no longer free.
    engine.preActionEngine.onBetPlaced(TABLE, 'u2');

    // SET / CLEARED / INVALIDATED describe a decision that has NOT been played.
    // They go to the owning player's own sockets (pushPreActionToPlayer) and
    // must never reach the table: they are a read on an unmade decision.
    for (const t of ['pre_action_set', 'pre_action_cleared', 'pre_action_invalidated']) {
      expect(ofType(engine, t)).toHaveLength(0);
    }
    expect(engine.hub.sendToUser).toHaveBeenCalled();
    engine.preciseTimer.dispose();
  });

  it('forwards nothing beyond the fields the client reads', () => {
    const engine = harness();
    engine.preActionEngine.setPreAction(TABLE, 'u1', 'auto_fold');
    engine.preActionEngine.executePreAction(TABLE, 'u1', false, 100, 1000);
    expect(Object.keys(ofType(engine, 'pre_action_executed')[0]).sort()).toEqual([
      'action',
      'amount',
      'playerId',
      'tableId',
      'table_id',
      'timestamp',
      'type',
    ]);
    engine.preciseTimer.dispose();
  });
});

describe('a straddle stays on the table hub', () => {
  /* REGRESSION PIN, not a repair. This leg was bridged on 2026-09-08 and is
     asserted here because the client case that consumes it is new: if this
     broadcast is ever removed, the failure should name the straddle rather
     than surface as a chat line nobody notices is missing. */
  it('broadcasts STRADDLE_TOGGLED with the enrolment the player chose', () => {
    const engine = harness();
    engine.straddleEngine.configure(TABLE, {
      enabled: true,
      maxStraddles: 1,
      straddleMultiplier: 2,
    });
    engine.straddleEngine.toggleAutoStraddle(TABLE, 'u1', true);

    const toggled = ofType(engine, 'straddle_toggled');
    expect(toggled).toHaveLength(1);
    expect(toggled[0]).toMatchObject({ tableId: TABLE, playerId: 'u1', enabled: true });
    engine.preciseTimer.dispose();
  });
});
