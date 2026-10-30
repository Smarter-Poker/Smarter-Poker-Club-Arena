/**
 * LAW: Lightning is held at the maintenance boundary for an engine cutover,
 *      by the release transaction, through the operator door, and released
 *      after the thaw - exactly the Clusters the release paused, nothing else.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT HAPPENED (2026-10-30)
 * --------------------------
 * The legacy one-shot checkpoint over the serving original engine (EED) refuses
 * with `retained_lightning_host_census_unproven` while a single concrete
 * LightningHandHost is alive in the process. Lightning deals ~5,600 hands an
 * hour across eleven Clusters, so a host is nearly always in the air, and the
 * 15:55 UTC release attempt was refused on exactly that. The break parks
 * classic tables at a hand boundary; nothing parked Lightning.
 *
 * WHAT THIS PINS
 * --------------
 * 1. The helper exists, is packaged in the control generation and is
 *    syntax-checked before activation (the sibling law derives this too; it
 *    is pinned here by name because it is the file this law is about).
 * 2. The transaction places the hold only once the announced break is durably
 *    counting down, only on the legacy-checkpoint path, never in a drill, and
 *    a helper that cannot run says NEVER ASKED instead of a verdict.
 * 3. The transaction releases the hold on EVERY exit path (recover_on_exit),
 *    after waiting for the thaw, and engine-release-recover.sh is its second
 *    reader - so a hold outlives neither the release nor its fence.
 * 4. The helper's decision logic passes its own unit tests: a Cluster another
 *    operator paused is never claimed, a refusal is named, UNKNOWN keeps what
 *    was paused, resume touches only the held list, and no horse flag is read.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const SCRIPTS = join(ROOT, 'server', 'scripts');
const read = (name: string): string => readFileSync(join(SCRIPTS, name), 'utf8');

const HELPER = 'engine-release-lightning-hold.py';
const transaction = read('engine-release-transaction.sh');
const recover = read('engine-release-recover.sh');
const installer = read('install-engine-supervisor.sh');
const helper = read(HELPER);

describe('Lightning is held for the engine cutover', () => {
  it('ships the helper in the control generation and syntax-checks it', () => {
    expect(installer).toMatch(/\nREQUIRED_FILES=\([\s\S]*\n {2}engine-release-lightning-hold\.py\n[\s\S]*\n\)\n/);
    const pythonLoop = installer.slice(
      installer.indexOf('for script in engine-release-seal.py'),
      installer.indexOf('done', installer.indexOf('for script in engine-release-seal.py'))
    );
    expect(pythonLoop).toContain(HELPER);
    expect(transaction).toContain(`LIGHTNING_HOLD="$CONTROL_DIR/${HELPER}"`);
    expect(recover).toContain(`LIGHTNING_HOLD="$CONTROL_DIR/${HELPER}"`);
  });

  it('places the hold only once the announced break is durably counting down, on the legacy path, never in a drill', () => {
    const fn = transaction.slice(
      transaction.indexOf('hold_lightning_when_counting_down() {'),
      transaction.indexOf('\n}', transaction.indexOf('hold_lightning_when_counting_down() {'))
    );
    expect(fn).toContain('[ -z "${DRILL_MODE:-}" ] || return 0');
    expect(fn).toContain('m.get("phase") == "counting_down"');
    expect(fn).toContain('m.get("durableConfirmed") is True');
    expect(fn).toContain('"$LIGHTNING_HOLD" pause --env-file "$ENV_FILE" --run-id "$RUN_ID" --hold-file "$LIGHTNING_HOLD_FILE"');
    // Three outcomes stay distinct: placed (0/1), could-not-run (126/127), UNKNOWN (retry).
    expect(fn).toMatch(/0\|1\) LIGHTNING_HOLD_PLACED=1/);
    expect(fn).toMatch(/126\|127\)[^\n]*NEVER ASKED/);
    expect(fn).toMatch(/\*\)[^\n]*UNKNOWN/);
    // No flag may turn the hold into an admission or a refusal of the checkpoint.
    expect(fn).not.toMatch(/SKIP|FORCE|OVERRIDE|ALLOW_/);
    expect(fn).not.toContain('die ');
    // It runs on the legacy-checkpoint pass, before the entry clock starts.
    expect(transaction).toContain(
      '  if [ "$LEGACY_CHECKPOINT_REQUIRED" = 1 ]; then\n    hold_lightning_when_counting_down\n    ENTRY_STARTED_MS="$(date +%s%3N)"'
    );
  });

  it('releases the hold on every exit path after the thaw, and the fence is the second reader', () => {
    const fn = transaction.slice(
      transaction.indexOf('release_lightning_hold() {'),
      transaction.indexOf('\n}', transaction.indexOf('release_lightning_hold() {'))
    );
    expect(fn).toContain('[ -e "$LIGHTNING_HOLD_FILE" ] || return 0');
    expect(fn).toContain('m.get("active") is not True');
    expect(fn).toContain('"$LIGHTNING_HOLD" resume --env-file "$ENV_FILE" --run-id "$RUN_ID" --hold-file "$LIGHTNING_HOLD_FILE"');
    expect(fn).toMatch(/for attempt in 1 2 3; do/);
    // Bounded: never past ten minutes from now.
    expect(fn).toContain('+ 600 ))');
    const onExit = transaction.slice(
      transaction.indexOf('recover_on_exit() {'),
      transaction.indexOf('\ntrap recover_on_exit EXIT')
    );
    expect(onExit).toContain('  release_lightning_hold\n  if [ "$LOCK_HELD" = 1 ]; then');
    expect(transaction).toContain('LIGHTNING_HOLD_FILE="$REQUEST_ROOT/$RUN_ID.lightning-hold.json"');
    expect(recover).toContain('LIGHTNING_HOLD_FILE="$REQUEST_ROOT/$RUN_ID.lightning-hold.json"');
    expect(recover).toMatch(/"\$LIGHTNING_HOLD" resume \\\n\s+--env-file "\$ENV_FILE" --run-id "\$RUN_ID" --hold-file "\$LIGHTNING_HOLD_FILE"/);
    // The fence is loud but never blocks terminal retirement on a refused resume.
    expect(recover).toContain('is still not released');
    expect(recover.slice(recover.indexOf('is still not released'))).not.toMatch(/^\s*exit 1/m);
  });

  it('uses the Phase 13 operator door with the run key as operator and reason, and never a horse flag', () => {
    expect(helper).toContain('PROJECT_HOST = "kuklfnapbkmacvwxktbh.supabase.co"');
    expect(helper).toContain('/rest/v1/rpc/fn_lightning_operator_control');
    expect(helper).toContain('"p_args": {"request_id": request_id(run_id, action, cluster_id)}');
    expect(helper).toContain('"cluster_mode": "eq.lightning"');
    expect(helper).toContain('class RefuseRedirects');
    expect(helper).not.toMatch(/is_horse|horse_id/);
    expect(helper).not.toMatch(/print\([^)]*service_key/);
  });

  it('passes its own unit tests', () => {
    const result = spawnSync('python3', ['-B', join(ROOT, 'tests', 'operations', 'engine-release-lightning-hold.test.py')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toMatch(/\nOK\n?$/);
  });
});
