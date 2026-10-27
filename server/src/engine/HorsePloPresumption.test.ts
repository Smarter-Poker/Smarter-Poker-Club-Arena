/**
 * 2026-10-25. Two read changes, pinned against production counters (read
 * from horse_exploit_profiles, SELECT only, 2026-10-25):
 *
 * 1. A KNOWN MANIAC IS A MANIAC AT EVERY TABLE SIZE. WooWoo's PLO5 full-ring
 *    read engaged and his 3-5 handed read did not, so every V53 pressure line
 *    was off at the tables where he made most of his money.
 * 2. PLO: EVERY PERSON IS AN AGGRESSIVE RAISER UNTIL PROVEN OTHERWISE (Dan:
 *    "TAG THEM ALL FROM THE START, UNLESS OTHERWISE PROVEN DIFFERENTLY",
 *    "FOR PLO, NOT FOR HOLDEM").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HorseMind } from './HorseMind.js';
import {
  aggressiveBettorPressure,
  aggressiveOpenerPressure,
  corroborationCandidate,
  decayAndAdd,
  exploitHandIncrements,
  freshExploitCounters,
  maniacRaiseWidth,
  opponentExploitRead,
  presumedAggressorRead,
  PRESUMPTION_PROOF_MIN_OPPS,
  type ExploitCounters,
} from './HorseOpponentExploit.js';
import type { DurableOpponentProfile, MemorySize } from './HorseOpponentMemory.js';

const WOOWOO_PLO5_FULL = {
  pfr: 30.6758829756985,
  rfi: 12.3664281111518,
  fPfr: 9.24485409690811,
  fRfi: 2.84383973648686,
  vpip: 37.545917079809,
  hands: 43.782775674154,
  fHands: 12.0487797070162,
  rfiOpp: 16.7602540640735,
  fRfiOpp: 3.7586429806456,
  threeBet: 18.2487164389222,
  fThreeBet: 6.40100976615476,
  foldToBet: 11.8612323119353,
  riverCall: 1.41915374224858,
  fFoldToBet: 3.17847826883145,
  fRiverCall: 0.843786341660337,
  foldTo3Bet: 0,
  threeBetOpp: 23.9332383224744,
  betCheckedTo: 34.6852688886682,
  fThreeBetOpp: 7.3661209824145,
  foldToBetOpp: 24.1571365943623,
  riverCallOpp: 3.63119861076109,
  fBetCheckedTo: 13.9431545881804,
  fFoldToBetOpp: 6.33749527264656,
  fRiverCallOpp: 1.5556882139609,
  foldTo3BetOpp: 6.07266460184681,
  betCheckedToOpp: 77.521816892402,
  fBetCheckedToOpp: 23.9218044596203,
} as unknown as ExploitCounters;
const WOOWOO_PLO5_SHORT = {
  pfr: 23.5243165533406,
  rfi: 16.5384222711879,
  fPfr: 6.18731804522948,
  fRfi: 4.5152185951703,
  vpip: 33.0126559746372,
  hands: 43.782748426773,
  fHands: 12.0487797070167,
  rfiOpp: 21.7059446820649,
  fRfiOpp: 6.89931888867823,
  threeBet: 6.73670337588458,
  fThreeBet: 1.66976278754142,
  foldToBet: 14.0219948187606,
  riverCall: 0.451728919559142,
  fFoldToBet: 4.15601276961271,
  fRiverCall: 0.000996504863677911,
  foldTo3Bet: 0.0103086555529133,
  threeBetOpp: 17.5013894145435,
  betCheckedTo: 20.8575858098284,
  fThreeBetOpp: 4.97217818743259,
  foldToBetOpp: 24.7984512302924,
  riverCallOpp: 5.16745426348706,
  fBetCheckedTo: 6.34635999811446,
  fFoldToBetOpp: 5.96342407535618,
  fRiverCallOpp: 1.82098834918276,
  foldTo3BetOpp: 4.58538656767185,
  betCheckedToOpp: 53.3441833474992,
  fBetCheckedToOpp: 13.4709191361878,
} as unknown as ExploitCounters;
/** A real person who raises almost nothing (kingfish, PLO5 full ring). */
const TIGHT_PLO5_FULL = {
  pfr: 1.42849497681666,
  rfi: 0.748636918238457,
  fPfr: 0.00136622707219613,
  fRfi: 0.000584912116753355,
  vpip: 3.0642098996961,
  hands: 42.996945314018,
  fHands: 12.0487762908374,
  rfiOpp: 9.34077843960388,
  fRfiOpp: 2.24879668602985,
  threeBet: 0.67985805857822,
  fThreeBet: 0.000781314955442773,
  foldToBet: 0.733310808514174,
  riverCall: 0.0462842985089553,
  fFoldToBet: 0.000943484322814256,
  fRiverCall: 0.00000989410060616312,
  foldTo3Bet: 0,
  threeBetOpp: 31.4065041793351,
  betCheckedTo: 1.28758357020857,
  fThreeBetOpp: 9.66340433269575,
  foldToBetOpp: 1.76955229013911,
  riverCallOpp: 0.197341077933646,
  fBetCheckedTo: 0.000769935592663819,
  fFoldToBetOpp: 0.0017694405886163,
  fRiverCallOpp: 0.000171618081172328,
  foldTo3BetOpp: 0.216272463652861,
  betCheckedToOpp: 4.63033428580098,
  fBetCheckedToOpp: 0.00454737562980521,
} as unknown as ExploitCounters;

