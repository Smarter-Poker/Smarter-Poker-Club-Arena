import type { TournamentUtilityShowdownSample } from '../HorseTournamentUtility.js';

/**
 * Phase 13 round 3: the opponent response model, calibrated to the horse
 * population.
 *
 * Round 2 read a present-board strength (one pair about 0.17, a set about
 * 0.32) as though it were an equity and predicted far more folds than the
 * population makes (the loss diagnosis of October 6: a predicted
 * per-opponent continue of 0.24 against 0.67 realized on bomb flops). This
 * pack replaces that formula with two measured frequencies per variant and
 * street, each a logistic fit of every horse response that faced a price in
 * the P13.2 paired league on the development seeds only (never a held-out
 * seed):
 *
 *  - continueFrequency: the share of responders that call or raise;
 *  - raiseShare: the share of continuing responders that raise.
 *
 * The features are public and the responder's own: the pot price, the live
 * players beside it, whether the street already carries a raise, whether its
 * own line holds a wager, a bomb hand, and whether calling puts it all in.
 *
 * WHO continues is decided by ranking the responder's sampled hands
 * (jointStrengthPercentiles): the strongest `continueFrequency` of the
 * samples continue, and the strongest `continueFrequency x raiseShare` of
 * them raise. A response is therefore deterministic per sample and
 * correlated with the responder's hand, so a wager that is called meets the
 * hands that call, and fold equity is exactly the measured fold frequency.
 */
export const JOINT_RESPONSE_FEATURES = Object.freeze([
  'intercept',
  'potPrice',
  'logActive',
  'facingRaise',
  'ownRaise',
  'bomb',
  'allInForCall',
] as const);

