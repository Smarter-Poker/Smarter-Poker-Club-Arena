/**
 * A HEARTBEAT IS PROOF OF A SOCKET, NOT PROOF OF A PLAYER.
 * ============================================================================
 * The away-blind budget is two slots - one small blind and one big blind. Spend
 * both while away and the seat is stood up and cashed out. It is the only rule
 * that eventually frees a seat whose player is gone but who keeps being dealt
 * in, so whatever refunds it decides whether that seat is ever freed.
 *
 * DisconnectEngine used to refund it - and reset the consecutive-timeout ladder
 * with it - on every reconnect EDGE. The reasoning was "the blind cap is a
 * budget for ONE absence, they came back."
 *
 * A backgrounded mobile client produces one of those edges per orbit. The
 * socket dies when the tab is frozen and a beat lands when the OS wakes it, and
 * neither event involves the person. So the budget was zeroed several times an
 * hour, could never hold one SB AND one BB at the same time, and the seat was
 * auto-folded every single hand, for ever, was never sat out, never evicted,
 * and kept posting blinds the whole time.
 *
 * Both budgets are spent by ABSENCE and refunded by PRESENCE, and only a
 * voluntary action proves presence. This pins both halves of that, because
 * pinning only the first would let somebody "fix" it by never refunding at all,
 * which evicts players who really did come back and play.
 *
 * This file exists because the fix shipped once, on 2026-09-09, and was lost on
 * 2026-09-16 when ea498c1fab returned the repository to its September 13 state.
 * Nothing failed when it went. That is what a test is for.
 */

import { describe, it, expect } from 'vitest';
import { DisconnectEngine } from '../../server/src/engine/DisconnectEngine';
import { PreciseActionTimer } from '../../server/src/engine/PreciseActionTimer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TABLE = 'table-1';
const PLAYER = 'player-1';

function seated() {
  const engine = new DisconnectEngine(new PreciseActionTimer());
  engine.registerPlayer(TABLE, PLAYER);
  return engine;
}

/** One orbit of a frozen tab: the socket dies, a blind is taken, the OS wakes it. */
function anOrbitAway(engine: DisconnectEngine, blind: 'sb' | 'bb') {
  engine.markDisconnected(TABLE, PLAYER);
  engine.noteBlindChargedWhileAway(TABLE, PLAYER, blind);
  engine.heartbeat(TABLE, PLAYER);
}

describe('a reconnect is not a refund', () => {
  it('spends the away-blind budget across separate absences', () => {
    const engine = seated();

    // Two orbits, one blind each, with a reconnect edge between them and no
    // voluntary action anywhere. This is the frozen phone, exactly.
    anOrbitAway(engine, 'sb');
    anOrbitAway(engine, 'bb');

    // Away again for the sweep - presence wins at the moment of the decision,
    // so the eviction is only ever asked about a seat that is currently gone.
    engine.markDisconnected(TABLE, PLAYER);

    expect(engine.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('refunds the budget when the player actually acts', () => {
    const engine = seated();

    anOrbitAway(engine, 'sb');
    // A deliberate action is the strongest proof of presence there is, and it
    // outranks a missing heartbeat. This is what a refund is for.
    engine.recordPlayerActed(TABLE, PLAYER);
    anOrbitAway(engine, 'bb');
    engine.markDisconnected(TABLE, PLAYER);

    expect(engine.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('does not evict a seat that has spent only one of the two slots', () => {
    const engine = seated();
    anOrbitAway(engine, 'sb');
    engine.markDisconnected(TABLE, PLAYER);
    expect(engine.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('never evicts a player who is present at the sweep', () => {
    const engine = seated();
    anOrbitAway(engine, 'sb');
    anOrbitAway(engine, 'bb');
    // Still connected: the budget is spent, but they are here.
    expect(engine.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });
});

describe('the protection deadline is spent on the hand it was granted for', () => {
  it('clears a returned seat s grant at the hand boundary, and keeps an absent one s', () => {
    // `reconnectDeadlineMs` is an ABSOLUTE instant. It used to be cleared in
    // exactly one place - recordPlayerActed - so a player who dropped and came
    // back WITHOUT acting carried an already-expired instant into every later
    // hand, and the turn path force-folded them the moment the socket returned,
    // on a hand they were present for with the full clock unspent.
    //
    // A completed hand ends the decision the grant was protecting - but only
    // for a seat that is actually back. A seat still away is mid-absence and
    // must keep counting down the window it was given.
    const text = readFileSync(
      resolve(__dirname, '..', '..', 'server', 'src', 'engine', 'DisconnectEngine.ts'),
      'utf8'
    );
    // Anchored on the DECLARATION, not the first mention - the name also
    // appears in a comment further up, and slicing from there reads the wrong
    // method entirely. `reconnectDeadlineMs` has no public reader, so this is
    // a source-shape guard rather than a behavioural one, and it says so.
    const decl = text.indexOf('cancelAllCountdowns(tableId: string): void {');
    expect(decl).toBeGreaterThan(-1);
    const boundary = text.slice(decl);
    const block = boundary.slice(0, boundary.indexOf('\n  }'));

    expect(block).toMatch(/state\.isConnected === true/);
    expect(block).toMatch(/state\.reconnectDeadlineMs = undefined/);
    expect(block).toMatch(/state\.reconnectGrantedAtMs = undefined/);
  });
});
