import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const all = () => ({ src: true, server: true, tests: true, phase4: true, fixture: true });
const wide =
  /^(package(-lock)?\.json|vite\.config|vitest\.config|tsconfig|\.npmrc|\.nvmrc|\.node-version|\.github\/workflows\/|scripts\/ci\/(classify-ci-changes|fixture-native-gate)\.mjs)/;
const phase4 =
  /^(\.github\/workflows\/ci\.yml|scripts\/ci\/classify-ci-changes\.mjs|scripts\/ci\/probes\/horse-phase4-certified-solver\/|supabase\/migrations\/20260909(165541|170039|170749|171644|172537|175000|180000)_|server\/src\/(benchmark\/(HorseLeague|HorseSolverAgreementV31)|engine\/(GtoDecisionContext|GtoPostflopV31|GtoV31|HorseDataLedger|HorseLogic|LiveHorseDecisionWorkerHealth|horseDecision\/)|services\/GtoPostflopV31Loader))/;
const breakfastWitness =
  /^scripts\/ci\/(?:test-breakfast-original-witness\.py$|breakfast_(?:fixture|original_witness|qualification|concurrency)\.py$|fixtures\/breakfast-original-witness\/|probes\/breakfast-original-witness\/)/;

const satelliteQualifiers =
  /^(scripts\/ci\/(?:test-satellite-qualifiers\.py$|(?:satellite_qualifier_(?:fixture|concurrency)|satellite_entry_club_native)\.py$|fixtures\/satellite-qualifiers\/|probes\/(?:satellite-entry-club-native\.sql|satellite-qualifier(?:s-native\.sql|-(?:finish|reader)\.spec))$)|tests\/operations\/satellite-qualifier-results\.test\.py$)/;
const mttPreparation =
  /^(scripts\/ci\/(test-mtt-unlimited\.py$|mtt_(unlimited_fixture|isolation_results|format_qualification|historical_freebuy_proof|break_authoring_native)\.py$|fixtures\/mtt-(unlimited|format-preparation|historical-freebuy|break-authoring)\/|probes\/mtt-(isolation\/|.*(?:native\.sql|lock\.spec)$))|tests\/operations\/(mtt-(unlimited-runner|isolation-results)\.test\.py$|fixtures\/mtt-preparation-lock\/))/;
// Actual activation reuses the same owned PG runner and its exact financial
// and authoring dependencies. Fixture-only changes must reach this job too.
const mttActivation =
  /^(scripts\/ci\/(mtt_activation_native\.py$|mtt_activation_funding\.py$|mtt_activation_satellite\.py$|satellite_qualifier_fixture\.py$|mtt_break_authoring_native\.py$|fixtures\/(mtt-format-activation|satellite-qualifiers|mtt-break-authoring)\/|probes\/mtt-activation\/)|tests\/operations\/mtt-activation-results\.test\.py$)/;
const originalPaidCustody =
  /^(?:scripts\/ci\/(?:(?:test|build)-original-paid-custody\.py$|original_paid_custody_native\.py$|fixtures\/original-paid-custody\/|probes\/original-paid-custody-authority\.sql$))/;
const f06HandAuthority =
  /^(?:scripts\/ci\/(?:(?:test-f06-shared-hand-lane|build-f06-retired-origin|build-f06-stopped-bank-custody)\.py$|(?:test|build)-f06-(?:accepted-elimination|elimination-migration|movement-admission|drained-custody|mixed-custody)\.py$|fixtures\/f06-(?:accepted-elimination|movement-admission|drained-custody|mixed-custody)\/|probes\/f06-(?:retired-origin-cohorts\.json$|shared-hand-lane\/|mixed-restart-qualification\.py$|(?:accepted-elimination|movement-admission|drained-custody|mixed-custody)\.(?:sql|spec)$|(?:retired-origin-authority|movement-opening|drained-custody-authority|mixed-custody-authority|mixed-movement-authority)\.sql$)|schema-manifest\.d\/f06-(?:movement-admission|drained-custody|mixed-custody|retained-mtt-disposition|retired-origin|stopped-bank-custody|lease-retention)\.json$|(?:test-hand-submission|build-hand-submission-migration)\.py$|probes\/hand-submission-[a-z-]+\.(?:sql|spec)$|fixtures\/hand-submission\/)|tests\/operations\/f06-(?:elimination|movement)-results\.test\.py$)/;
