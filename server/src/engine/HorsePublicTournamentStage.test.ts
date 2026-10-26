import { describe, expect, it, vi } from 'vitest';
import {
  captureHorsePublicTournamentStage as capture,
  type HorsePublicTournamentReader,
} from './HorsePublicTournamentStage.js';
import { HandController } from './HandController.js';
import type { HandConfig, HandEvent, SeatPlayer } from '../types.js';
import type { TournamentBrainContext } from '../services/TournamentBrainContext.js';

function fixture() {
  const config: HandConfig = {
    tableId: 'stage-test',
    handNumber: 1,
    gameVariant: 'nlh',
    isTournament: true,
    smallBlind: 10,
    bigBlind: 20,
    ante: 2,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  // Only the public allowlist is populated; private cache fields throw if read.
  const context = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    format: 'mtt',
    entrants: 60,
    playersLeft: 4,
    spotsPaid: 3,
    seatsPerTable: 9,
    currentLevel: 5,
    currentSmallBlind: 10,
    currentBigBlind: 20,
    currentAnte: 2,
    anteType: 'per_player',
    inMoney: false,
    nearBubble: true,
    finalTable: true,
    handForHandExpected: true,
    onBreak: false,
    registrationOpen: false,
    lateRegistrationOpen: false,
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    mysteryBountyStage: 'none',
    satellite: false,
    satelliteSeats: 0,
  } as unknown as TournamentBrainContext;
  for (const key of [
    'reloadsByUser',
    'horseRebuyCapByUser',
    'addOnTakenByUser',
    'rebuyAffordableByUser',
    'addOnAffordableByUser',
    'stacks',
    'stackByUser',
    'bountyByUser',
  ]) {
    Object.defineProperty(context, key, {
      get() {
        throw Error('private cache read: ' + key);
      },
    });
  }
  const snapshot: ReturnType<HorsePublicTournamentReader> = {
    context,
    status: 'complete',
    issues: [],
    ageMs: 4.5,
  };
  return { config, context, snapshot, read: vi.fn(() => snapshot) };
}

