/**
 * Fit and check the human-calibrated population's reached-state cutoffs
 * (WIN-POP, 2026-10-08). Development seeds only: this script refuses every
 * held-out seed of Phases 10 to 13, and its output is calibration, never
 * qualification evidence.
 *
 *   npx tsx src/scripts/humanCalibratedFit.ts --variant=nlh --hands=2000 --iterations=6
 *   npx tsx src/scripts/humanCalibratedFit.ts --variant=plo4 --hands=3000 --iterations=12 --damping=0.5
 *
 * Each iteration plays `hands` deals of the variant's six-max 100 BB contract
 * table with the current production brain in the rotating hero seat and the
 * human-calibrated population in every other seat, records the strength each
 * human seat held at each decision node, and refits the node cutoffs so the
 * seats that reach the node play the measured shares. A final pass on fresh
 * seeds reports the realized shares against the targets.
 */
// Pin the governor before any module can instantiate the live sampler singleton.
process.env.EQUITY_GOVERNOR = 'off';
// Offline only: imported engine modules construct a database client at load
// time, so they get an address that resolves to nothing and a key that is not
// one. The league never reads or writes the database.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'human-calibrated-fit-offline-placeholder';
const { playPlo4PolicyHand, plo4StrengthLeagueProfile, withHumanCalibratedOpponents } =
  await import('../benchmark/Plo4PolicyLeague.js');
const { jointStrengthLeagueProfile } = await import('../benchmark/JointStrengthLeague.js');
const { remainingVariantStrengthLeagueProfile } =
  await import('../benchmark/RemainingVariantStrengthLeague.js');
const { isPlo4HoldoutSeed } = await import('../benchmark/Plo4StrengthContract.js');
const { isOmahaVariantHoldoutSeed } = await import('../benchmark/OmahaVariantStrengthContract.js');
const { isRemainingVariantHoldoutSeed } =
  await import('../benchmark/RemainingVariantStrengthContract.js');
const { isJointHoldoutSeed } = await import('../benchmark/JointStrengthContract.js');
const {
  HUMAN_CALIBRATED_CHECK_SEED_BASE: CHECK_BASE,
  HUMAN_CALIBRATED_FIT_SEED_BASE: FIT_BASE,
  HUMAN_CALIBRATED_MAX_FIT_ITERATIONS,
  isHumanCalibratedHoldoutSeed,
  HUMAN_CALIBRATED_FITTED_NODES,
  blendHumanCalibratedCutoffs,
  fitHumanCalibratedCutoffs,
  humanCalibratedProfileFor,
} = await import('../benchmark/HumanCalibratedPopulation.js');

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const variant = arg('variant', 'nlh');
const hands = Number(arg('hands', '1500'));
const iterations = Number(arg('iterations', '3'));
/** Weight kept on the previous pass's cutoffs (0: replace them outright). */
const damping = Number(arg('damping', '0'));
if (!(damping >= 0 && damping < 1)) throw new Error('damping in [0, 1)');
if (!['nlh', 'plo4', 'short_deck'].includes(variant))
  throw new Error('variant: nlh|plo4|short_deck');
if (
  !Number.isInteger(hands) ||
  hands < 100 ||
  hands > 99_999 ||
  !Number.isInteger(iterations) ||
  iterations < 0 ||
  iterations > HUMAN_CALIBRATED_MAX_FIT_ITERATIONS
)
  throw new Error(`hands 100..99999, iterations 0..${HUMAN_CALIBRATED_MAX_FIT_ITERATIONS}`);

const heldOut = (s: number) =>
  isHumanCalibratedHoldoutSeed(s) ||
  isPlo4HoldoutSeed(s) ||
  isOmahaVariantHoldoutSeed(s) ||
  isRemainingVariantHoldoutSeed(s) ||
  isJointHoldoutSeed(s);

const table =
  variant === 'nlh'
    ? jointStrengthLeagueProfile('nlh', 'p13c-nlh-6max-100bb')
    : variant === 'plo4'
      ? plo4StrengthLeagueProfile('p10c-6max-100bb')
      : remainingVariantStrengthLeagueProfile('short_deck', 'p12c-short_deck-6max-100bb');