const fixture =
  /^(operations\/release\/(fixture\/|native\/|ci\/fixture-smoke\.py)|\.github\/workflows\/(ci|component-fixture-native-smoke|release-component-qualification)\.yml|scripts\/ci\/(fixture-native-gate|classify-ci-changes)\.mjs|tests\/(operations\/(fixture-|financial-|component-source-contract|native-component-semantics|fixtures\/realtime-launcher\/)|unit\/fixtureNativeCi\.test\.ts)|package(-lock)?\.json|\.npmrc|\.nvmrc|\.node-version)/;

// These maintained SQL components and fixture inputs feed the existing required
// PostgreSQL accounting job even when no server application source changes.
const accounting =
  /^(supabase\/accounting\/|scripts\/ci\/build-weekly-accounting-activation\.py$|tests\/fixtures\/(accounting-agreement-history|accounting-alert-38644|accounting-delivery|agent-accounting-statements|browser-period-observer|cash-commission-sources|cash-rake-earning-evidence|cash-source-compatibility|cash-source-refusals|cashier-document-authority|cashier-statements|club-weekly-summary|correction-document-authority|correction-writer-authority|credit-invoice-generation|credit-reduction-authority|credit-request-authority|full-weekly-accounting|earlybird-fee-custody|legacy-fee-finality|sep8-spin-custody|messenger-private-accounting|mixed-rake-period|pnl-evidence|push-health-reader|push-subscription-ownership|push-subscription-rotation|rakeback-history-privacy|rakeback-write-authority|routed-accounting|scope-weekly-accounting|tournament-fee-lifecycle|tournament-fee-sources|unified-weekly-accounting|union-earned-close|union-weekly-accounting|weekly-accounting-coordinator|weekly-scheduler-fairness|weekly-scheduler-timing|weekly-union-continuation)\/)/;
// Spin qualification and every reviewed input use the existing accounting job.
const spinExpiry =
  /^(supabase\/components\/(?:spin-expiry-lock-order|spin-history-retention|spin-mixed-basis-(?:receipt-lane|current-receipt-lane|current-terminal))(?:\.rollback)?\.sql$|supabase\/components\/spin-mixed-basis-evidence\.sql$|scripts\/qualification\/(?:spin-mixed-basis-(?:shape\.sql|evidence\.preimage\.sql|pure\.(?:sql|hosted\.manifest\.json))$|spin-positive-fee-entry(?:-oracle)?\.py$|spin-positive-fee-entry\.(?:md|hosted\.manifest\.json)$|spin-mixed-positive-fee-entry\.sql$|spin-mixed-current(?:-(?:races|assertions))?\.py$|spin-mixed-current\.(?:md|hosted\.manifest\.json)$|spin-receipt-lane(?:-compactor)?\.(?:sql|py|md|hosted\.manifest\.json)$|spin-expiry-|spin-history-retention(?:-behavior\.sql|(?:-completed)?\.(?:sql|md|manifest\.json))$|fixtures\/(?:spin-history-retention|spin-receipt-lane|spin-mixed-current|spin-mixed-positive-fee)\/)|scripts\/ci\/(?:test-spin-expiry-postgres\.py$|test_spin_expiry_wrapper\.py$|probes\/spin-expiry\/)|tests\/unit\/fixtureNativeCi\.test\.ts$)/;

// Production Alert SQL inputs select the existing accounting checks.
const productionAlertsSql =
  /^(scripts\/ci\/(?:test-(?:hand-index-writer-order|hand-stat-writer-order|rake-attribution-atomic)\.py$|probes\/(?:hand-index-writer-order|hand-stat-writer-order|rake-attribution-atomic)\/)|tests\/tournament-rake-attribution-retries-inside-its-own-transaction\.law\.test\.ts$)/;

