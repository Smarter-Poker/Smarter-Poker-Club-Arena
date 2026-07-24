import { describe, it, expect } from 'vitest';
import {
  detectMultiAccounts,
  cosineSimilarity,
  deriveBehavioralProfiles,
  type AccountFingerprint,
  type BehavioralVector,
} from './MultiAccountDetector.js';
import type { NormalizedAction, NormalizedHand } from './types.js';

describe('cosineSimilarity', () => {
  it('identical vectors => 1', () => {
    const v: BehavioralVector = { vpip: 0.3, pfr: 0.2, aggression: 0.5, avgLatencyNorm: 0.1 };
    expect(cosineSimilarity(v, v)).toBeCloseTo(1);
  });
  it('orthogonal-ish vectors < 1', () => {
    const a: BehavioralVector = { vpip: 1, pfr: 0, aggression: 0, avgLatencyNorm: 0 };
    const b: BehavioralVector = { vpip: 0, pfr: 1, aggression: 0, avgLatencyNorm: 0 };
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

describe('detectMultiAccounts', () => {
  it('clusters accounts sharing a device fingerprint', () => {
    const fps: AccountFingerprint[] = [
      { userId: 'u1', ip: '10.0.0.1', deviceId: 'devA' },
      { userId: 'u2', ip: '10.0.0.2', deviceId: 'devA' },
      { userId: 'u3', ip: '55.66.77.88', deviceId: 'devB' },
    ];
    const flags = detectMultiAccounts(fps);
    expect(flags).toHaveLength(1);
    expect(flags[0].userIds).toEqual(['u1', 'u2']);
    expect(flags[0].reasons.map((r) => r.code)).toContain('shared_device');
    expect(flags[0].score).toBeGreaterThan(0.8);
  });

  it('clusters on exact shared IP', () => {
    const fps: AccountFingerprint[] = [
      { userId: 'a', ip: '203.0.113.7' },
      { userId: 'b', ip: '203.0.113.7' },
    ];
    const flags = detectMultiAccounts(fps);
    expect(flags).toHaveLength(1);
    expect(flags[0].reasons.map((r) => r.code)).toContain('shared_ip');
  });

  it('links via behavioral similarity above threshold', () => {
    const v: BehavioralVector = { vpip: 0.28, pfr: 0.18, aggression: 0.55, avgLatencyNorm: 0.12 };
    const fps: AccountFingerprint[] = [
      { userId: 'x', ip: '1.1.1.1', deviceId: 'd1', behavioral: v },
      { userId: 'y', ip: '2.2.2.2', deviceId: 'd2', behavioral: { ...v } },
    ];
    const flags = detectMultiAccounts(fps, { matchSubnet: false });
    expect(flags).toHaveLength(1);
    expect(flags[0].reasons.map((r) => r.code)).toContain('behavioral_match');
  });

  it('does NOT flag distinct, dissimilar accounts', () => {
    const fps: AccountFingerprint[] = [
      {
        userId: 'p1',
        ip: '11.0.0.1',
        deviceId: 'da',
        behavioral: { vpip: 0.5, pfr: 0.4, aggression: 0.7, avgLatencyNorm: 0.2 },
      },
      {
        userId: 'p2',
        ip: '99.0.0.2',
        deviceId: 'db',
        behavioral: { vpip: 0.1, pfr: 0.02, aggression: 0.05, avgLatencyNorm: 0.9 },
      },
    ];
    const flags = detectMultiAccounts(fps, { matchSubnet: false });
    expect(flags).toHaveLength(0);
  });

  it('shared /24 subnet is a weaker signal', () => {
    const fps: AccountFingerprint[] = [
      { userId: 's1', ip: '77.88.99.10' },
      { userId: 's2', ip: '77.88.99.20' },
    ];
    const flags = detectMultiAccounts(fps, { matchSubnet: true });
    expect(flags).toHaveLength(1);
    expect(flags[0].reasons.map((r) => r.code)).toContain('shared_subnet');
    expect(flags[0].score).toBeLessThan(0.6);
  });
});

describe('deriveBehavioralProfiles', () => {
  it('computes vpip/pfr/aggression from hands', () => {
    let s = 0;
    const a = (
      userId: string,
      action: NormalizedAction['action'],
      street: NormalizedAction['street']
    ): NormalizedAction => {
      s++;
      return {
        handId: 'h1',
        tableId: 't',
        userId,
        seat: 0,
        street,
        action,
        amount: action === 'fold' || action === 'check' ? 0 : 10,
        timestamp: s,
        latencyMs: 1000,
        forced: false,
      };
    };
    const hand: NormalizedHand = {
      handId: 'h1',
      tableId: 't',
      gameVariant: 'nlhe',
      smallBlind: 5,
      bigBlind: 10,
      potSize: 0,
      rake: 0,
      communityCards: [],
      startedAt: 0,
      endedAt: 0,
      players: [{ userId: 'hero', seat: 0, startingStack: 1000, cards: [] }],
      winners: [],
      actions: [a('hero', 'raise', 'preflop'), a('hero', 'bet', 'flop')],
    };
    const profiles = deriveBehavioralProfiles([hand]);
    const p = profiles.get('hero')!;
    expect(p.vpip).toBe(1); // voluntarily put money in
    expect(p.pfr).toBe(1); // raised preflop
    expect(p.aggression).toBe(1); // all aggressive actions
  });
});
