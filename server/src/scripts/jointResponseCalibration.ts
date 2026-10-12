/** Phase 13 round 3: development-seed response calibration harness (Horse
 * Brain). Development seeds only: a held-out seed of any phase is refused.
 *
 *   node --import tsx src/scripts/jointResponseCalibration.ts \
 *     --variant=<v> --profile=<contract profile id> --seed=<development seed> \
 *     --first=<pair index> --pairs=<n> --output=<file.jsonl> [--human]
 *
 * --human seats the human-calibrated population (`human-calibrated-v1-20261008`,
 * withHumanCalibratedOpponents) in every non-hero seat: a development
 * measurement of the winning contract's condition (b), never a qualification
 * (its held-out seeds are refused here like every other phase's).
 *
 * Plays the P13.2 paired league (playPlo4PolicyHand, the real HandController,
 * the contract profile, the contract deal seeds, buttons and hero seats) and
 * writes one JSON line per record:
 *  - `resp`: every non-hero decision that faces a price, with the features the
 *    response model reads (street, price, contestable pot, live players, the
 *    player's own line, its present-board strength signal) and what it did;
 *  - `hero`: every candidate-arm hero decision the joint owner priced, with
 *    the baseline and selected rows' modeled value and response;
 *  - `pair`: the paired net difference, each arm's hero net after rake (cents)
 *    and the divergence street.
 * It writes a local file only and cannot activate a policy.
 */
import { writeFileSync } from 'node:fs';
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase13-calibration-offline-placeholder';

const { HorseLogic } = await import('../engine/HorseLogic.js');
const { jointDecisionStrength } = await import('../engine/multiway/JointRangeSampler.js');
const { plo4LeagueSeating, playPlo4PolicyHand, withHumanCalibratedOpponents } =
  await import('../benchmark/Plo4PolicyLeague.js');
const { isHumanCalibratedHoldoutSeed } = await import('../benchmark/HumanCalibratedPopulation.js');
const { jointStrengthLeagueProfile } = await import('../benchmark/JointStrengthLeague.js');
const { jointDivergenceStreet } = await import('../benchmark/JointStrengthChecks.js');
const { isJointHoldoutSeed, isJointStrengthVariant } =
  await import('../benchmark/JointStrengthContract.js');
const { isRemainingVariantHoldoutSeed } =
  await import('../benchmark/RemainingVariantStrengthContract.js');
const { isOmahaVariantHoldoutSeed } = await import('../benchmark/OmahaVariantStrengthContract.js');
const { isPlo4HoldoutSeed } = await import('../benchmark/Plo4StrengthContract.js');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, '').split('=');
    return [k, v.join('=')];
  })
);
const variant = args.variant;
const seed = Number(args.seed);
const first = Number(args.first ?? 0);
const pairs = Number(args.pairs ?? 100);
if (!isJointStrengthVariant(variant)) throw new Error('unknown variant');
if (
  !Number.isInteger(seed) ||
  isJointHoldoutSeed(seed) ||
  isRemainingVariantHoldoutSeed(seed) ||
  isOmahaVariantHoldoutSeed(seed) ||
  isPlo4HoldoutSeed(seed) ||
  isHumanCalibratedHoldoutSeed(seed)
)
  throw new Error('development seeds only');
const contractProfile = jointStrengthLeagueProfile(variant, args.profile);
const profile = 'human' in args ? withHumanCalibratedOpponents(contractProfile) : contractProfile;
const lines: string[] = [];
const emit = (r: Record<string, unknown>) => lines.push(JSON.stringify(r));