const HUMAN = '40000000-0000-4000-8000-00000000c0de';
const HORSE = '40000000-0000-4000-8000-00000000f00d';

function remember(
  id: string,
  variant: DurableOpponentProfile['variant'],
  size: MemorySize,
  counters: ExploitCounters
) {
  HorseMind.importDurableOpponentProfiles([
    {
      user_id: id,
      variant,
      mode: 'cash',
      size,
      observed_hands: 300,
      initialized: true,
      counters,
    },
  ]);
}
/** A seat that has only ever limped and called: horse-like raising, played many hands. */
function caller(id: string, hands: number): ExploitCounters {
  const c = freshExploitCounters();
  const inc = exploitHandIncrements([{ userId: id, action: 'call', stage: 'preflop' }]).get(id)!;
  for (let n = 0; n < hands; n++) decayAndAdd(c, inc);
  return c;
}

afterEach(() => {
  HorseMind.setDecisionScope(null);
  HorseMind.reset();
});

describe('a known maniac is a maniac at every table size', () => {
  it('production: WooWoo 3-5 handed engages only with his full-ring read behind it', () => {
    const full = opponentExploitRead(WOOWOO_PLO5_FULL, 'omaha:full', 'plo5');
    expect(maniacRaiseWidth(full)).not.toBeNull();
    const alone = opponentExploitRead(WOOWOO_PLO5_SHORT, 'omaha:short', 'plo5');
    expect(maniacRaiseWidth(alone)).toBeNull();
    expect(aggressiveBettorPressure(alone)).toBeNull();
    expect(corroborationCandidate(WOOWOO_PLO5_SHORT, 'omaha:short', 'plo5')).toBe(true);

    const backed = opponentExploitRead(WOOWOO_PLO5_SHORT, 'omaha:short', 'plo5', [full]);
    expect(backed?.corroborated).toEqual(expect.arrayContaining(['pfr', 'threeBet']));
    expect(maniacRaiseWidth(backed)).toBeGreaterThan(0.45);
    expect(aggressiveBettorPressure(backed)).not.toBeNull();
    expect(aggressiveOpenerPressure(backed, true)).not.toBeNull();
  });

  it('a sibling never engages a statistic this size does not already place past every horse', () => {
    const full = opponentExploitRead(WOOWOO_PLO5_FULL, 'omaha:full', 'plo5');
    const ordinary = caller(HUMAN, 60);
    expect(corroborationCandidate(ordinary, 'omaha:short', 'plo5')).toBe(false);
    // It still reads as the loose caller its own hands show; nothing is added.
    const read = opponentExploitRead(ordinary, 'omaha:short', 'plo5', [full]);
    expect(read).toEqual(opponentExploitRead(ordinary, 'omaha:short', 'plo5'));
    expect(read?.corroborated).toBeUndefined();
    expect(maniacRaiseWidth(read)).toBeNull();
  });

  it('the live read borrows the sibling size from memory for every player', () => {
    remember(HUMAN, 'plo5', 'full', WOOWOO_PLO5_FULL);
    remember(HUMAN, 'plo5', 'short', WOOWOO_PLO5_SHORT);
    HorseMind.setDecisionScope('omaha:short', 'plo5', 'cash');
    expect(maniacRaiseWidth(HorseMind.opponentRead(HUMAN))).not.toBeNull();
    // The same counters seated at a horse's seat read identically: the
    // corroboration is about play, not about who plays.
    remember(HORSE, 'plo5', 'full', WOOWOO_PLO5_FULL);
    remember(HORSE, 'plo5', 'short', WOOWOO_PLO5_SHORT);
    expect(maniacRaiseWidth(HorseMind.opponentRead(HORSE))).not.toBeNull();
  });
});