describe('accepted public tournament stage', () => {
  it('freezes bounded public field/level/window facts without reading private cache data', () => {
    const h = fixture(),
      result = capture(h.config, h.read);
    expect(result).toMatchObject({
      status: 'captured',
      rules: 'tournament-stage-public-v1',
      ageMs: 4.5,
      playersLeft: 4,
      spotsPaid: 3,
      currentLevel: 5,
      nearBubble: true,
      handForHand: true,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/ByUser|Affordable|wallet|stacks|user_id/);
    h.context.playersLeft = 3;
    h.context.currentLevel = 6;
    expect(result).toMatchObject({ playersLeft: 4, currentLevel: 5 });
    expect(JSON.stringify(result).length).toBeLessThan(800);
  });

  it.each(['mtt', 'spin', 'sng', 'hu_sng'] as const)('retains exact %s format', (format) => {
    const h = fixture();
    h.context.format = format;
    expect(capture(h.config, h.read)).toMatchObject({ status: 'captured', format });
  });

  it('captures the canonical zero-based first blind level and refuses negative levels', () => {
    const h = fixture();
    h.context.currentLevel = 0;
    expect(capture(h.config, h.read)).toMatchObject({ status: 'captured', currentLevel: 0 });
    h.context.currentLevel = -1;
    expect(capture(h.config, h.read)).toMatchObject({
      status: 'unavailable',
      reason: 'invalid_public_context',
      detail: 'counts',
    });
  });

  it('keeps the dealt level when the cache advances to the immediately following level', () => {
    const h = fixture();
    h.context.previousLevel = {
      level: 4,
      smallBlind: 10,
      bigBlind: 20,
      ante: 2,
      durationMin: 10,
    };
    h.context.currentSmallBlind = 20;
    h.context.currentBigBlind = 40;
    h.context.currentAnte = 4;
    expect(capture(h.config, h.read)).toMatchObject({ status: 'captured', currentLevel: 4 });
    // Neither a nearby price nor a mismatched ante is this hand's exact level.
    h.context.previousLevel.bigBlind = 20.005;
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.previousLevel.bigBlind = 20;
    h.context.previousLevel.ante = 3;
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.previousLevel.ante = 2;
    h.context.previousLevel.smallBlind = 10.005;
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.previousLevel.smallBlind = 10;
    h.context.previousLevel.durationMin = null;
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    for (const duration of [undefined, NaN, 0, -1]) {
      h.context.previousLevel.durationMin = duration as number;
      expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    }
    h.context.previousLevel.durationMin = 10;
    h.context.previousLevel.level = -1;
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.previousLevel.level = h.context.currentLevel;
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.previousLevel.level = 4;
    h.context.anteType = 'big_blind';
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.anteType = 'per_player';
    h.context.contextIssues = ['missing_field'];
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'context_incomplete' });
  });

  it('does not read tournament cache for cash or treat a missing tournament as cash', () => {
    const h = fixture();
    expect(capture({ ...h.config, isTournament: false }, h.read)).toEqual({
      version: 1,
      status: 'not_applicable',
    });
    expect(h.read).not.toHaveBeenCalled();
    expect(capture(h.config)).toMatchObject({ status: 'unavailable', reason: 'context_missing' });
  });

  it.each(['warming', 'stale', 'incomplete'] as const)('excludes %s cache evidence', (status) => {
    const h = fixture();
    h.snapshot.status = status;
    expect(capture(h.config, h.read)).toMatchObject({
      status: 'unavailable',
      reason: 'context_' + status,
    });
  });

  it('keeps a failed metadata read from vetoing an accepted poker action', () => {
    const h = fixture();
    expect(
      capture(h.config, () => {
        throw Error('unavailable cache');
      })
    ).toMatchObject({ status: 'unavailable', reason: 'context_read_failed' });
  });

  it.each([NaN, -1, 60_001, null])('excludes invalid or stale age %s', (ageMs) => {
    const h = fixture();
    h.snapshot.ageMs = ageMs;
    expect(capture(h.config, h.read)).toMatchObject({ status: 'unavailable' });
  });

  it.each(['currentSmallBlind', 'currentBigBlind', 'currentAnte'] as const)(
    'does not relabel a hand from newer cached %s',
    (key) => {
      const h = fixture();
      h.context[key] *= 2;
      expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    }
  );

  it('names the failing check when the context is invalid', () => {
    const h = fixture();
    h.context.seatsPerTable = 11;
    expect(capture(h.config, h.read)).toMatchObject({
      reason: 'invalid_public_context',
      detail: 'capacity',
    });
    h.context.seatsPerTable = 3;
    h.context.playersLeft = 1;
    expect(capture(h.config, h.read)).toMatchObject({
      reason: 'invalid_public_context',
      detail: 'players_left',
    });
  });

  it('rejects inconsistent ante type, invalid field counts and incomplete source flags', () => {
    const h = fixture();
    h.context.anteType = 'big_blind';
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'hand_level_mismatch' });
    h.context.anteType = 'per_player';
    h.context.playersLeft = 61;
    expect(capture(h.config, h.read)).toMatchObject({
      reason: 'invalid_public_context',
      detail: 'counts',
    });
    h.context.playersLeft = 4;
    h.context.contextIssues = ['missing_field'];
    expect(capture(h.config, h.read)).toMatchObject({ reason: 'context_incomplete' });
  });

  it('reads only accepted actions and retains the earlier stage across later cache changes', () => {
    const h = fixture();
    const players: SeatPlayer[] = [1, 2, 3].map((seat) => ({
      seat,
      user_id: 'u' + seat,
      username: 'private',
      stack: 1000,
      bet: 0,
      totalInvested: 0,
      cards: [],
      is_folded: false,
      is_all_in: false,
      is_sitting_out: false,
    }));
    const c = new HandController(h.config, players, 1, h.read);
    const events: Extract<HandEvent, { type: 'PLAYER_ACTION' }>[] = [];
    c.onEvent((e) => {
      if (e.type === 'PLAYER_ACTION') events.push(e);
    });
    c.start();
    expect(h.read).not.toHaveBeenCalled();
    expect(c.performAction(2, 'call', undefined, 'player')).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
    expect(c.performAction(1, 'call', undefined, 'player')).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(1);
    h.context.playersLeft = 3;
    h.context.inMoney = true;
    h.context.nearBubble = false;
    expect(c.performAction(2, 'call', undefined, 'player')).toBe(true);
    expect(h.read).toHaveBeenCalledTimes(2);
    const first = events[0].publicNode,
      second = events[1].publicNode;
    if (first?.status !== 'captured' || second?.status !== 'captured')
      throw Error('missing public node');
    expect(first.tournamentStage).toMatchObject({ playersLeft: 4, inMoney: false });
    expect(second.tournamentStage).toMatchObject({ playersLeft: 3, inMoney: true });
    expect(c.getState().actionHistory.map((a) => a.publicNode)).toEqual(
      events.map((event) => event.publicNode)
    );
  });
});
