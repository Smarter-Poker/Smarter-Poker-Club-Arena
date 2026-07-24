/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MULTI-ACCOUNT DETECTOR — device / IP / behavioral fingerprint clustering
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FOUNDATION MODULE — pure, deterministic, unit-tested. Clusters user accounts
 * that likely belong to the same physical person, based on:
 *   - HARD signals: shared device fingerprint, shared IP (or /24 subnet).
 *   - SOFT signal: behavioral vector cosine similarity (play-style fingerprint).
 *
 * Hard signals connect accounts via union-find; soft similarity above a
 * threshold also connects, and contributes to the cluster score. A behavioral
 * vector can be supplied directly or derived from hand data via
 * `deriveBehavioralProfiles`.
 *
 * Output feeds human review + the trust_score/AntiCheat seam (types.ts).
 * NOTE: raw device/IP fingerprints are NOT collected by this repo today — see
 * "NEEDS INFRA" in the delivery report (a fingerprint ingestion pipeline at
 * connect/auth time must populate AccountFingerprint.ip / deviceId).
 */

import { type IntegrityFlag, type NormalizedHand, severityFromScore } from './types.js';

/** Behavioral style vector (all rates 0..1 except avgLatencyMs). */
export interface BehavioralVector {
  vpip: number; // voluntarily put money in pot
  pfr: number; // preflop raise
  aggression: number; // (bet+raise)/(call) style ratio, normalized 0..1
  avgLatencyNorm: number; // normalized avg decision latency 0..1
}

export interface AccountFingerprint {
  userId: string;
  ip?: string | null;
  /** Stable device/browser fingerprint hash, if collected. */
  deviceId?: string | null;
  behavioral?: BehavioralVector | null;
}

export interface MultiAccountOptions {
  /** Cosine-similarity threshold on behavioral vectors to connect two accounts. */
  behavioralThreshold?: number;
  /** Treat shared /24 subnet as a (weaker) IP match. */
  matchSubnet?: boolean;
  /** Minimum cluster size to emit a flag. */
  minClusterSize?: number;
}

const DEFAULTS: Required<MultiAccountOptions> = {
  behavioralThreshold: 0.985,
  matchSubnet: true,
  minClusterSize: 2,
};

function subnet24(ip: string): string | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null; // IPv6 / malformed — skip subnet grouping
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

export function cosineSimilarity(a: BehavioralVector, b: BehavioralVector): number {
  const va = [a.vpip, a.pfr, a.aggression, a.avgLatencyNorm];
  const vb = [b.vpip, b.pfr, b.aggression, b.avgLatencyNorm];
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < va.length; i++) {
    dot += va[i] * vb[i];
    na += va[i] * va[i];
    nb += vb[i] * vb[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let root = x;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }
  union(x: string, y: string): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx !== ry) this.parent.set(rx, ry);
  }
}

/**
 * Derive behavioral profiles per user from hand data (soft fingerprint).
 * Latency is normalized against `latencyScaleMs` (default 30s) and clamped.
 */
export function deriveBehavioralProfiles(
  hands: NormalizedHand[],
  latencyScaleMs = 30_000
): Map<string, BehavioralVector> {
  interface Acc {
    handsSeen: Set<string>;
    vpipHands: Set<string>;
    pfrHands: Set<string>;
    aggressive: number; // bet+raise count
    passive: number; // call count
    latSum: number;
    latN: number;
  }
  const acc = new Map<string, Acc>();
  const get = (u: string): Acc => {
    let a = acc.get(u);
    if (!a) {
      a = {
        handsSeen: new Set(),
        vpipHands: new Set(),
        pfrHands: new Set(),
        aggressive: 0,
        passive: 0,
        latSum: 0,
        latN: 0,
      };
      acc.set(u, a);
    }
    return a;
  };

  for (const hand of hands) {
    for (const p of hand.players) if (p.userId) get(p.userId).handsSeen.add(hand.handId);
    for (const a of hand.actions) {
      if (!a.userId || a.forced) continue;
      const rec = get(a.userId);
      if (
        a.action === 'call' ||
        a.action === 'bet' ||
        a.action === 'raise' ||
        a.action === 'all_in'
      ) {
        rec.vpipHands.add(a.handId);
      }
      if (
        a.street === 'preflop' &&
        (a.action === 'raise' || a.action === 'bet' || a.action === 'all_in')
      ) {
        rec.pfrHands.add(a.handId);
      }
      if (a.action === 'bet' || a.action === 'raise' || a.action === 'all_in') rec.aggressive++;
      if (a.action === 'call') rec.passive++;
      if (a.latencyMs > 0) {
        rec.latSum += a.latencyMs;
        rec.latN++;
      }
    }
  }

  const out = new Map<string, BehavioralVector>();
  for (const [u, a] of acc) {
    const hn = Math.max(1, a.handsSeen.size);
    const avgLat = a.latN > 0 ? a.latSum / a.latN : 0;
    out.set(u, {
      vpip: a.vpipHands.size / hn,
      pfr: a.pfrHands.size / hn,
      aggression: a.aggressive + a.passive > 0 ? a.aggressive / (a.aggressive + a.passive) : 0,
      avgLatencyNorm: Math.min(1, avgLat / latencyScaleMs),
    });
  }
  return out;
}

