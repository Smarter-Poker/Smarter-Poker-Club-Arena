/**
 * The winning contract's condition (b) for a Phase 10 (PLO4) or Phase 11
 * (PLO5, PLO6, PLO8) pack (docs/horse-brain-winning-contract-2026-10-08.md,
 * server/src/benchmark/HumanCalibratedCheck.ts).
 *
 *   npx tsx src/scripts/omahaHumanCalibratedCheck.ts run --variant=plo5 \
 *     --profile=p11c-plo5-6max-100bb --seed=19201101 --out=FILE [--source-sha=SHA]
 *   npx tsx src/scripts/omahaHumanCalibratedCheck.ts run --development --variant=plo4 \
 *     --profile=p10c-6max-100bb --seed=10101101 --hands=500 --out=FILE
 *   npx tsx src/scripts/omahaHumanCalibratedCheck.ts assemble --variant=plo5 \
 *     --runs=DIR --out=FILE
 *
 * `run` plays one (contract profile, seed): the profile's table with the
 * human-calibrated population in every other seat, the candidate arm in the
 * rotating hero seat and the reference arm on the same deal, at the profile's
 * published rake, exactly as the pack's strength league deals a pair. Contract
 * mode runs only a `HUMAN_CALIBRATED_HOLDOUT_SEEDS` seed at the contract's
 * hands per seed; development mode refuses every held-out seed of Phases 10 to
 * 13 and the human-calibrated held-out seeds. `assemble` reads every run file
 * of one pack under `--runs` and writes the condition (b) summary.
 */
// Pin the governor before any module can instantiate the live sampler singleton.
process.env.EQUITY_GOVERNOR = 'off';
// Offline only: imported engine modules construct a database client at load
// time, so they get an address that resolves to nothing and a key that is not
// one. The league never reads or writes the database.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'human-calibrated-check-offline-placeholder';
const { readdirSync, readFileSync, writeFileSync, statSync } = await import('node:fs');
const path = await import('node:path');
const {
  playPlo4PolicyHand,
  plo4LeagueSeating,
  plo4StrengthLeagueProfile,
  withHumanCalibratedOpponents,
} = await import('../benchmark/Plo4PolicyLeague.js');
const { omahaVariantStrengthLeagueProfile } =
  await import('../benchmark/OmahaVariantStrengthLeague.js');
const {
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  isOmahaVariantHoldoutSeed,
  isOmahaVariantStrengthVariant,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthPack,
} = await import('../benchmark/OmahaVariantStrengthContract.js');
const { PLO4_STRENGTH_CONTRACT, isPlo4HoldoutSeed, plo4StrengthContractDigest } =
  await import('../benchmark/Plo4StrengthContract.js');
const { isRemainingVariantHoldoutSeed } =
  await import('../benchmark/RemainingVariantStrengthContract.js');
const { isJointHoldoutSeed } = await import('../benchmark/JointStrengthContract.js');
const { HUMAN_CALIBRATED_POPULATION_ID, isHumanCalibratedHoldoutSeed } =
  await import('../benchmark/HumanCalibratedPopulation.js');
const { OMAHA_VARIANT_PACKS } = await import('../engine/omaha/OmahaVariantPolicyPack.js');
const { PLO4_POLICY_PACK } = await import('../engine/plo4/Plo4PolicyPack.js');
const {
  HUMAN_CALIBRATED_CHECK_SCHEMA,
  addHumanCalibratedHand,
  humanCalibratedHandsPerSeed,
  summarizeHumanCalibratedCheck,
} = await import('../benchmark/HumanCalibratedCheck.js');
type Run = import('../benchmark/HumanCalibratedCheck.js').HumanCalibratedCheckRun;