describe('PLO: every opponent is an aggressive raiser until proven otherwise', () => {
  it('a brand-new opponent is a pressure target from the first hand at every PLO size', () => {
    for (const variant of ['plo4', 'plo5', 'plo6', 'plo8']) {
      for (const scope of ['omaha:hu', 'omaha:short', 'omaha:full'] as const) {
        HorseMind.setDecisionScope(scope, variant, 'cash', [HUMAN]);
        const read = HorseMind.opponentRead(HUMAN);
        expect(read?.presumed, `${variant} ${scope}`).toBe(true);
        expect(maniacRaiseWidth(read)).toBeGreaterThanOrEqual(0.35);
        expect(aggressiveBettorPressure(read)).not.toBeNull();
        expect(aggressiveOpenerPressure(read, true)).not.toBeNull();
        HorseMind.setDecisionScope(null);
      }
    }
  });

  it("only the raise read is presumed; the player's other statistics stay measured", () => {
    const r = presumedAggressorRead(null, undefined, 'omaha:short', 'plo5');
    expect(r.outcome).toBe('presumed');
    for (const [stat, s] of Object.entries(r.read!.stats))
      if (stat !== 'pfr') expect(s.engaged, stat).toBeNull();
  });

  it('keeps the wider of the presumption and what the player has shown', () => {
    const r = presumedAggressorRead(
      opponentExploitRead(WOOWOO_PLO5_SHORT, 'omaha:short', 'plo5'),
      WOOWOO_PLO5_SHORT,
      'omaha:short',
      'plo5'
    );
    expect(r.outcome).toBe('presumed');
    expect(maniacRaiseWidth(r.read)).toBeGreaterThan(0.5);
  });

  it('comes off when their own hands prove they raise no more than an average horse', () => {
    remember(HUMAN, 'plo5', 'full', TIGHT_PLO5_FULL);
    HorseMind.setDecisionScope('omaha:full', 'plo5', 'cash', [HUMAN]);
    expect(HorseMind.opponentRead(HUMAN)?.presumed).toBeUndefined();
    expect(maniacRaiseWidth(HorseMind.opponentRead(HUMAN))).toBeNull();
    const limper = caller(HUMAN, 40);
    expect(limper.hands).toBeGreaterThanOrEqual(PRESUMPTION_PROOF_MIN_OPPS);
    expect(presumedAggressorRead(null, limper, 'omaha:full', 'plo5').outcome).toBe('disproved');
  });

  it('a few quiet hands do not disprove it', () => {
    const early = caller(HUMAN, 6);
    expect(presumedAggressorRead(null, early, 'omaha:full', 'plo5').outcome).toBe('presumed');
  });

  it('an evidenced maniac keeps the evidence', () => {
    const full = opponentExploitRead(WOOWOO_PLO5_FULL, 'omaha:full', 'plo5');
    const r = presumedAggressorRead(full, WOOWOO_PLO5_FULL, 'omaha:full', 'plo5');
    expect(r.outcome).toBe('evidenced');
    expect(r.read).toBe(full);
  });

  it("hold'em is untouched", () => {
    HorseMind.setDecisionScope('holdem:full', 'nlh', 'cash', [HUMAN]);
    expect(HorseMind.opponentRead(HUMAN)).toBeNull();
    HorseMind.setDecisionScope('holdem:short', 'nlh', 'cash', [HUMAN]);
    expect(HorseMind.opponentRead(HUMAN)).toBeNull();
  });

  it('uses the same default for every opponent with any roster metadata', () => {
    for (const mode of ['cash', 'tournament'] as const) {
      for (const roster of [[HUMAN], [HORSE], [], null]) {
        HorseMind.setDecisionScope('omaha:short', 'plo5', mode, roster);
        const person = HorseMind.opponentRead(HUMAN);
        const horse = HorseMind.opponentRead(HORSE);
        expect(person?.presumed).toBe(true);
        expect(horse).toEqual(person);
      }
    }
  });

  it('uses identical measured passive reads for people and horses', () => {
    remember(HUMAN, 'plo5', 'full', TIGHT_PLO5_FULL);
    remember(HORSE, 'plo5', 'full', TIGHT_PLO5_FULL);
    HorseMind.setDecisionScope('omaha:full', 'plo5', 'cash', [HUMAN]);
    expect(HorseMind.opponentRead(HORSE)).toEqual(HorseMind.opponentRead(HUMAN));
    expect(HorseMind.opponentRead(HORSE)?.presumed).toBeUndefined();
  });

  it('clears the active scope without retaining a roster-specific strategy', () => {
    HorseMind.setDecisionScope('omaha:short', 'plo5', 'cash', [HUMAN]);
    HorseMind.setDecisionScope(null);
    expect(HorseMind.opponentRead(HUMAN)).toBeNull();
    expect(HorseMind.opponentRead(HORSE)).toBeNull();
    HorseMind.setDecisionScope('omaha:short', 'plo5', 'cash');
    expect(HorseMind.opponentRead(HUMAN)?.presumed).toBe(true);
    expect(HorseMind.opponentRead(HORSE)).toEqual(HorseMind.opponentRead(HUMAN));
  });
});