/** Main entry: cluster fingerprints and emit one flag per multi-account cluster. */
export function detectMultiAccounts(
  fingerprints: AccountFingerprint[],
  opts: MultiAccountOptions = {}
): IntegrityFlag[] {
  const o = { ...DEFAULTS, ...opts };
  const uf = new UnionFind();
  for (const f of fingerprints) uf.find(f.userId);

  // Group accounts sharing hard signals.
  const byDevice = new Map<string, string[]>();
  const byIp = new Map<string, string[]>();
  const bySubnet = new Map<string, string[]>();
  for (const f of fingerprints) {
    if (f.deviceId) {
      const arr = byDevice.get(f.deviceId) ?? [];
      arr.push(f.userId);
      byDevice.set(f.deviceId, arr);
    }
    if (f.ip) {
      const arr = byIp.get(f.ip) ?? [];
      arr.push(f.userId);
      byIp.set(f.ip, arr);
      if (o.matchSubnet) {
        const sn = subnet24(f.ip);
        if (sn) {
          const sarr = bySubnet.get(sn) ?? [];
          sarr.push(f.userId);
          bySubnet.set(sn, sarr);
        }
      }
    }
  }
  const linkGroup = (group: string[]) => {
    for (let i = 1; i < group.length; i++) uf.union(group[0], group[i]);
  };
  for (const g of byDevice.values()) linkGroup(g);
  for (const g of byIp.values()) linkGroup(g);
  if (o.matchSubnet) for (const g of bySubnet.values()) linkGroup(g);

  // Behavioral soft links (pairwise cosine similarity).
  const behavioralPairs: { a: string; b: string; sim: number }[] = [];
  for (let i = 0; i < fingerprints.length; i++) {
    for (let j = i + 1; j < fingerprints.length; j++) {
      const fa = fingerprints[i];
      const fb = fingerprints[j];
      if (fa.behavioral && fb.behavioral) {
        const sim = cosineSimilarity(fa.behavioral, fb.behavioral);
        if (sim >= o.behavioralThreshold) {
          uf.union(fa.userId, fb.userId);
          behavioralPairs.push({ a: fa.userId, b: fb.userId, sim });
        }
      }
    }
  }

  // Collect clusters.
  const clusters = new Map<string, string[]>();
  for (const f of fingerprints) {
    const root = uf.find(f.userId);
    const arr = clusters.get(root) ?? [];
    arr.push(f.userId);
    clusters.set(root, arr);
  }

  const fpByUser = new Map(fingerprints.map((f) => [f.userId, f]));
  const flags: IntegrityFlag[] = [];
  for (const users of clusters.values()) {
    if (users.length < o.minClusterSize) continue;

    // Determine which signals bind this cluster.
    const ips = new Set<string>();
    const subnets = new Set<string>();
    const devices = new Set<string>();
    for (const u of users) {
      const f = fpByUser.get(u);
      if (f?.ip) {
        ips.add(f.ip);
        const sn = subnet24(f.ip);
        if (sn) subnets.add(sn);
      }
      if (f?.deviceId) devices.add(f.deviceId);
    }
    const sharedDevice = [...devices].some(
      (d) => users.filter((u) => fpByUser.get(u)?.deviceId === d).length > 1
    );
    const sharedIp = [...ips].some(
      (ip) => users.filter((u) => fpByUser.get(u)?.ip === ip).length > 1
    );
    const sharedSubnet =
      o.matchSubnet &&
      [...subnets].some(
        (sn) =>
          users.filter((u) => {
            const ip = fpByUser.get(u)?.ip;
            return ip ? subnet24(ip) === sn : false;
          }).length > 1
      );
    const clusterBehavioral = behavioralPairs.filter(
      (p) => users.includes(p.a) && users.includes(p.b)
    );

    const reasons = [];
    let score = 0;
    if (sharedDevice) {
      reasons.push({
        code: 'shared_device',
        detail: 'accounts share a device fingerprint',
        weight: 0.6,
      });
      score = Math.max(score, 0.9);
    }
    if (sharedIp) {
      reasons.push({ code: 'shared_ip', detail: 'accounts share an exact IP', weight: 0.4 });
      score = Math.max(score, 0.7);
    }
    if (sharedSubnet && !sharedIp) {
      reasons.push({ code: 'shared_subnet', detail: 'accounts share a /24 subnet', weight: 0.2 });
      score = Math.max(score, 0.45);
    }
    if (clusterBehavioral.length > 0) {
      const maxSim = Math.max(...clusterBehavioral.map((p) => p.sim));
      reasons.push({
        code: 'behavioral_match',
        detail: `play-style cosine similarity ${maxSim.toFixed(3)}`,
        weight: 0.4,
      });
      score = Math.max(
        score,
        0.4 + (0.5 * (maxSim - o.behavioralThreshold)) / (1 - o.behavioralThreshold)
      );
    }
    if (reasons.length === 0) continue;

    flags.push({
      type: 'multi_account',
      userIds: [...users].sort(),
      score: Math.min(1, score),
      severity: severityFromScore(Math.min(1, score)),
      reasons,
      handsAnalyzed: 0,
      evidence: {
        sharedDevice,
        sharedIp,
        sharedSubnet,
        devices: [...devices],
        ips: [...ips],
        behavioralPairs: clusterBehavioral.map((p) => ({
          pair: [p.a, p.b],
          sim: Number(p.sim.toFixed(4)),
        })),
      },
    });
  }
  return flags.sort((a, b) => b.score - a.score);
}
