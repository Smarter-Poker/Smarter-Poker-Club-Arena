/**
 * Owner-triggered post-launch condition (b) monitor (winning contract,
 * Amendment Of October 9, 2026). Never scheduled: the owner runs it once
 * production has human volume. Procedure: docs/horse-brain-condition-b-monitoring.md.
 *
 *   npx tsx src/scripts/conditionBMonitor.ts status
 *     Lists every selected pack and whether the committed human calibration is
 *     adequate for its family. Exit 0: adequate for every selected pack (run
 *     the checks); exit 3: could not decide (calibration inadequate for at
 *     least one pack: unavailable external input).
 *   npx tsx src/scripts/conditionBMonitor.ts verdict --summary=FILE [--summary=FILE ...]
 *     Reads assembled condition (b) summaries (omahaHumanCalibratedCheck.ts /
 *     phase12HumanCalibratedCheck.ts `assemble`) and prints keep, withdraw or
 *     no decision for each, with the exact `withdrawn` value to commit for a
 *     withdrawal. It writes nothing.
 */
process.env.EQUITY_GOVERNOR = 'off';
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'condition-b-monitor-offline-placeholder';
const { readFileSync } = await import('node:fs');
const { conditionBVerdict, packCalibrationAdequacy, selectedPacks } =
  await import('../benchmark/ConditionBMonitor.js');
const { PHASE8_PROTECTED_RELEASE_SELECTION } = await import('../engine/HorseQualifiedAuthority.js');
const { PHASE10_PROTECTED_RELEASE_SELECTION } = await import('../engine/HorsePhase10Authority.js');
const { PHASE11_PROTECTED_RELEASE_SELECTIONS } = await import('../engine/HorsePhase11Authority.js');
const { PHASE12_PROTECTED_RELEASE_SELECTIONS } = await import('../engine/HorsePhase12Authority.js');
const { PHASE13_PROTECTED_RELEASE_SELECTIONS } = await import('../engine/HorsePhase13Authority.js');

const [command, ...rest] = process.argv.slice(2);
if (command === 'status') {
  const packs = selectedPacks([
    { phase: 'phase8', variant: 'nlh', selection: PHASE8_PROTECTED_RELEASE_SELECTION as never },
    { phase: 'phase10', variant: 'plo4', selection: PHASE10_PROTECTED_RELEASE_SELECTION },
    ...Object.entries(PHASE11_PROTECTED_RELEASE_SELECTIONS).map(([variant, selection]) => ({
      phase: 'phase11' as const,
      variant,
      selection,
    })),
    ...Object.entries(PHASE12_PROTECTED_RELEASE_SELECTIONS).map(([variant, selection]) => ({
      phase: 'phase12' as const,
      variant,
      selection,
    })),
    ...Object.entries(PHASE13_PROTECTED_RELEASE_SELECTIONS).map(([variant, selection]) => ({
      phase: 'phase13' as const,
      variant,
      selection: selection as never,
    })),
  ]);
  let undecided = 0;
  for (const pack of packs) {
    const adequacy = packCalibrationAdequacy(pack);
    if (!adequacy.adequate) undecided++;
    console.log(
      JSON.stringify({
        ...pack,
        family: adequacy.family,
        calibration: adequacy.adequate ? 'adequate' : 'unavailable_external_input',
        reasons: adequacy.reasons,
      })
    );
  }
  process.exit(undecided ? 3 : 0);
} else if (command === 'verdict') {
  const files = rest.filter((a) => a.startsWith('--summary=')).map((a) => a.slice(10));
  if (!files.length) {
    console.error('--summary=<file> is required');
    process.exit(2);
  }
  const now = new Date().toISOString();
  for (const file of files) {
    const summary = JSON.parse(readFileSync(file, 'utf8'));
    console.log(
      JSON.stringify({
        file,
        variant: summary.variant,
        packVersion: summary.packVersion,
        ...conditionBVerdict(summary, now),
      })
    );
  }
} else {
  console.error('usage: conditionBMonitor.ts status | verdict --summary=FILE...');
  process.exit(2);
}

export {};