const command = process.argv[2];
const arg = (k: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;
const flag = (k: string) => process.argv.includes(`--${k}`);
const variant = arg('variant') ?? '';
const phase10 = variant === 'plo4';
if (!phase10 && !isOmahaVariantStrengthVariant(variant))
  throw new Error('Unknown Phase 10 or Phase 11 variant');
const matrix = phase10
  ? PLO4_STRENGTH_CONTRACT.matrix
  : omahaVariantStrengthPack(variant as 'plo5').matrix;
const profileIds = matrix.profiles.map((p) => p.id);
const leagueProfile = (profileId: string) =>
  phase10
    ? plo4StrengthLeagueProfile(profileId)
    : omahaVariantStrengthLeagueProfile(variant as 'plo5', profileId);
const contractVersion = phase10
  ? PLO4_STRENGTH_CONTRACT.version
  : OMAHA_VARIANT_STRENGTH_CONTRACT.version;
const out = arg('out');
if (!out) throw new Error('--out is required');

if (command === 'run') {
  const profileId = arg('profile') ?? '';
  if (!profileIds.includes(profileId))
    throw new Error('Unknown Phase 10 or Phase 11 cash contract profile');
  const seed = Number(arg('seed'));
  if (!Number.isInteger(seed) || seed < 1 || seed > 0xffffffff) throw new Error('Invalid seed');
  const development = flag('development');
  const handsPerSeed = humanCalibratedHandsPerSeed(matrix.rotationBlock);
  if (!development && !isHumanCalibratedHoldoutSeed(seed))
    throw new Error('A contract run deals only a human-calibrated held-out seed');
  if (
    development &&
    (isHumanCalibratedHoldoutSeed(seed) ||
      isRemainingVariantHoldoutSeed(seed) ||
      isOmahaVariantHoldoutSeed(seed) ||
      isPlo4HoldoutSeed(seed) ||
      isJointHoldoutSeed(seed))
  )
    throw new Error('A development run never deals a held-out seed');
  const requested = development ? Number(arg('hands') ?? 0) : handsPerSeed;
  if (!Number.isInteger(requested) || requested < 1 || requested > handsPerSeed)
    throw new Error('Invalid hand count');
  const profile = withHumanCalibratedOpponents(leagueProfile(profileId));
  const run: Run = {
    schema: HUMAN_CALIBRATED_CHECK_SCHEMA,
    phase: phase10 ? 'phase10' : 'phase11',
    variant,
    packVersion: phase10
      ? PLO4_POLICY_PACK.version
      : OMAHA_VARIANT_PACKS[variant as 'plo5'].version,
    contractDigest: phase10 ? plo4StrengthContractDigest() : omahaVariantStrengthContractDigest(),
    population: HUMAN_CALIBRATED_POPULATION_ID,
    profileId,
    leagueProfileId: profile.id,
    evidenceMode: development ? 'development' : 'contract',
    seed,
    firstHand: 0,
    requestedHands: requested,
    hands: 0,
    complete: false,
    candidate: { sum: 0, sumSq: 0 },
    reference: { sum: 0, sumSq: 0 },
    difference: { sum: 0, sumSq: 0 },
    changedHands: 0,
    decisions: 0,
    changed: 0,
    illegalCandidates: 0,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    incompleteHands: 0,
    truncatedHands: 0,
    candidateRake: 0,
    referenceRake: 0,
    sourceSha: arg('source-sha'),
    durationMs: 0,
  };
  const started = performance.now();
  for (let i = 0; i < requested; i++) {
    // The strength league's deal and seat rotation, so a hand index means the
    // same deal here as in the paired contract.
    const dealSeed = (seed ^ Math.imul(i + 1, 2654435761)) >>> 0 || 1;
    const { heroSeat, button } = plo4LeagueSeating(i, profile.seats);
    const c = await playPlo4PolicyHand(
      profile,
      dealSeed,
      button,
      heroSeat,
      'candidate',
      () => true,
      true
    );
    const r = await playPlo4PolicyHand(
      profile,
      dealSeed,
      button,
      heroSeat,
      'off',
      () => true,
      true
    );
    run.hands++;
    for (const h of [c, r]) {
      run.illegalActions += h.illegalActions;
      run.conservationErrors += h.conservationErrors;
      run.cardErrors += h.cardErrors;
      run.truncatedHands += h.truncated;
      if (!h.complete) run.incompleteHands++;
    }
    run.decisions += c.decisions;
    run.changed += c.changed;
    run.illegalCandidates += c.illegalCandidates ?? 0;
    run.candidateRake += c.rake;
    run.referenceRake += r.rake;
    if (!c.complete || !r.complete) continue;
    const cc = addHumanCalibratedHand(run.candidate, c.net[heroSeat - 1]);
    const rc = addHumanCalibratedHand(run.reference, r.net[heroSeat - 1]);
    const d = cc - rc;
    run.difference.sum += d;
    run.difference.sumSq += d * d;
    if (d !== 0) run.changedHands++;
  }
  run.complete = run.hands === requested && run.incompleteHands === 0;
  run.durationMs = Math.round(performance.now() - started);
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  console.log(
    JSON.stringify({
      variant,
      profileId,
      seed,
      hands: run.hands,
      complete: run.complete,
      candidateBBPerHand: run.candidate.sum / 200 / run.hands,
      differenceBBPerHand: run.difference.sum / 200 / run.hands,
    })
  );
} else if (command === 'assemble') {
  const dir = arg('runs');
  if (!dir) throw new Error('--runs is required');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = path.join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else if (name.endsWith('.json')) files.push(f);
    }
  };
  walk(dir);
  const runs = files
    .map((f) => JSON.parse(readFileSync(f, 'utf8')) as Run)
    .filter((r) => r.schema === HUMAN_CALIBRATED_CHECK_SCHEMA && r.variant === variant);
  const summary = summarizeHumanCalibratedCheck({
    variant,
    profileIds,
    rotationBlock: matrix.rotationBlock,
    runs,
    rakeModel: `published rake per profile (publishedRake, the cap ladder and BBJ drop), ${contractVersion}`,
  });
  writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    JSON.stringify({
      variant,
      runs: summary.runs,
      conditionB: summary.conditionB,
      candidate: summary.candidate && [
        summary.candidate.bbPer100,
        summary.candidate.lower99,
        summary.candidate.upper99,
      ],
      reasons: summary.reasons.slice(0, 5),
    })
  );
} else {
  throw new Error('Command must be run or assemble');
}
process.exit(0);

export {};
