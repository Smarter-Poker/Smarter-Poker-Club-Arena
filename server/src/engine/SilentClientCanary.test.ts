/**
 * ═══ THE SILENT-CLIENT CANARY (Dan 2026-08-31, phase 2) ══════════════════════
 *
 * On 2026-08-31 a player sat in seat 7 of a 9-max table and his own client
 * erased him from his screen. From the engine's side he was indistinguishable
 * from somebody who had walked away: heartbeat landing every five seconds,
 * turn timer expiring, three strikes, forced sit-out, and the five-minute
 * clock took the seat. He was at his desk the whole time.
 *
 * The engine cannot see a browser. But it can see a COMBINATION that a real
 * AFK human almost never produces:
 *
 *     connected  +  turns offered  +  never once acted, ever, at this table
 *
 * Somebody who plays and then wanders off has acted at least once. Somebody
 * whose client cannot show them the action never does. That is the whole
 * discrimination, and these tests pin it in BOTH directions — because a canary
 * that cries wolf is worse than none: it teaches people to ignore it.
 *
 * NOTE ON HORSES. There is no `is_horse` branch anywhere in this feature, and
 * these tests assert the reason: a horse acts through the same performAction
 * path as a human, so it sets `everActed` on its first decision and can never
 * trip the canary. The signal is behavioural rather than an identity test, so
 * the HORSES ARE PLAYERS law needs no exemption — a horse is measured by the
 * same yardstick as a human and passes it for the same reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const TABLE = 'table-1';
const PLAYER = 'player-1';

function makeEngine() {
  const timer = new PreciseActionTimer();
  const engine = new DisconnectEngine(timer);
  engine.registerPlayer(TABLE, PLAYER);
  return engine;
}

function stateOf(engine: DisconnectEngine) {
  const map = (engine as unknown as { playerStates: Map<string, unknown> }).playerStates;
  return map.get(`${TABLE}:${PLAYER}`) as never;
}

/** Drive the player to the strike cap the way a real table would. */
function timeOutToTheCap(engine: DisconnectEngine, offerTurns = true) {
  for (let i = 0; i < 3; i++) {
    if (offerTurns) engine.onPlayerTurn(TABLE, PLAYER, true);
    engine.recordConnectedTimeout(TABLE, PLAYER);
  }
}

describe('the canary fires for a broken client', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('connected, offered turns, never acted once - that is a client, not a person', () => {
    const engine = makeEngine();
    engine.onPlayerTurn(TABLE, PLAYER, true);
    engine.onPlayerTurn(TABLE, PLAYER, true);
    engine.onPlayerTurn(TABLE, PLAYER, true);

    const verdict = engine.reportSuspectedSilentClient(TABLE, PLAYER, stateOf(engine));
    expect(verdict.suspected).toBe(true);
    expect(verdict.reason).toMatch(/never acted/);
  });

  it('fires on the real ladder, at the moment of the forced sit-out', () => {
    // Not a unit-test-only path: it must trigger where the player is actually
    // condemned, which is exactly where nobody was told on 2026-08-31.
    const engine = makeEngine();
    const spy = vi.spyOn(engine, 'reportSuspectedSilentClient');
    timeOutToTheCap(engine);
    expect(spy).toHaveBeenCalled();
    expect(spy.mock.results.at(-1)?.value).toMatchObject({ suspected: true });
    // And the player is STILL sat out. Diagnosis must never change the
    // outcome: a broken client that could hold its seat forever is worse.
    expect(engine.isSittingOut(TABLE, PLAYER)).toBe(true);
  });
});

describe('BOTH doors are watched', () => {
  /* A player can be force-sat-out from TWO places: `recordConnectedTimeout`
     (the connected AFK ladder) and `executeAutoAction` (the disconnect
     countdown). The first cut of this feature wired the canary into one of
     them and stopped, which is how a diagnostic ends up quietly covering half
     of what it claims to. Found in the phase 2 audit; pinned here so nobody
     adds a third sentencing path without a canary in front of it. */
  it('every forced sit-out consults the canary first', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./DisconnectEngine.ts', import.meta.url), 'utf8');
    const parts = src.split("this.sitOut(tableId, playerId, 'forced')");
    expect(parts.length).toBeGreaterThanOrEqual(3); // 2 call sites -> 3 fragments
    for (let i = 0; i < parts.length - 1; i++) {
      const justBefore = parts[i].slice(-400);
      expect(justBefore).toMatch(/reportSuspectedSilentClient\(tableId, playerId, state\)/);
    }
  });
});

describe('the canary stays quiet for everything else', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('a player who has ever acted is an ordinary AFK, not a broken client', () => {
    const engine = makeEngine();
    engine.recordPlayerActed(TABLE, PLAYER); // played, then wandered off
    const spy = vi.spyOn(engine, 'reportSuspectedSilentClient');
    timeOutToTheCap(engine);
    expect(spy.mock.results.at(-1)?.value).toMatchObject({ suspected: false });
  });

  it('a DISCONNECTED player is the ordinary timeout ladder, not a canary case', () => {
    const engine = makeEngine();
    engine.markDisconnected(TABLE, PLAYER);
    const verdict = engine.reportSuspectedSilentClient(TABLE, PLAYER, stateOf(engine));
    expect(verdict.suspected).toBe(false);
    expect(verdict.reason).toMatch(/disconnected/);
  });

  it('a client that CONFIRMS it drew the action bar is believed', () => {
    // The discriminator the optional ack buys: the player was shown their
    // options and ignored them. Accusing their client would be crying wolf.
    const engine = makeEngine();
    engine.noteTurnRendered(TABLE, PLAYER);
    const spy = vi.spyOn(engine, 'reportSuspectedSilentClient');
    timeOutToTheCap(engine);
    expect(spy.mock.results.at(-1)?.value).toMatchObject({ suspected: false });
  });

  it('too few turns offered to judge - silence, not a guess', () => {
    const engine = makeEngine();
    engine.recordConnectedTimeout(TABLE, PLAYER); // one strike, no turns recorded
    const verdict = engine.reportSuspectedSilentClient(TABLE, PLAYER, stateOf(engine));
    expect(verdict.suspected).toBe(false);
    expect(verdict.reason).toMatch(/not enough turns/);
  });
});

describe('HORSES ARE PLAYERS - no exemption needed, and none present', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('a horse clears the canary the same way a human does: by acting', () => {
    /* A horse has no browser, but it does act — HorseLogic submits through
       scheduleHorseAction -> performAction -> recordPlayerActed, the identical
       path a human's tap takes. So it sets `everActed` on its first decision,
       and the canary is silent about it for exactly the reason it is silent
       about a human who has played: this seat has demonstrably acted. The test
       exists so nobody later "fixes" the canary with an is_horse branch, which
       the law forbids and which is unnecessary here. */
    const engine = makeEngine();
    engine.recordPlayerActed(TABLE, PLAYER); // stands in for any HorseLogic decision
    const spy = vi.spyOn(engine, 'reportSuspectedSilentClient');
    timeOutToTheCap(engine);
    expect(spy.mock.results.at(-1)?.value).toMatchObject({ suspected: false });
  });

  it('the canary contains no is_horse branch at all', async () => {
    const { readFileSync } = await import('fs');
    const src = readFileSync(new URL('./DisconnectEngine.ts', import.meta.url), 'utf8');
    const canary = src.slice(src.indexOf('reportSuspectedSilentClient('));
    expect(canary).not.toMatch(/is_horse|isHorse/);
  });
});