let arm = '';
let pairIndex = 0;
let heroSeat = 0;
let heroCount = 0;
let lastHeroDecision: { id: number; street: string } | null = null;
const original = HorseLogic.decide.bind(HorseLogic);
const wagerKinds = new Set(['bet', 'raise']);
(HorseLogic as unknown as { decide: typeof HorseLogic.decide }).decide = ((
  ...a: Parameters<typeof HorseLogic.decide>
) => {
  const [player, gs] = a;
  const decision = original(...a);
  const street = gs.stage;
  if (player.seat === heroSeat) {
    const j = decision.jointPolicy;
    if (arm === 'candidate' && j && j.fired && j.actionModel) {
      const rows = j.actionModel.candidates;
      const match = (action: string, amount: number | null) =>
        rows.find(
          (r) => r.action === action && (!wagerKinds.has(action) || (r.amount ?? null) === amount)
        ) ?? null;
      const summary = (r: (typeof rows)[number] | null) =>
        r && {
          action: r.action,
          amount: r.amount,
          investment: r.investment,
          ev: r.expectedNetChips,
          se: r.standardError,
          allFold: r.allFoldProbability,
          call: Object.values(r.responseCounts)
            .map((c) => c.meanCallProbability)
            .filter((x): x is number => typeof x === 'number'),
        };
      const id = ++heroCount;
      emit({
        t: 'hero',
        id,
        pair: pairIndex,
        street,
        boards: gs.boardCount ?? 1,
        live: j.liveOpponents,
        pot: gs.pot,
        toCall: gs.toCall,
        stack: player.stack,
        model: j.actionModel.responseModel,
        baseline: [j.baselineAction, j.baselineAmount],
        proposal: [j.proposalAction, j.proposalAmount],
        applied: j.applied,
        rows: rows.map(summary),
        baseRow: summary(match(j.baselineAction, j.baselineAmount)),
        selRow: summary(match(j.proposalAction, j.proposalAmount)),
      });
      lastHeroDecision = { id, street };
    }
    return decision;
  }
  const toCall = Math.min(player.stack, Math.max(0, gs.currentBet - player.bet));
  if (toCall <= 0) return decision;
  const boards = [gs.communityCards, gs.communityCards2, gs.communityCards3].filter(
    (b): b is NonNullable<typeof b> => Array.isArray(b) && b.length > 0
  );
  const reads = (boards.length ? boards : [[]]).map((b) =>
    jointDecisionStrength(variant, player.cards, b)
  );
  const mean = reads.reduce((x, y) => x + y, 0) / reads.length;
  const history = gs.actionHistory ?? [];
  const thisStreet = history.filter((h) => h.stage === street);
  const lastWager = [...thisStreet]
    .reverse()
    .find(
      (h) => wagerKinds.has(h.action) || (h.action === 'all_in' && h.isFullRaise !== undefined)
    );
  const heroId = gs.players.find((p) => p.seat === heroSeat)?.user_id;
  const facingHero = lastWager?.userId === heroId;
  const line = history.filter(
    (h) => h.userId === player.user_id && !(gs.bombPot && h.stage === 'preflop')
  );
  const act = decision.action;
  const kind =
    act === 'fold'
      ? 'fold'
      : act === 'call' || act === 'check' || (act === 'all_in' && player.stack <= toCall + 1e-9)
        ? 'call'
        : 'raise';
  emit({
    t: 'resp',
    arm,
    pair: pairIndex,
    street,
    boards: gs.boardCount ?? 1,
    bomb: Boolean(gs.bombPot),
    price: toCall,
    pot: gs.contestablePot ?? gs.pot,
    potPrice: toCall / Math.max(toCall, (gs.contestablePot ?? gs.pot) + toCall),
    active: gs.players.filter((p) => !p.is_folded && p.user_id !== player.user_id).length,
    allInForCall: player.stack <= toCall + 1e-9,
    wagers: thisStreet.filter(
      (h) => wagerKinds.has(h.action) || (h.action === 'all_in' && h.isFullRaise !== undefined)
    ).length,
    raises: line.filter(
      (h) => wagerKinds.has(h.action) || (h.action === 'all_in' && h.isFullRaise !== undefined)
    ).length,
    calls: line.filter((h) => h.action === 'call').length,
    strength: Math.min(1, mean * 0.75 + Math.max(...reads) * 0.25),
    facingHero,
    heroDecision:
      facingHero && arm === 'candidate' && lastHeroDecision?.street === street
        ? lastHeroDecision.id
        : null,
    kind,
    stackBB: (player.stack + player.totalInvested) / 2,
  });
  return decision;
}) as typeof HorseLogic.decide;

for (let k = 0; k < pairs; k++) {
  const i = first + k;
  pairIndex = i;
  const dealSeed = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
  const seating = plo4LeagueSeating(i, profile.seats);
  heroSeat = seating.heroSeat;
  arm = 'candidate';
  lastHeroDecision = null;
  const candidate = await playPlo4PolicyHand(
    profile,
    dealSeed,
    seating.button,
    seating.heroSeat,
    'candidate',
    () => true,
    true
  );
  arm = 'off';
  lastHeroDecision = null;
  const reference = await playPlo4PolicyHand(
    profile,
    dealSeed,
    seating.button,
    seating.heroSeat,
    'off',
    () => true,
    true
  );
  if (!candidate.checks || !reference.checks) throw new Error('incomplete hand');
  emit({
    t: 'pair',
    pair: i,
    position: seating.relativePosition,
    diff:
      Math.round(candidate.net[heroSeat - 1] * 100) - Math.round(reference.net[heroSeat - 1] * 100),
    candidateCents: Math.round(candidate.net[heroSeat - 1] * 100),
    referenceCents: Math.round(reference.net[heroSeat - 1] * 100),
    street: jointDivergenceStreet(candidate.checks.trace, reference.checks.trace),
  });
}
writeFileSync(args.output, lines.join('\n') + '\n');
console.log(
  JSON.stringify({ variant, profile: profile.id, seed, first, pairs, records: lines.length })
);
process.exit(0);
