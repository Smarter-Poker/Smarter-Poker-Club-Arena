/**
 * Development-only leak diagnosis for the Phase 10 (PLO4) and Phase 11
 * (PLO5/PLO6/PLO8) packs. Plays the contract league's paired hands on a
 * DEVELOPMENT seed (held-out seeds are refused by the league itself), and for
 * every pair records the hero's first decision at which the candidate arm
 * differs from the reference arm, with the paired net difference. The first
 * divergence owns the whole difference, because both arms are identical before
 * it.
 *
 * Usage:
 *   node --import tsx src/scripts/omahaLeakDiagnose.ts \
 *     --variant=plo5 --profile=p11c-plo5-6max-100bb --seed=11101101 \
 *     --from=0 --pairs=2000 --out=/path/out.json
 */
import { writeFileSync } from 'node:fs';
// Offline only, exactly as the strength shard CLIs: pin the governor before
// any module can instantiate the live sampler singleton, and give the engine
// modules that build a database client at load time an address that resolves
// to nothing. Nothing here reads or writes the database.
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'horse-brain-development-offline-placeholder';
const { HorseLogic } = await import('../engine/HorseLogic.js');
const { playPlo4PolicyHand, plo4LeagueSeating, plo4StrengthLeagueProfile } =
  await import('../benchmark/Plo4PolicyLeague.js');
const { omahaVariantStrengthLeagueProfile } =
  await import('../benchmark/OmahaVariantStrengthLeague.js');
const { isOmahaVariantHoldoutSeed } = await import('../benchmark/OmahaVariantStrengthContract.js');
const { isPlo4HoldoutSeed } = await import('../benchmark/Plo4StrengthContract.js');

const arg = (name: string, fallback?: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback === undefined) throw new Error(`missing --${name}`);
  return fallback;
};
const variant = arg('variant');
const profileId = arg('profile');
const seed = Number(arg('seed'));
const from = Number(arg('from', '0'));
const pairs = Number(arg('pairs', '1000'));
const out = arg('out');
if (isOmahaVariantHoldoutSeed(seed) || isPlo4HoldoutSeed(seed))
  throw new Error('development diagnosis never runs a held-out seed');
const profile =
  variant === 'plo4'
    ? plo4StrengthLeagueProfile(profileId)
    : omahaVariantStrengthLeagueProfile(variant as 'plo5', profileId);
const BB = 2;

interface Captured {
  stage: string;
  reason: string;
  role: string | null;
  position: string | null;
  baselineAction: string;
  baselineAmount: number | null;
  proposalAction: string;
  proposalAmount: number | null;
  applied: boolean;
  pot: number;
  toCall: number;
  opponents: number;
  equity: number | null;
  lower: number | null;
  callPrice: number | null;
  features: string[];
  heroStack: number;
  /** HorseLogic's selection guard: 'illegal_candidate' plays the reference. */
  refusal: string | null;
}
let capture: Captured[] | null = null;
let heroSeatNow = 0;
const original = HorseLogic.decide;
(HorseLogic as unknown as { decide: typeof original }).decide = function (
  this: typeof HorseLogic,
  ...args: Parameters<typeof original>
) {
  const d = original.apply(this, args);
  const [player, gs] = args;
  if (capture && player.seat === heroSeatNow) {
    const r = (variant === 'plo4' ? d.plo4Policy : d.omahaVariantPolicy) as
      | Record<string, unknown>
      | undefined;
    if (r) {
      const eq = r.equity as { equity: number; confidence99?: [number, number] } | null;
      capture.push({
        stage: gs.stage,
        reason: String(r.reason),
        role: (r.role as string) ?? null,
        position: (r.position as string) ?? null,
        baselineAction: String(r.baselineAction),
        baselineAmount: (r.baselineAmount as number) ?? null,
        proposalAction: String(r.proposalAction),
        proposalAmount: (r.proposalAmount as number) ?? null,
        applied: Boolean(r.applied),
        pot: gs.pot,
        toCall: gs.toCall ?? 0,
        opponents: gs.players.filter((p) => p.seat !== player.seat && !p.is_folded).length,
        equity: eq ? eq.equity : null,
        lower: eq?.confidence99 ? eq.confidence99[0] : null,
        callPrice: (r.callPrice as number) ?? null,
        features: Array.isArray(r.features) ? (r.features as string[]) : [],
        heroStack: player.stack,
        refusal: (r.selectionRefusal as string | null | undefined) ?? null,
      });
    }
  }
  return d;
} as typeof original;

const rows: unknown[] = [];
let illegalCandidates = 0;
let sum = 0,
  sumSq = 0;
const started = Date.now();
for (let k = 0; k < pairs; k++) {
  const i = from + k;
  const dealSeed = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
  const { heroSeat, button, relativePosition } = plo4LeagueSeating(i, profile.seats);
  heroSeatNow = heroSeat;
  capture = [];
  const cand = await playPlo4PolicyHand(profile, dealSeed, button, heroSeat, 'candidate');
  const cDecisions = capture;
  capture = null;
  const ref = await playPlo4PolicyHand(profile, dealSeed, button, heroSeat, 'off');
  if (!cand.complete || !ref.complete) throw new Error(`incomplete pair ${i}`);
  const delta = (cand.net[heroSeat - 1] - ref.net[heroSeat - 1]) / BB;
  sum += delta;
  sumSq += delta * delta;
  const first = cDecisions.find((d) => d.applied) ?? null;
  illegalCandidates += cDecisions.filter((d) => d.refusal === 'illegal_candidate').length;
  rows.push({
    i,
    offset: relativePosition,
    delta: Math.round(delta * 1000) / 1000,
    refNet: ref.net[heroSeat - 1] / BB,
    candNet: cand.net[heroSeat - 1] / BB,
    first,
    appliedCount: cDecisions.filter((d) => d.applied).length,
    decisions: cDecisions.length,
  });
}
const n = pairs;
const mean = sum / n;
const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
writeFileSync(
  out,
  JSON.stringify({
    variant,
    profileId,
    seed,
    from,
    pairs,
    bbPer100: mean * 100,
    se99: (2.5758 * sd * 100) / Math.sqrt(n),
    ms: Date.now() - started,
    illegalCandidates,
    rows,
  })
);
console.log(
  `${variant} ${profileId} seed=${seed} from=${from} pairs=${n} bb/100=${(mean * 100).toFixed(2)} +-${((2.5758 * sd * 100) / Math.sqrt(n)).toFixed(2)} illegal_candidates=${illegalCandidates} ms=${Date.now() - started}`
);
process.exit(0);
