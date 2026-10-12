/**
 * Development-only one-step counterfactual probe of the reference brain for the
 * Phase 10 (PLO4) and Phase 11 (PLO5/PLO6/PLO8) packs. For each pair index of a
 * DEVELOPMENT seed: play the reference arm (hero in shadow, so the pack's
 * receipt with its features is recorded but the reference action is played),
 * choose one eligible hero decision, then replay the identical deal once per
 * alternative action at that decision (everything else, hero included, plays
 * the reference). delta = hero net(alternative) - hero net(reference), in BB:
 * Q(s, alt) - Q(s, reference) for that single decision. Alternatives: the
 * passive action (fold, or check), call, a half-pot wager and a pot wager.
 *
 * Usage:
 *   node --import tsx src/scripts/omahaCounterfactual.ts --variant=plo5 \
 *     --profile=p11c-plo5-6max-2dealt-100bb --seed=11101101 --from=0 --pairs=1440 \
 *     [--streets=preflop,flop,turn,river] --out=/path/out.json
 */
import { writeFileSync } from 'node:fs';
import type { HorseDecision } from '../types.js';
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
const streets = arg('streets', 'preflop,flop,turn,river').split(',');
const out = arg('out');
if (isOmahaVariantHoldoutSeed(seed) || isPlo4HoldoutSeed(seed))
  throw new Error('development probe never runs a held-out seed');
const profile =
  variant === 'plo4'
    ? plo4StrengthLeagueProfile(profileId)
    : omahaVariantStrengthLeagueProfile(variant as 'plo5', profileId);
const BB = 2;
const ALTS = ['passive', 'call', 'half', 'pot'] as const;
type Alt = (typeof ALTS)[number];

let heroSeatNow = 0;
let recording: Record<string, unknown>[] | null = null;
let forceAt = -1;
let forceAlt: Alt | null = null;
let heroIndex = 0;
let forcedDecision: HorseDecision | null = null;

function altDecision(
  alt: Alt,
  gs: Parameters<typeof HorseLogic.decide>[1],
  hero: { stack: number; bet: number },
  base: HorseDecision
): HorseDecision | null {
  const legal = gs.legalActions ?? [];
  const toCall = Math.min(hero.stack, Math.max(0, gs.currentBet - hero.bet));
  if (alt === 'passive') {
    const a = toCall > 0 ? 'fold' : 'check';
    return legal.includes(a) ? { action: a, thinkTime: base.thinkTime } : null;
  }
  if (alt === 'call') {
    if (toCall <= 0) return null;
    if (legal.includes('call') && toCall < hero.stack)
      return { action: 'call', amount: toCall, thinkTime: base.thinkTime };
    return legal.includes('all_in') ? { action: 'all_in', thinkTime: base.thinkTime } : null;
  }
  const fraction = alt === 'half' ? 0.5 : 1;
  const action = gs.currentBet > 0 ? 'raise' : 'bet';
  const stackTo = hero.bet + hero.stack;
  const potTo = gs.currentBet + gs.pot + toCall;
  if (!legal.includes(action) || gs.minRaiseTo == null || gs.maxRaiseTo == null) {
    if (legal.includes('all_in') && stackTo <= potTo + 0.001)
      return { action: 'all_in', thinkTime: base.thinkTime };
    return null;
  }
  const cap = Math.min(gs.maxRaiseTo, stackTo, potTo);
  if (cap < gs.minRaiseTo) return null;
  const amount =
    Math.floor(
      Math.max(gs.minRaiseTo, Math.min(cap, gs.currentBet + (gs.pot + toCall) * fraction)) * 100 +
        1e-7
    ) / 100;
  if (amount >= stackTo - 0.001)
    return legal.includes('all_in') ? { action: 'all_in', thinkTime: base.thinkTime } : null;
  return { action, amount, thinkTime: base.thinkTime };
}