type Street = 'preflop' | 'flop' | 'turn' | 'river';
type Coefficients = readonly number[];
interface StreetFit {
  readonly continue: Coefficients;
  readonly raise: Coefficients;
  readonly n: number;
  readonly nContinue: number;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** The fitted response pack. Coefficients are in JOINT_RESPONSE_FEATURES
 * order; `n` counts the responses fitted and `nContinue` the continuing
 * responses the raise share was fitted on (an all-in call excluded). */
export const JOINT_RESPONSE_CALIBRATION = deepFreeze({
  version: 'joint-response-calibration-round3-v1',
  source: 'logistic_fit_of_horse_population_responses',
  population:
    'every non-hero horse response facing a price in the P13.2 paired league, both arms, production styles',
  developmentSeeds: [13101101, 13102203],
  pairsPerProfile: 2400,
  harness: 'server/src/scripts/jointResponseCalibration.ts',
  table: {
    flh: {
      preflop: {
        continue: [1.6103, -4.3546, -0.9167, -0.8268, 2.8708, 0.0, 0.0],
        raise: [-6.323, 23.0232, -0.6823, -0.8567, 2.2583, 0.0, 0.0],
        n: 151469,
        nContinue: 49867,
      },
      flop: {
        continue: [4.4394, -24.1906, -1.4373, -0.0666, 0.6169, 0.3066, 0.0],
        raise: [-2.3526, -0.4921, -1.0717, 0.5363, 0.2035, -1.4256, 0.0],
        n: 70553,
        nContinue: 51907,
      },
      turn: {
        continue: [4.4966, -20.8792, -1.7854, 0.3035, 0.4199, 0.8197, 0.0],
        raise: [-1.9958, -4.17, -1.1981, 0.0948, 1.1411, 0.0956, 0.0],
        n: 58291,
        nContinue: 43588,
      },
      river: {
        continue: [2.9635, -19.3788, -1.0072, 0.5291, 0.6026, 0.7732, 0.0],
        raise: [-2.3878, -5.1279, -0.8012, 0.2711, 1.5413, 0.2447, 0.0],
        n: 51253,
        nContinue: 38972,
      },
    },
    flo8: {
      preflop: {
        continue: [2.9743, -8.4459, -0.6334, -0.847, 2.3135, 0.0, 0.0],
        raise: [-7.509, 26.1684, -1.3444, -0.4914, 3.1287, 0.0, 0.0],
        n: 147052,
        nContinue: 58909,
      },
      flop: {
        continue: [5.5519, -17.6143, -2.0564, -0.6682, 1.0734, 0.2148, 0.0],
        raise: [-1.7913, -1.6872, -2.6277, 0.9755, 0.0907, -0.8522, 0.0],
        n: 69055,
        nContinue: 58405,
      },
      turn: {
        continue: [6.1351, -22.7358, -2.233, 0.0826, 0.2288, 0.3159, 0.0],
        raise: [-1.6926, -6.817, -1.7837, 1.3487, 0.7484, -0.0499, 0.0],
        n: 66042,
        nContinue: 53063,
      },
      river: {
        continue: [3.5691, -19.3712, -1.1917, 0.5164, 0.2146, 0.777, 0.0],
        raise: [-2.1295, -9.5514, -1.1963, 1.2079, 1.4607, 0.2727, 0.0],
        n: 58896,
        nContinue: 46203,
      },
    },
    nlh: {
      preflop: {
        continue: [0.7615, -3.1001, -0.7843, -0.8537, 1.4688, 0.0, -1.3636],
        raise: [-4.185, 14.7456, 0.1324, -2.5367, 1.2351, 0.0, 0.0],
        n: 123911,
        nContinue: 28335,
      },
      flop: {
        continue: [2.8926, -10.8461, -2.2057, 0.6668, 0.9826, 0.6517, 0.2068],
        raise: [-1.8824, 0.52, -0.5786, 0.9693, -0.0541, -0.7318, 0.0],
        n: 61858,
        nContinue: 13666,
      },
      turn: {
        continue: [3.1911, -11.2529, -2.3466, 0.5754, 0.7659, 1.1458, 0.2232],
        raise: [-2.0901, 0.5135, -0.5768, -0.0452, 1.4808, 0.6267, 0.0],
        n: 19438,
        nContinue: 8735,
      },
      river: {
        continue: [2.2234, -9.2319, -1.3943, 0.6902, 0.6282, 0.7067, -0.03],
        raise: [-1.7226, -0.0851, -0.6161, 0.4349, 0.1343, 0.1207, 0.0],
        n: 11224,
        nContinue: 3757,
      },
    },
    pineapple: {
      preflop: {
        continue: [0.7462, -2.7064, -0.8229, -0.843, 1.3267, 0.0, 0.695],
        raise: [-4.5718, 15.8188, 0.1521, -2.9447, 1.2764, 0.0, 0.0],
        n: 123567,
        nContinue: 30181,
      },
      flop: {
        continue: [4.4408, -12.7809, -1.9298, 0.3243, 1.175, 0.1262, 0.4188],
        raise: [-1.344, 0.7031, -1.1391, 0.7635, -0.3347, -0.6478, 0.0],
        n: 71695,
        nContinue: 23441,
      },
      turn: {
        continue: [3.757, -11.1449, -1.8234, 0.2027, 0.8629, 1.0802, -0.1349],
        raise: [-1.6242, -0.3372, -0.7502, 0.0662, 1.1113, 0.7085, 0.0],
        n: 25812,
        nContinue: 13889,
      },
      river: {
        continue: [2.2736, -8.5789, -0.9611, 0.4071, 0.5966, 0.5902, -0.0698],
        raise: [-1.8205, 1.0072, -0.545, -0.1405, 0.2531, 0.2334, 0.0],
        n: 12880,
        nContinue: 4344,
      },
    },
    plo4: {
      preflop: {
        continue: [2.2274, -6.4785, -0.6354, -0.5579, 1.6645, 0.0, 2.6678],
        raise: [-4.4187, 12.4249, 0.1189, -2.1663, 1.76, 0.0, 0.0],
        n: 121822,
        nContinue: 40236,
      },
      flop: {
        continue: [5.0707, -16.4948, -2.0928, 0.4619, 0.4657, -0.1024, -0.2589],
        raise: [-1.9878, 0.8813, -1.3893, 1.5539, 0.4741, -0.6878, 0.0],
        n: 61602,
        nContinue: 20825,
      },
      turn: {
        continue: [4.6057, -14.12, -2.2618, 0.4807, 0.1024, 0.9051, -0.0929],
        raise: [-2.4529, 1.4389, -0.8741, 1.2997, 0.9349, 0.5644, 0.0],
        n: 27591,
        nContinue: 15207,
      },
      river: {
        continue: [2.1857, -9.9147, -1.6197, 0.5249, 0.4569, 1.4263, 0.15],
        raise: [-1.8153, 1.6823, -0.9752, 0.7093, 0.6973, 0.4672, 0.0],
        n: 19757,
        nContinue: 7662,
      },
    },
    plo5: {
      preflop: {
        continue: [2.0547, -5.6063, -0.7064, -0.7379, 1.4251, 0.0, 2.2312],
        raise: [-4.5697, 12.6597, 0.3257, -2.1363, 1.5681, 0.0, 0.0],
        n: 116770,
        nContinue: 39647,
      },
      flop: {
        continue: [5.5147, -16.9667, -2.4042, 0.3968, 0.4663, -0.04, -0.2023],
        raise: [-2.3067, 1.3414, -1.4169, 1.5735, 0.555, -0.456, 0.0],
        n: 57595,
        nContinue: 21517,
      },
      turn: {
        continue: [4.6269, -13.3673, -2.4525, 0.5713, 0.1822, 0.8798, -0.1614],
        raise: [-2.4398, 1.3928, -0.9471, 1.5827, 0.9041, 0.5048, 0.0],
        n: 28527,
        nContinue: 16701,
      },
      river: {
        continue: [1.9764, -9.2805, -1.6374, 0.6256, 0.427, 1.482, 0.1449],
        raise: [-1.8918, 1.8448, -1.047, 0.8893, 0.7262, 0.6339, 0.0],
        n: 23339,
        nContinue: 9168,
      },
    },
    plo6: {
      preflop: {
        continue: [2.2266, -5.3985, -0.8144, -0.9072, 1.0667, 0.0, 1.6459],
        raise: [-4.1817, 11.7165, 0.3578, -1.9746, 1.4123, 0.0, 0.0],
        n: 102421,
        nContinue: 38963,
      },
      flop: {
        continue: [5.7884, -17.6408, -2.5787, 0.4351, 0.3969, 0.065, -0.3312],
        raise: [-1.8846, -0.3802, -1.8338, 1.8288, 0.4756, -0.2842, 0.0],
        n: 54963,
        nContinue: 22051,
      },
      turn: {
        continue: [4.7558, -13.6524, -2.6143, 0.9061, 0.0709, 0.945, -0.1777],
        raise: [-2.437, 1.7896, -1.2438, 1.4566, 0.6887, 0.6092, 0.0],
        n: 29783,
        nContinue: 17749,
      },
      river: {
        continue: [2.0665, -9.0735, -1.7152, 0.6934, 0.5223, 1.4, 0.1171],
        raise: [-1.6074, 1.2458, -1.1533, 0.8344, 0.6369, 0.5318, 0.0],
        n: 26317,
        nContinue: 10480,
      },
    },
    plo8: {
      preflop: {
        continue: [2.3023, -6.6412, -0.702, -0.5462, 1.7113, 0.0, 2.5755],
        raise: [-4.7262, 13.2496, 0.0801, -2.2471, 1.6895, 0.0, 0.0],
        n: 120667,
        nContinue: 38790,
      },
      flop: {
        continue: [5.9945, -18.5063, -2.3557, 0.4004, 0.3432, -0.2926, -0.5565],
        raise: [-1.6934, -0.1338, -1.9103, 1.3824, 0.4332, -0.7506, 0.0],
        n: 59359,
        nContinue: 20955,
      },
      turn: {
        continue: [5.6001, -16.3343, -2.4687, 0.3704, -0.1334, 0.5921, -0.2204],
        raise: [-2.9113, 2.8186, -0.9407, 1.5866, 0.9206, 0.4201, 0.0],
        n: 26672,
        nContinue: 15674,
      },
      river: {
        continue: [3.0926, -12.206, -1.7542, 0.549, 0.2367, 1.1632, 0.1289],
        raise: [-2.5293, 2.5113, -0.999, 1.49, 0.6329, 0.723, 0.0],
        n: 19835,
        nContinue: 8289,
      },
    },
    short_deck: {
      preflop: {
        continue: [1.183, -3.1008, -0.9067, -0.9016, 0.9089, 0.0, 0.5344],
        raise: [-5.4357, 17.5592, 0.0492, -2.5883, 1.3908, 0.0, 0.0],
        n: 125392,
        nContinue: 34174,
      },
      flop: {
        continue: [5.085, -14.4152, -2.4303, 0.7407, 0.9812, 0.0883, 0.1589],
        raise: [-1.8161, -0.3223, -1.4149, 0.8268, 0.0639, -0.4191, 0.0],
        n: 54930,
        nContinue: 16037,
      },
      turn: {
        continue: [3.982, -11.2402, -2.0207, 0.5879, 0.4651, 0.5589, -0.2914],
        raise: [-2.0274, 0.9883, -1.3144, 0.3267, 0.741, 0.498, 0.0],
        n: 27469,
        nContinue: 13749,
      },
      river: {
        continue: [2.0665, -7.6799, -1.2821, 0.513, 0.7117, 0.8271, -0.1385],
        raise: [-1.6085, 0.7707, -0.9606, 0.2297, 0.1486, 0.1024, 0.0],
        n: 21553,
        nContinue: 8442,
      },
    },
  },
});

export interface JointResponseFeatures {
  variant: string;
  street: string;
  /** Chips this responder must add to continue (capped at its stack). */
  price: number;
  /** The contestable pot this responder can win, before its call. */
  pot: number;
  /** Live players other than this responder. */
  active: number;
  /** Bets, raises and full all-ins already made on this street. */
  streetWagers: number;
  /** Bets, raises and full all-ins in this responder's own line. */
  ownRaises: number;
  bomb: boolean;
  /** True when the price is the responder's whole stack. */
  allInForCall: boolean;
}

const logistic = (w: Coefficients, x: number[]) => {
  let z = 0;
  for (let i = 0; i < x.length; i++) z += w[i] * x[i];
  return 1 / (1 + Math.exp(-z));
};

/** The responder's feature vector, in JOINT_RESPONSE_FEATURES order. */
export function jointResponseFeatureVector(f: JointResponseFeatures): number[] {
  if (!(f.price > 0) || !Number.isFinite(f.pot) || f.pot < 0 || !(f.active >= 1))
    throw new Error('joint_response_invalid_features');
  const potPrice = f.price / Math.max(f.price, f.pot + f.price);
  return [
    1,
    potPrice,
    Math.log(Math.max(1, f.active)),
    f.streetWagers >= 2 ? 1 : 0,
    f.ownRaises > 0 ? 1 : 0,
    f.bomb ? 1 : 0,
    f.allInForCall ? 1 : 0,
  ];
}

/** Measured continue frequency and raise share for one response. */
export function jointResponseFrequencies(f: JointResponseFeatures): {
  continueFrequency: number;
  raiseShare: number;
} {
  const fits = (JOINT_RESPONSE_CALIBRATION.table as Record<string, Record<string, StreetFit>>)[
    f.variant
  ];
  const fit = fits?.[f.street as Street];
  if (!fit) throw new Error('joint_response_uncalibrated_cell');
  const x = jointResponseFeatureVector(f);
  return {
    continueFrequency: logistic(fit.continue, x),
    raiseShare: f.allInForCall ? 0 : logistic(fit.raise, x),
  };
}

/** Each sample's percentile, in (0, 1), of one responder's hand within that
 * responder's own sampled range, ordered by the strength the hand reaches on
 * that sample's runout: its high score (mean over boards) and, in a split
 * game, the better of that order and its low order. Ties are broken by the
 * deterministic local draw, so no sample is privileged by its index.
 *
 * Why the runout and not the present board: the population continues on its
 * own equity, and the present-board read (made-hand category) misorders it.
 * On the development seeds only 41 to 49 percent of the NLH bomb-flop
 * responders that continued sat in the present-board read's top share, and a
 * jam priced with the present-board order met callers far weaker than the
 * ones the table produced (predicted edge +15.9 chips, realized 0.0, with the
 * all-fold frequency itself measured exactly: 0.75 against 0.76). The runout
 * order errs the other way: the hands that continue are the ones that end
 * strongest, so a called wager is priced against the strongest continuing
 * range the sample allows. It never changes how OFTEN a responder continues
 * (that is the measured frequency); it only decides which of its sampled
 * hands do, and the error it carries makes a wager look worse, never better. */
export function jointStrengthPercentiles(
  samples: readonly TournamentUtilityShowdownSample[],
  opponentIndex: number,
  tieBreak: (index: number) => number,
  splitLow = false
): number[] {
  const n = samples.length;
  const rank = (value: number[]) => {
    const order = value
      .map((v, i) => ({ v, i, t: tieBreak(i) }))
      .sort((a, b) => a.v - b.v || a.t - b.t);
    const out = new Array<number>(n);
    order.forEach((o, r) => (out[o.i] = (r + 0.5) / n));
    return out;
  };
  const high = samples.map((sample) => {
    if (!sample.boards.length) throw new Error('joint_action_invalid_strength');
    return (
      sample.boards.reduce((a, b) => a + b.opponentHigh[opponentIndex], 0) / sample.boards.length
    );
  });
  const byHigh = rank(high);
  if (!splitLow) return byHigh;
  // A lower low score is the better low; no qualifying low ranks last.
  const low = samples.map(
    (sample) =>
      -sample.boards.reduce((a, b) => {
        const l = b.opponentLow[opponentIndex];
        return a + (l === null || !Number.isFinite(l) ? 1e12 : l);
      }, 0) / sample.boards.length
  );
  const byLow = rank(low);
  return rank(byHigh.map((h, i) => Math.max(h, byLow[i])));
}

/** The response of the responder holding the sample at `percentile`: the
 * strongest continueFrequency of its range continues, and the strongest
 * continueFrequency x raiseShare of it raises. */
export function jointCalibratedResponse(
  percentile: number,
  frequencies: { continueFrequency: number; raiseShare: number }
): 'fold' | 'call' | 'raise' {
  const c = frequencies.continueFrequency;
  if (percentile <= 1 - c) return 'fold';
  return percentile > 1 - c * frequencies.raiseShare ? 'raise' : 'call';
}