// These alert components and their exact inputs run in the same accounting job.
const productionAlertCore =
  /^(supabase\/components\/(?:production-alert-identity-and-rake-wording(?:\.rollback)?|direct-operational-source-legacy-envelope(?:\.rollback)?|direct-operational-source-intake(?:\.(?:rollback|authority|functions|postimage))?)\.sql$|scripts\/qualification\/(?:production-alert-core-(?:identity|connected)\.sql$|direct-operational-source-(?:intake|legacy-envelope)\.sql$|fixtures\/direct-operational-source-intake\/)|scripts\/ci\/(?:test-production-alert-core-postgres\.py$|test_production_alert_core_postgres\.py$|probes\/production-alert-core\/))/;
const alertEvidence =
  /^(supabase\/components\/(?:duplicate-structure-record-evidence(?:\.rollback)?|rake-repair-record-evidence(?:-rollback)?|spin-repair-evidence(?:\.rollback)?)\.sql$|scripts\/qualification\/(?:alert-evidence-hosted\.manifest\.json$|(?:duplicate-structure-record-evidence|rake-repair-record-evidence|spin-repair-evidence)(?:\.manifest\.json|\.md|\.sql|-race\.spec)$|fixtures\/(?:duplicate-structure-record-evidence|rake-repair-record-evidence|spin-repair-evidence)\/)|scripts\/ci\/(?:test-alert-evidence-postgres|test_alert_evidence_wrapper)\.py$)/;

const class4HandOutcome =
  /^(supabase\/components\/class4-hand-outcome-evidence(?:\.rollback)?\.sql$|scripts\/qualification\/(?:class4-hand-outcome-evidence\.(?:sql|drift\.sql|concurrency\.spec|md|manifest\.json)$|fixtures\/class4-hand-outcome-evidence\.(?:preimage|candidate|originals)\.sql$)|scripts\/ci\/(?:test-class4-hand-outcome-postgres\.py$|test_class4_hand_outcome_postgres\.py$|probes\/class4-hand-outcome\/))/;

const cashEvidence =
  /^(supabase\/components\/(?:cash-pot-check-evidence|cash-failed-run-intake)(?:\.rollback)?\.sql$|scripts\/operational-alerts\/cash-pot-failed-run-intake\.(?:sql|md)$|scripts\/qualification\/(?:cash-native-hosted\.manifest\.json$|cash-pot-check-connected\.sql$|cash-pot-check-evidence(?:\.sql|\.md|\.manifest\.json|-concurrency\.spec)$|cash-pot-failed-run-intake\.sql$|fixtures\/(?:cash-pot-check-evidence|cash-pot-failed-run-intake|cash-native-pgcron)\/)|scripts\/ci\/(?:build_pg17_cash_pgcron|test-cash-failure-pgcron|test_cash_native_pgcron)\.py$)/;

export function gitEnvironmentForCwd() {
  // Hooks export repository context that overrides cwd. These local-only Git
  // calls must also discard inherited index/object/config overrides so a
  // foreign fixture cannot read or modify the hook's repository.
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  );
}

// Only these non-executable instruction inputs can omit the isolated SQL replay.
// Every compiler/invariant and the entire client/source-contract suite still runs.
const instructionFiles = new Set([
  'docs/agent-policy/OWNER-POLICY.md',
  'docs/agent-policy/OPERATING-LAW.md',
  'docs/agent-policy/HARDENING.md',
  'docs/agent-policy/REFERENCE-INDEX.md',
  'docs/agent-policy/policy-manifest.json',
]);
export function instructionOnlyPaths(paths) {
  return Array.isArray(paths) && paths.length > 0 && paths.every((p) => instructionFiles.has(p));
}