const BB = 2;

async function pass(profile: ReturnType<typeof humanCalibratedProfileFor>, base: number) {
  const league = { ...withHumanCalibratedOpponents(table), humanCalibratedProfiles: [profile] };
  const strengths: Record<string, number[]> = {};
  const actions: Record<string, Record<string, number>> = {};
  const heroNets: number[] = [];
  let house = 0;
  for (let k = 0; k < hands; k++) {
    const seed = base + k;
    if (heldOut(seed)) throw new Error(`Refusing held-out seed ${seed}`);
    const button = (k % table.seats) + 1;
    const heroSeat = ((k + Math.floor(k / table.seats)) % table.seats) + 1;
    const r = await playPlo4PolicyHand(league, seed, button, heroSeat, 'off');
    if (!r.complete || r.illegalActions || r.truncated) throw new Error(`Hand ${seed} incomplete`);
    heroNets.push(r.net[heroSeat - 1] / BB);
    house += (r.rake + r.bbj) / BB;
    for (const [node, bins] of Object.entries(r.humanCalibratedStrength ?? {})) {
      const into = (strengths[node] ??= Array<number>(bins.length).fill(0));
      bins.forEach((b, i) => (into[i] += b));
    }
    for (const [node, t] of Object.entries(r.humanCalibrated ?? {}))
      for (const [a, c] of Object.entries(t))
        (actions[node] ??= {})[a] = ((actions[node] ??= {})[a] ?? 0) + c;
  }
  const mean = heroNets.reduce((a, b) => a + b, 0) / heroNets.length;
  const sd = Math.sqrt(
    heroNets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, heroNets.length - 1)
  );
  const half = (2.5758293035489 * sd) / Math.sqrt(heroNets.length);
  return {
    strengths,
    actions,
    heroBbPer100: Math.round(mean * 10000) / 100,
    heroBbPer100Interval99: [
      Math.round((mean - half) * 10000) / 100,
      Math.round((mean + half) * 10000) / 100,
    ],
    houseBbPer100Hands: Math.round((house / hands) * 10000) / 100,
  };
}

let profile = { ...humanCalibratedProfileFor(variant), cutoffs: {} };
const history: unknown[] = [];
for (let i = 0; i < iterations; i++) {
  const r = await pass(profile, FIT_BASE + i * 100_000);
  const cutoffs = blendHumanCalibratedCutoffs(
    profile.cutoffs,
    fitHumanCalibratedCutoffs(profile, r.strengths),
    damping
  );
  history.push({ iteration: i, cutoffs });
  profile = { ...profile, cutoffs };
}
const check = await pass(profile, CHECK_BASE);
const realized = Object.fromEntries(
  HUMAN_CALIBRATED_FITTED_NODES.map((node) => {
    const t = check.actions[node] ?? {};
    const n = Object.values(t).reduce((a, b) => a + b, 0);
    const share = (k: string[]) =>
      n ? Math.round((1000 * k.reduce((a, x) => a + (t[x] ?? 0), 0)) / n) / 1000 : null;
    return [
      node,
      node.endsWith('checked_to')
        ? { n, bet: share(['bet', 'raise', 'all_in']) }
        : {
            n,
            fold: share(['fold']),
            call: share(['call', 'check']),
            raise: share(['raise', 'bet', 'all_in']),
          },
    ];
  })
);
console.log(
  JSON.stringify(
    {
      variant,
      family: profile.family,
      hands,
      iterations,
      damping,
      table: table.id,
      hero: 'production brain, Phase 10-13 packs off',
      fitSeeds: `${FIT_BASE} + i * 100000 + k`,
      checkSeeds: `${CHECK_BASE} + k`,
      cutoffs: profile.cutoffs,
      history,
      check: {
        realized,
        heroBbPer100: check.heroBbPer100,
        heroBbPer100Interval99: check.heroBbPer100Interval99,
        houseBbPer100Hands: check.houseBbPer100Hands,
      },
    },
    null,
    2
  )
);
process.exit(0);

export {};
