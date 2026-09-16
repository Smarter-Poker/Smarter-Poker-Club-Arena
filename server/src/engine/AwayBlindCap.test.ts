/**
 * AWAY-BLIND CAP — Dan 2026-08-23
 *
 * "IF A PLAYER IS AWAY FROM THE CASH GAME TABLE, ONCE THEY LOSE ONE BB AND
 *  ONE SB, THEY MUST BE AUTO REMOVED FROM THE TABLE. YOU CAN'T KEEP BLINDING
 *  OUT A PLAYER WHO HAS DISCONNECTED OR HAS ANY OTHER ISSUES CONNECTING."
 *
 * The rule has two halves and both matter. A present player must be blinded
 * normally forever — that is poker — and an away player at most twice. Most
 * of the tests below pin the FIRST half, because the failure mode of a cap
 * like this is not that it fails to fire, it is that it fires on somebody
 * who never went anywhere.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DisconnectEngine } from './DisconnectEngine.js';
import { PreciseActionTimer } from './PreciseActionTimer.js';

const TABLE = 'table-1';
const PLAYER = 'player-1';

describe('away-blind cap', () => {
  let eng: DisconnectEngine;

  beforeEach(() => {
    eng = new DisconnectEngine(new PreciseActionTimer());
    eng.registerPlayer(TABLE, PLAYER);
  });

  // ── The cap must never touch a player who is present ─────────────────────

  it('does not count blinds for a connected, acting player', () => {
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('does not evict on one blind alone', () => {
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('does not evict on the same blind charged twice', () => {
    // A re-deal, or a hand voided and dealt again, must not spend both slots
    // of the budget on one kind of blind.
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  // ── The cap must fire for each way of being away ─────────────────────────

  it('evicts a DISCONNECTED player after one SB and one BB', () => {
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('one timeout alone is NOT away - present players tank and misclick', () => {
    eng.recordConnectedTimeout(TABLE, PLAYER);
    expect(eng.isAway(TABLE, PLAYER)).toBe(false);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('evicts an AFK player - connected but timing out twice - after one SB and one BB', () => {
    eng.recordConnectedTimeout(TABLE, PLAYER);
    eng.recordConnectedTimeout(TABLE, PLAYER); // nobody home
    expect(eng.isAway(TABLE, PLAYER)).toBe(true);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('evicts a player who left the page/app after one SB and one BB', () => {
    eng.markPageLeft(TABLE, PLAYER);
    expect(eng.isAway(TABLE, PLAYER)).toBe(true);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
  });

  it('markPageLeft concludes immediately - no transport grace window', () => {
    // markTransportGone only opens an 8s window. An explicit "I am leaving"
    // must not wait, or the first blind after the tab closes goes uncounted.
    eng.markPageLeft(TABLE, PLAYER);
    expect(eng.isConnected(TABLE, PLAYER)).toBe(false);
  });

  // ── Coming back must refund the budget ───────────────────────────────────

  it('a heartbeat after a disconnect clears the charges', () => {
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.heartbeat(TABLE, PLAYER);
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    // The second absence starts fresh: one blind this time, no eviction.
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('a heartbeat clears the page-left flag even with no disconnect edge', () => {
    // pagehide → resume never opens a disconnect, so there is no
    // wasDisconnected edge to hang the reset on. A stale flag here would keep
    // charging blinds against somebody sitting right there.
    eng.markPageLeft(TABLE, PLAYER);
    eng.heartbeat(TABLE, PLAYER);
    expect(eng.isAway(TABLE, PLAYER)).toBe(false);
  });

  it('acting voluntarily clears the charges', () => {
    eng.recordConnectedTimeout(TABLE, PLAYER);
    eng.recordConnectedTimeout(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.recordPlayerActed(TABLE, PLAYER);
    expect(eng.isAway(TABLE, PLAYER)).toBe(false);
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('never evicts a player who came back after the budget was spent', () => {
    // The flags say the budget is gone, but presence is re-checked at the
    // moment of the sweep and wins. This is the reconnect race: a heartbeat
    // landing microseconds before the dealing loop reads the list must not
    // cash somebody out of a table they are actively sitting at.
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
    eng.heartbeat(TABLE, PLAYER);
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  it('sitting back in clears the charges', () => {
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.sitOut(TABLE, PLAYER, 'forced');
    eng.sitBack(TABLE, PLAYER);
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  // ── Sit-out is a separate regime with its own rule ───────────────────────

  it('a sitting-out player is not "away" - sit-out has its own eviction rule', () => {
    // A sat-out cash player is not dealt in at all, so they pay nothing and
    // the blind cap has no job here. Their removal is the 2-hand / 5-minute
    // timer in tickSitOutsAndCollectEvictions.
    eng.sitOut(TABLE, PLAYER, 'voluntary');
    expect(eng.isAway(TABLE, PLAYER)).toBe(false);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([]);
  });

  // ── Multi-tabling isolation ──────────────────────────────────────────────

  it('is scoped per table - being away here does not evict a seat elsewhere', () => {
    const OTHER = 'table-2';
    eng.registerPlayer(OTHER, PLAYER);
    eng.markDisconnected(TABLE, PLAYER);
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'sb');
    eng.noteBlindChargedWhileAway(TABLE, PLAYER, 'bb');
    expect(eng.collectAwayBlindEvictions(TABLE, [PLAYER])).toEqual([PLAYER]);
    expect(eng.collectAwayBlindEvictions(OTHER, [PLAYER])).toEqual([]);
  });

  it('ignores players it has never seen', () => {
    expect(eng.isAway(TABLE, 'ghost')).toBe(false);
    expect(eng.collectAwayBlindEvictions(TABLE, ['ghost'])).toEqual([]);
  });
});