export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p || p.includes('\0'))) {
    return all();
  }
  const matches = (pattern) => paths.some((p) => pattern.test(p));
  const broad = matches(wide);
  // These maintained verification inputs execute in the existing CSS browser
  // job. A test-only correction must run its connected browser regressions.
  //
  // `helpers/` AND `css/` ARE WHOLE DIRECTORIES, NOT LISTS OF BASENAMES
  // (2026-09-20). Both used to be alternations of hand-typed names, and both
  // had already rotted past them - measured, not supposed:
  //
  //   tests/e2e/helpers/diamond-test-fixture.mjs        -> src: false
  //   tests/e2e/helpers/diamond-wheel-page-fixture.mjs  -> src: false
  //   tests/e2e/css/club-lobby-sticky-selector.spec.ts  -> src: false
  //
  // The first drives 12 of the 13 tests in css/diamond-games-playfield.spec.ts
  // and the second drives the recovery half of css/diamond-wheel-reveal.spec.ts,
  // so a change to either answered "no browser job needed" about the very job
  // that runs it (CLAUDE.md 10.86 rule 1: that is not an answer, it is a guess
  // wearing one). Both are reached by `await import(...)` INSIDE a test body,
  // so no static import scan would have caught the omission either.
  //
  // A basename list cannot hold this rule, because nothing fails when the next
  // fixture is left out of it. The directory can: every file in `helpers/` is a
  // fixture module a spec bundles, and all three specs in `css/` are named in
  // the css-beats-e2e Playwright invocation. `cashLobbyBrowser` feeds `src` and
  // nothing else, and `src` only ADMITS jobs (build, css-beats-e2e), so a wider
  // match here can never withhold a check - it can only pay for one.
  // The `$` anchor stays load-bearing: a `.md` companion of a fixture is
  // documentation and admits nothing (tests/unit/fixtureNativeCi.test.ts).
  const cashLobbyBrowser = matches(
    /^tests\/e2e\/(?:global-setup\.ts|live-animations\.spec\.ts|css\/[^/]+\.spec\.ts|helpers\/[^/]+\.mjs|mobile-lobby-chrome\.spec\.ts|production-live-table-realtime\.spec\.ts|support\/(?:cashLobbyOverlays|observationDeadline|initialTableOwnership)\.ts)$/
  );
  // Both PR builds invoke this stamper; its own changes must reach them.
  const buildProvenance = paths.includes('scripts/stamp-build-provenance.mjs');
  const nativeIsolationTool = matches(/^scripts\/ci\/build_pg17_isolationtester\.py$/);
  const horsePriority = matches(
    /^scripts\/qualification\/(?:horse-league-process-priority-native\.mjs$|fixtures\/horse-league-process-priority\/)/
  );
  // Rule-only changes must run the existing reporting contract suites.
  const spinRules = matches(/^infra\/monitoring\/spin-rules\.yml$/);
  const memoryMonitoring = matches(
    /^infra\/monitoring\/(?:alert-rules\.yml|grafana-dashboards\/poker-engine\.json)$/
  );
  const spinComparator = matches(
    /^(scripts\/ci\/(check-alert-rules-match|rule-metric-producers)\.mjs|infra\/monitoring\/prometheus\.yml)$/
  );
  // The existing accounting job owns the BBJ runner and its nested fixture inputs.
  const bbjFixture = matches(
    /^scripts\/ci\/(?:test-bbj-bank-replay\.py$|probes\/bbj-bank-replay\/)/
  );
  // Diamond request/receipt changes and retained real SQL probes must reach
  // the existing required PostgreSQL accounting job.
  //
  // THE DIAMOND PROBE LANE IS A PREFIX, NOT A LIST (2026-09-20). The same rot
  // as the browser alternation above, one directory over and already past the
  // list: `scripts/dev/test-accounting-delivery.sh` (step "Diamond games" of
  // accounting_postgres) executes ELEVEN tests/sql/diamond-*.sql probes, and
  // ten were named here. Measured:
  //
  //   tests/sql/diamond-one-setting-super-guarantee.sql -> server: false
  //
  // while line 166 of that script runs it and asserts its exact success
  // witness. The probe could be edited, or broken, and the only job that
  // executes it would be skipped. `diamond-` after `tests/sql/` is the lane's
  // own naming rule, so a new probe is admitted by being named like one; the
  // `poker-diamond-*` probes and the `.ts`/`.py` drivers are untouched.
  const diamondGames = matches(
    /^(tests\/sql\/diamond-[a-z0-9-]+\.sql|tests\/fixtures\/(diamond-wheel-v2-(receipts|state)|diamond-spins\/wheel-(?:earned|v3)-postgres-receipts)\.json|tests\/unit\/wheel(ServerReceipts|EarnedPostgresContract|UpgradeReceipts|UpgradePostgresContract)\.test\.ts|src\/services\/(DiamondBonusService|DiamondGamesService|DiamondChoiceService|DiamondWheelService|DiamondReplayService|DiamondStatementService|WheelBonusEntryService|diamondBonusRecovery)\.ts|src\/hooks\/use(BonusBudget|EarnedBonus)\.ts|src\/components\/games\/BonusSetup\.tsx|src\/utils\/(crashReceipt|bonusGameBudget|wheelAward|wheelPendingSpin|wheelFairness)\.ts|src\/pages\/Diamond(Choice|Crash|Plinko|Wheel)Page\.tsx)$/
  );

  // The Diamond Arena SQL acceptance (2026-09-19): every runner, every fixture
  // file the runners read and the wrapper that runs them in the accounting job.
  // The diamond-tournament-* captures, deltas, manifests, seed and cases were
  // added on 2026-09-20 with the two tournament runners that load them: the
  // runner is what the job executes, so a change to what it loads has to reach
  // the same job or the acceptance certifies the old bytes. The `diamondGames`
  // prefix above happens to claim the `.sql` half of those today; they are
  // named here as well because THIS is the lane that executes them, so a future
  // narrowing of that prefix cannot quietly take them out of the job that runs
  // them. The manifests are claimed only here. Nothing is derived from the
  // other lane, so the two cannot disagree - a path matched by either is in.
  const diamondSqlAcceptance = matches(
    /^(tests\/sql\/(?:run-[a-z0-9-]*diamond[a-z0-9-]*\.py|poker-diamond-[a-z0-9-]+\.sql|poker-arena-access\.sql|diamond-controlled-play-driver\.ts|diamond-session-fixture\.sql|diamond-transfer-cap-fixture\.sql|diamond-tournament-[a-z0-9-]+\.sql|diamond-tournament-[a-z0-9-]+\.manifest\.json)|scripts\/ci\/(?:run-diamond-sql-acceptance\.py|check-diamond-runners-listed\.mjs))$/
  );
  // The Phase 4 PostgreSQL step cannot run when its parent job is skipped.
  const phase4Changed = matches(phase4);
  // Script/fixture-only edits must admit accounting and its routing tests.
  const commitmentAudit = matches(
    /^(scripts\/ci\/test-horse-commitment-audit\.py$|scripts\/ci\/probes\/horse-commitment-audit\/|tests\/unit\/horseCi\.test\.ts$)/
  );
  // THE LAW REGISTRY IS READ FROM DISK, SO IT HAS TO SEE ITS OWN DIRECTORY
  // (2026-09-20). `tests/law-registry.law.test.ts` readdirSync's docs/laws.d/
  // and enforces the registry BOTH ways - an unregistered law fails, a registry
  // file naming a law that no longer exists fails, and a malformed first line
  // fails. It runs in exactly one place, `npx vitest run tests/` under
  // unit_shards, gated on `src || tests`. A pull request that touched only
  // docs/laws.d/ therefore classified as {tests: false} and skipped the single
  // reader of the directory it had just edited: retiring a law, or breaking the
  // registry, went green with nothing looking (CLAUDE.md 10.83). docs/ is
  // deliberately outside the application suites otherwise - this one directory
  // is test input, so it is named, exactly as docs/agent-policy/ already is.
  const lawRegistry = matches(/^docs\/laws\.d\//);
  // The ranking inverse and reminder pg dependencies are executable accounting
  // inputs outside scripts/dev. Their changes also need the routing laws.
  const tournamentAccountingInput = matches(
    /^(docs\/changelog\/2026-09-11-a-bust-is-ranked-by-when-it-happened\.rollback\.sql|scripts\/ci\/probes\/chip-journal-atomicity\/postgres-runtime\/package(-lock)?\.json)$/
  );
  return {
    src: broad || cashLobbyBrowser || buildProvenance || matches(/^src\//),
    server:
      broad ||
      bbjFixture ||
      diamondGames ||
      diamondSqlAcceptance ||
      phase4Changed ||
      matches(mttPreparation) ||
      matches(satelliteQualifiers) ||
      matches(breakfastWitness) ||
      matches(mttActivation) ||
      matches(f06HandAuthority) ||
      matches(originalPaidCustody) ||
      commitmentAudit ||
      matches(accounting) ||
      nativeIsolationTool ||
      spinRules ||
      horsePriority ||
      tournamentAccountingInput ||
      matches(
        /^(server\/|supabase\/migrations\/|scripts\/dev\/|tests\/fixtures\/accounting-delivery\/|tests\/operations\/pko-probe-cleanup\.test\.py$)/
      ) ||
      matches(spinExpiry) ||
      matches(productionAlertsSql) ||
      matches(productionAlertCore) ||
      matches(alertEvidence) ||
      matches(class4HandOutcome) ||
      matches(cashEvidence),
    tests:
      instructionOnlyPaths(paths) ||
      paths.some((p) => p.startsWith('docs/agent-policy/')) ||
      lawRegistry ||
      broad ||
      matches(satelliteQualifiers) ||
      matches(breakfastWitness) ||
      buildProvenance ||
      diamondGames ||
      diamondSqlAcceptance ||
      commitmentAudit ||
      tournamentAccountingInput ||
      matches(mttPreparation) ||
      matches(mttActivation) ||
      matches(f06HandAuthority) ||
      matches(originalPaidCustody) ||
      matches(/^scripts\/ci\/detect-silent-revert\.mjs$/) ||
      nativeIsolationTool ||
      spinRules ||
      spinComparator ||
      memoryMonitoring ||
      horsePriority ||
      matches(/^(tests\/|supabase\/migrations\/|server\/|scripts\/dev\/|\.husky\/pre-push$)/) ||
      matches(spinExpiry) ||
      matches(productionAlertsSql) ||
      matches(productionAlertCore) ||
      matches(alertEvidence) ||
      matches(class4HandOutcome) ||
      matches(cashEvidence),
    phase4: phase4Changed,
    fixture: matches(fixture),
  };
}

export function classifyGitChanges({ cwd, base, head }) {
  const uncertain = () => ({
    complete: false,
    reason: 'immutable_git_diff_unavailable',
    flags: all(),
  });
  if (![base, head].every((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha)))
    return uncertain();
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      env: gitEnvironmentForCwd(),
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    if (git('rev-parse', 'HEAD').toString().trim() !== head) return uncertain();
    for (const sha of [base, head]) git('cat-file', '-e', `${sha}^{commit}`);
    // Multiple merge bases, missing shallow history or failed enumeration are
    // uncertainty, never evidence that the fixture did not change.
    const mergeBase = git('merge-base', '--all', base, head).toString().trim();
    if (!/^[0-9a-f]{40}$/.test(mergeBase)) return uncertain();
    // Disabling rename detection deliberately emits both deleted old and added
    // new paths. NUL framing preserves whitespace/newlines and has no API cap.
    const bytes = git('diff', '--name-only', '--no-renames', '-z', `${mergeBase}..${head}`, '--');
    const decoded = bytes.toString('utf8');
    if (!Buffer.from(decoded, 'utf8').equals(bytes) || (bytes.length && !decoded.endsWith('\0')))
      return uncertain();
    const paths = bytes.length ? decoded.slice(0, -1).split('\0') : [];
    if (
      paths.some((p) => !p || p.startsWith('/') || p.split('/').includes('..')) ||
      new Set(paths).size !== paths.length
    )
      return uncertain();
    return { complete: true, base, head, mergeBase, paths, flags: classifyChangedPaths(paths) };
  } catch {
    return uncertain();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = classifyGitChanges({
    cwd: process.cwd(),
    base: process.env.CI_BASE_SHA,
    head: process.env.CI_HEAD_SHA,
  });
  if (!result.complete)
    console.log('::notice::Immutable changed-file evidence unavailable; running every suite.');
  else console.log(`Classified ${result.paths.length} paths from exact base/head Git commits.`);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries({
      ...result.flags,
      instructions_only: result.complete && instructionOnlyPaths(result.paths),
    })
      .map(([key, value]) => `${key}=${value}\n`)
      .join('')
  );
}