const original = HorseLogic.decide;
(HorseLogic as unknown as { decide: typeof original }).decide = function (
  this: typeof HorseLogic,
  ...args: Parameters<typeof original>
) {
  const d = original.apply(this, args);
  const [player, gs] = args;
  if (player.seat !== heroSeatNow) return d;
  const r = (variant === 'plo4' ? d.plo4Policy : d.omahaVariantPolicy) as
    | Record<string, any>
    | undefined;
  const idx = heroIndex++;
  if (recording) {
    const inputs = r?.inputs;
    const toCall = Math.min(player.stack, Math.max(0, gs.currentBet - player.bet));
    recording.push({
      k: idx,
      stage: gs.stage,
      eligible: Boolean(r?.eligible),
      reason: r?.reason ?? null,
      role: r?.role ?? null,
      position: r?.position ?? null,
      depth: r?.depthBB ?? null,
      quality: inputs?.approximation?.handShape?.score ?? null,
      high: inputs?.approximation?.handShape?.highScore ?? null,
      low: inputs?.approximation?.handShape?.lowScore ?? null,
      equity: r?.equity?.equity ?? null,
      eqLo: r?.equity?.confidence99?.[0] ?? null,
      eqHi: r?.equity?.confidence99?.[1] ?? null,
      highEq: r?.equity?.highEquity ?? null,
      scoop: r?.equity?.scoopProbability ?? null,
      callPrice: r?.callPrice ?? null,
      spr: inputs?.geometry?.postflop?.spr ?? null,
      features: r?.features ?? [],
      opp: gs.players.filter((p) => p.seat !== player.seat && !p.is_folded).length,
      pot: gs.pot / BB,
      toCall: toCall / BB,
      stack: player.stack / BB,
      refAction: d.action,
      refAmount: d.amount != null ? d.amount / BB : null,
      propAction: r?.proposalAction ?? null,
      propAmount: r?.proposalAmount != null ? r.proposalAmount / BB : null,
    });
  }
  if (idx === forceAt && forceAlt) {
    const alt = altDecision(forceAlt, gs, player, d);
    forcedDecision = alt;
    if (alt) return { ...d, action: alt.action, amount: alt.amount } as typeof d;
  }
  return d;
} as typeof original;

const rows: unknown[] = [];
const started = Date.now();
let skipped = 0;
for (let k = 0; k < pairs; k++) {
  const i = from + k;
  const dealSeed = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
  const { heroSeat, button, relativePosition } = plo4LeagueSeating(i, profile.seats);
  heroSeatNow = heroSeat;
  recording = [];
  heroIndex = 0;
  forceAt = -1;
  forceAlt = null;
  const ref = await playPlo4PolicyHand(profile, dealSeed, button, heroSeat, 'shadow');
  const decisions = recording;
  recording = null;
  if (!ref.complete) throw new Error(`incomplete reference ${i}`);
  const eligible = decisions.filter((d) => d.eligible && streets.includes(d.stage as string));
  if (!eligible.length) {
    skipped++;
    continue;
  }
  let h = Math.imul(dealSeed ^ 0x9e3779b9, 2246822519) >>> 0;
  h ^= h >>> 15;
  const target = eligible[(h >>> 0) % eligible.length];
  const refNet = ref.net[heroSeat - 1] / BB;
  const alts: Record<string, unknown> = {};
  for (const alt of ALTS) {
    heroIndex = 0;
    forceAt = target.k as number;
    forceAlt = alt;
    forcedDecision = null;
    const res = await playPlo4PolicyHand(profile, dealSeed, button, heroSeat, 'shadow');
    if (!forcedDecision) continue;
    if (!res.complete || res.illegalActions) {
      alts[alt] = { illegal: true };
      continue;
    }
    const fd = forcedDecision as HorseDecision;
    alts[alt] = {
      a: fd.action,
      amt: fd.amount != null ? fd.amount / BB : null,
      d: Math.round((res.net[heroSeat - 1] / BB - refNet) * 1000) / 1000,
    };
  }
  rows.push({ i, offset: relativePosition, refNet, n: decisions.length, at: target, alts });
}
writeFileSync(
  out,
  JSON.stringify({ variant, profileId, seed, from, pairs, skipped, ms: Date.now() - started, rows })
);
console.log(
  `${variant} ${profileId} seed=${seed} from=${from} pairs=${pairs} rows=${rows.length} ms=${Date.now() - started}`
);
process.exit(0);
