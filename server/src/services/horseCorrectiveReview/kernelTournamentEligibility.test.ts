import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import type { Card } from '../../types.js';
import { captureHorseTournamentPayoutTerms } from '../../engine/HorseTournamentPayoutTerms.js';
import { evidenceDigest } from './authority.js';
import { classifyTournamentRiverSnapshot } from './kernelTournamentEligibility.js';
const cards = (s: string): Card[] =>
  s.split(' ').map((c) => ({
    rank: c[0] as Card['rank'],
    suit: ({ s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' } as const)[c[1] as 's'],
  }));
function fixture(): any {
  const hero = {
    user_id: 'hero',
    username: 'Hero',
    seat: 1,
    stack: 80,
    bet: 10,
    totalInvested: 20,
    cards: cards('As Ah'),
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
  };
  const opponent = {
    ...hero,
    user_id: 'villain',
    seat: 2,
    stack: 0,
    bet: 30,
    totalInvested: 40,
    cards: [] as Card[],
    is_all_in: true,
  };
  const source = {
    version: 1,
    tournamentId: 'spin',
    cacheId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    readStartedAtMs: 90,
    readCompletedAtMs: 100,
    contextDigest: 'a'.repeat(64),
    contextStatus: 'complete',
    contextIssues: [],
  };
  const tournament = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    sourceAgeMs: 0,
    tournamentId: 'spin',
    tournamentStatus: 'RUNNING',
    gameVariant: 'nlh',
    tournamentType: 'SPIN',
    entrants: 3,
    playersLeft: 2,
    playersAtTable: 2,
    spotsPaid: 1,
    payoutPct: [100],
    registrationOpen: false,
    lateRegistrationOpen: false,
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    reentryAllowed: false,
    rebuyAllowed: false,
    addOnAvailable: false,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    satellite: false,
    bountyPoolCents: 0,
    onBreak: false,
    prizePoolCents: 10001,
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 0,
    stackByUser: { hero: 100, villain: 40 },
    stacks: [100, 40],
    ...captureHorseTournamentPayoutTerms(
      {
        id: 'spin',
        prize_pool_finalized: true,
        bubble_protection: false,
        payout_club: { asset: 'chips', is_platform: false, union_id: null },
        prize_pool: 100.01,
        buy_in_amount: 10,
        is_bounty: false,
        is_pko: false,
        is_mystery_bounty: false,
      },
      [{ place: 1, percentage: 100 }],
      3,
      false
    ),
    contextProvenance: {
      version: 1,
      readAtMs: 100,
      status: 'complete',
      issues: [],
      ageMs: 0,
      source,
      projection: {
        tableId: 'table',
        handNumber: 1,
        actorId: 'hero',
        actorSeat: 1,
        dealerSeat: 2,
        dealtSeatIds: [1, 2],
        smallBlind: 1,
        bigBlind: 2,
        ante: 0,
        gameVariant: 'nlh',
      },
    },
  };
  // Like the cache publication, bind the context including its captured payout
  // terms before adding decision provenance. This is a synthetic source
  // interval, never a signed qualification or an atomic database receipt.
  const { contextProvenance: _projection, ...capturedContext } = tournament;
  source.contextDigest = createHash('sha256').update(JSON.stringify(capturedContext)).digest('hex');
  return {
    version: 'horse-wta-spin-river-reference-v1',
    original: {
      readFrame: { publicReads: [] },
      snapshot: {
        type: 'DECIDE_FAST',
        requestId: 1,
        generation: 1,
        fence: 'table:1:1:river',
        decisionTimeMs: 100,
        decisionKey: 'test',
        player: hero,
        gameState: {
          stateSchemaVersion: 1,
          gameVariant: 'nlh',
          format: 'spin',
          gameMode: 'tournament',
          stage: 'river',
          bettingStructure: 'no_limit',
          asset: 'chips',
          chipUnit: 1,
          ante: 0,
          bigBlind: 2,
          dealerSeat: 2,
          heroSeat: 1,
          currentPlayerSeat: 1,
          players: [{ ...hero, cards: [] }, opponent],
          dealtSeatIds: [1, 2],
          pot: 60,
          currentBet: 30,
          toCall: 20,
          legalActions: ['fold', 'call'],
          communityCards: cards('2c 4d 7h 9s Jc'),
          tournament,
        },
      } as any,
    },
    range: [{ cards: cards('Ks Kh'), weight: 1 }],
    rangeReadFrameDigest: evidenceDigest({ publicReads: [] }),
  };
}

const snapshot = () => {
  const s = fixture().original.snapshot;
  s.gameState.boardCount = 1;
  return s;
};

describe('original NLH Spin WTA HU necessary family classification', () => {
  it('accepts the original helper-captured closed family without granting authority', () => {
    expect(classifyTournamentRiverSnapshot(snapshot())).toEqual({
      status: 'eligible',
    });
  });
  it('excludes known other domains and streets without treating them as missing evidence', () => {
    for (const change of [
      (s: any) => {
        s.gameState.format = 'cash';
        s.gameState.gameMode = 'cash';
      },
      (s: any) => {
        s.gameState.gameVariant = 'plo4';
      },
      (s: any) => {
        s.gameState.stage = 'turn';
      },
    ]) {
      const s = snapshot();
      change(s);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('excluded');
    }
  });
  it('distinguishes known unsupported geometry from malformed wager metadata', () => {
    for (const change of [
      (s: any) => {
        s.gameState.chipUnit = 0.01;
      },
      (s: any) => {
        s.gameState.asset = 'diamonds';
      },
      (s: any) => {
        s.gameState.ante = 1;
      },
      (s: any) => {
        s.gameState.players[1].is_all_in = false;
      },
      (s: any) => {
        s.gameState.toCall = s.player.stack;
      },
      (s: any) => {
        s.gameState.players[0].deadInvested = 1;
      },
    ]) {
      const s = snapshot();
      change(s);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('excluded');
    }
    for (const change of [
      (s: any) => {
        delete s.gameState.chipUnit;
      },
      (s: any) => {
        delete s.gameState.ante;
      },
      (s: any) => {
        s.gameState.ante = -1;
      },
      (s: any) => {
        s.gameState.toCall = -1;
      },
      (s: any) => {
        s.gameState.pot = 61;
      },
      (s: any) => {
        s.gameState.players[0].stack = NaN;
      },
    ]) {
      const s = snapshot();
      change(s);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('gap');
    }
  });
  it('requires every closed lifecycle and special-objective flag explicitly false', () => {
    const flags = [
      'registrationOpen',
      'lateRegistrationOpen',
      'reentryOpen',
      'rebuyOpen',
      'addOnPeriodOpen',
      'reentryAllowed',
      'rebuyAllowed',
      'addOnAvailable',
      'isPko',
      'isBounty',
      'isMysteryBounty',
      'satellite',
      'onBreak',
    ];
    for (const key of flags) {
      const open = snapshot();
      open.gameState.tournament[key] = true;
      expect(classifyTournamentRiverSnapshot(open).status, key).toBe('excluded');
      const absent = snapshot();
      delete absent.gameState.tournament[key];
      expect(classifyTournamentRiverSnapshot(absent).status, key).toBe('gap');
    }
  });
  it('excludes a genuinely observed unfinalized pool while legacy/unknown terms remain gaps', () => {
    const open = snapshot();
    Object.assign(
      open.gameState.tournament,
      captureHorseTournamentPayoutTerms(
        {
          id: 'spin',
          prize_pool_finalized: false,
          bubble_protection: false,
          payout_club: { asset: 'chips', is_platform: false, union_id: null },
          prize_pool: 100.01,
        },
        [{ place: 1, percentage: 100 }],
        3,
        false
      )
    );
    delete open.gameState.tournament.finalizedPrizeLadder;
    expect(classifyTournamentRiverSnapshot(open)).toEqual({
      status: 'excluded',
      reason: 'prize_pool_not_finalized',
    });
    for (const key of [
      'payoutTermsVersion',
      'prizePoolFinalized',
      'prizeUnitCents',
      'finalizedPrizeLadder',
    ]) {
      const s = snapshot();
      delete s.gameState.tournament[key];
      expect(classifyTournamentRiverSnapshot(s).status, key).toBe('gap');
    }
  });
  it('rejects malformed ladder commitments and original funded-pool mismatch as gaps', () => {
    for (const change of [
      (t: any) => {
        t.finalizedPrizeLadder.sourceDigest = 'b'.repeat(64);
      },
      (t: any) => {
        t.prizePoolCents++;
      },
      (t: any) => {
        t.finalizedPrizeLadder.prizesCents[0]--;
      },
      (t: any) => {
        t.prizeUnitCents = 0;
      },
    ]) {
      const s = snapshot();
      change(s.gameState.tournament);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('gap');
    }
  });
  it('requires exact complete, timely original provenance rather than legacy compatibility', () => {
    for (const change of [
      (s: any) => {
        delete s.gameState.tournament.contextProvenance;
      },
      (s: any) => {
        s.gameState.tournament.contextProvenance.source = null;
      },
      (s: any) => {
        s.gameState.tournament.contextProvenance.projection.actorId = 'other';
      },
      (s: any) => {
        s.decisionTimeMs = 100000;
      },
      (s: any) => {
        s.gameState.tournament.contextProvenance.source.readCompletedAtMs = 101;
      },
    ]) {
      const s = snapshot();
      change(s);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('gap');
    }
  });
  it('requires the complete original field stack map and exact funded conservation', () => {
    for (const change of [
      (t: any) => {
        delete t.stackByUser;
      },
      (t: any) => {
        t.stackByUser.hero++;
      },
      (t: any) => {
        delete t.stackByUser.villain;
      },
      (t: any) => {
        t.stacks = [100, 41];
      },
      (t: any) => {
        t.stackByUser.third = 1;
      },
    ]) {
      const s = snapshot();
      change(s.gameState.tournament);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('gap');
    }
  });
  it('does not exclude missing payout, unit or stack data as a model-unavailable shortcut', () => {
    for (const change of [
      (s: any) => {
        delete s.gameState.tournament.payoutPct;
      },
      (s: any) => {
        delete s.gameState.tournament.contextStatus;
      },
      (s: any) => {
        delete s.gameState.players[1].totalInvested;
      },
      (s: any) => {
        s.gameState.players[1].is_all_in = true;
        s.gameState.players[1].stack = 1;
      },
      (s: any) => {
        delete s.gameState.asset;
      },
    ]) {
      const s = snapshot();
      change(s);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('gap');
    }
  });
  it('leaves original capture bytes unchanged and returns only finite classification facts', () => {
    const s = snapshot(),
      before = JSON.stringify(s);
    const result = classifyTournamentRiverSnapshot(s);
    expect(JSON.stringify(s)).toBe(before);
    expect(Object.keys(result)).toEqual(['status']);
    expect(classifyTournamentRiverSnapshot(null)).toEqual({
      status: 'gap',
      reason: 'original_snapshot_missing',
    });
  });
});

function setCurve(
  s: any,
  format: string,
  pct: number[],
  pool = 10001,
  entrants = Math.max(3, pct.length)
) {
  const g = s.gameState,
    t = g.tournament;
  g.format = format;
  t.tournamentType = format === 'spin' ? 'SPIN' : format === 'mtt' ? 'MTT' : 'SNG';
  t.entrants = entrants;
  t.spotsPaid = pct.filter((p) => p > 0).length;
  t.payoutPct = [...pct];
  t.prizePoolCents = pool;
  Object.assign(
    t,
    captureHorseTournamentPayoutTerms(
      {
        id: t.tournamentId,
        prize_pool_finalized: true,
        bubble_protection: false,
        payout_club: { asset: 'chips', is_platform: false, union_id: null },
        prize_pool: pool / 100,
        buy_in_amount: 10,
        is_bounty: false,
        is_pko: false,
        is_mystery_bounty: false,
      },
      pct.map((percentage, i) => ({ place: i + 1, percentage })),
      entrants,
      false
    )
  );
  const { contextProvenance, ...captured } = t;
  contextProvenance.source.contextDigest = createHash('sha256')
    .update(JSON.stringify(captured))
    .digest('hex');
}

describe('closed HU full original ladder classification', () => {
  it.each(['mtt', 'sng', 'hu_sng'])('accepts %s with full payouts', (format) => {
    const s = snapshot();
    setCurve(s, format, [60, 30, 10]);
    expect(classifyTournamentRiverSnapshot(s)).toEqual({ status: 'eligible' });
  });
  it('accepts bounded zero tails beyond ten places and canonical increasing prizes', () => {
    const spin = snapshot();
    setCurve(spin, 'spin', [100, ...Array(11).fill(0)]);
    expect(classifyTournamentRiverSnapshot(spin)).toEqual({ status: 'eligible' });
    const hu = snapshot();
    setCurve(hu, 'hu_sng', [49.99, 50.01]);
    expect(hu.gameState.tournament.finalizedPrizeLadder.prizesCents).toEqual([4999, 5002]);
    expect(classifyTournamentRiverSnapshot(hu)).toEqual({ status: 'eligible' });
  });
  it('keeps unknown entrants, sparse curves and cross-family identity as gaps', () => {
    for (const mutate of [
      (s: any) => delete s.gameState.tournament.entrants,
      (s: any) => delete s.gameState.tournament.payoutPct[1],
      (s: any) => (s.gameState.tournament.tournamentType = 'SPIN'),
    ]) {
      const s = snapshot();
      setCurve(s, 'mtt', [60, 30, 10]);
      mutate(s);
      expect(classifyTournamentRiverSnapshot(s).status).toBe('gap');
    }
  });
});

it('accepts a canonical captured general ladder despite binary percentage-sum imprecision', () => {
  const s = snapshot();
  setCurve(s, 'mtt', [0.1, 64.1, 35.8], 10000);
  const t = s.gameState.tournament;
  expect(t.payoutPct.reduce((a: number, b: number) => a + b, 0)).not.toBe(100);
  expect(t.finalizedPrizeLadder.prizesCents).toEqual([10, 6410, 3580]);
  expect(classifyTournamentRiverSnapshot(s)).toEqual({ status: 'eligible' });
});
