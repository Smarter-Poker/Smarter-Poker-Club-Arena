import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const CUTOVER = join(ROOT, 'server/scripts/engine-up-with-maintenance-certificate.sh');
const CUTOVER_SOURCE = readFileSync(CUTOVER, 'utf8');
const SUPERVISOR = join(ROOT, 'server/scripts/engine-supervisor.sh');
const EXPECTED = 'club-arena-engine';
const EXACT_PORT_BINDING = '{"8080/tcp":[{"HostIp":"","HostPort":"8080"}]}';
const EXACT_FINGERPRINT = `container-id|2026-09-09T01:00:00.000000000Z|running|engine|true|always|sha256:verified|${EXACT_PORT_BINDING}`;
const PENDING_ENV_FINGERPRINT = `container-id|2026-09-09T01:00:00.000000000Z|running|engine|true|no|sha256:verified|${EXACT_PORT_BINDING}`;
const RECOVERY_FINGERPRINT = `rollback-id|2026-09-09T01:01:00.000000000Z|running|engine|true|always|sha256:rollback|${EXACT_PORT_BINDING}`;
const TEST_HEALTH_VERSION = 'abc123ef';
const REAL_PYTHON = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim();

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o755 });
}

type CutoverOptions = {
  safe?: boolean;
  engineExit?: number;
  fingerprint?: string;
  fingerprintAfter?: string;
  fingerprintSwitchAt?: number;
  named?: string;
  labelled?: string;
  published?: string;
  recoverIfNotRunning?: boolean;
  ensureRunningOnly?: boolean;
  remainingMs?: number;
  endDeltaMs?: number;
  expectedImageId?: string;
  dbClockSkewMs?: number | null;
  omitDbClockSkew?: boolean;
  dbClockSkewMeasuredAt?: number | null;
  omitDbClockSkewMeasuredAt?: boolean;
  liveness?: 'ok' | 'standby' | 'failed';
  unpausedFingerprint?: string;
  rollbackExit?: number;
  signalAfterMutation?: boolean;
  signalName?: 'HUP' | 'INT' | 'TERM' | 'PIPE';
  secondSignalDuringRollback?: 'HUP' | 'INT' | 'TERM' | 'PIPE';
  image?: string;
  targetFingerprint?: string;
  targetFingerprintAfter?: string;
  targetFingerprintSwitchAt?: number;
  allNamed?: string;
  allLabelled?: string;
  allPublished?: string;
  healthHttpStatus?: 200 | 503;
  healthVersion?: string;
  envSource?: string;
  publishedBindingRows?: string;
  allPublishedBindingRows?: string;
  publishedIds?: string;
  promoteEnvironment?: boolean;
  signalDuringPromotion?: boolean;
  publicHealthFails?: boolean;
  publicHealthHttpStatus?: 200 | 503;
  publicRunning?: boolean;
  publicLiveness?: 'ok' | 'standby' | 'failed';
  publicVersion?: string;
  sleepAdvanceMultiplier?: number;
  hardKillAt?:
    | 'after_candidate'
    | 'before_promotion'
    | 'after_promotion'
    | 'before_image_promotion'
    | 'after_image_promotion'
    | 'after_policy';
  committedFingerprint?: string;
  databaseLeaderVersion?: string;
  promoteImage?: boolean;
  currentImageId?: string;
};

function runCutover(opts: CutoverOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'maintenance-cutover-'));
  const cutover = join(dir, 'maintenance-cutover');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const order = join(dir, 'order');
  const engine = join(dir, 'engine-up');
  const envFile = join(dir, 'engine.env');
  const canonicalEnvFile = join(dir, 'canonical.env');
  const rollbackEnvFile = join(dir, 'rollback.env');
  const envRollbackSentinel = join(dir, '.env.pending-rollback');
  const promotionSignalMarker = join(dir, 'promotion-signalled');
  const restartPolicyCommittedMarker = join(dir, 'restart-policy-committed');
  const imagePromotedMarker = join(dir, 'image-promoted');
  const clockOffsetFile = join(dir, 'clock-offset-ms');
  const targetRestartPolicyFile = join(dir, 'target-restart-policy');
  const rollbackRestartPolicyFile = join(dir, 'rollback-restart-policy');
  const baseEnvSource =
    'SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=test-service-key\n';
  const candidateEnvSource = opts.envSource ?? baseEnvSource;
  executable(
    cutover,
    CUTOVER_SOURCE.replace(
      'ENV_ROLLBACK_SENTINEL="/opt/club-arena/server/.env.pending-rollback"',
      'ENV_ROLLBACK_SENTINEL="${ENV_ROLLBACK_SENTINEL:?test sentinel path required}"'
    )
  );
  const fingerprint = opts.fingerprint ?? EXACT_FINGERPRINT;
  const endDeltaMs = opts.endDeltaMs ?? 5 * 60_000;
  const maintenance: Record<string, unknown> = {
    active: true,
    phase: 'counting_down',
    durableConfirmed: opts.safe ?? true,
    readyForRestart: true,
    unparkedTables: 0,
    remainingMs: opts.remainingMs ?? endDeltaMs,
    breakEndsAt: Date.now() + endDeltaMs,
  };
  if (!opts.omitDbClockSkew) maintenance.dbClockSkewMs = opts.dbClockSkewMs ?? 0;
  if (!opts.omitDbClockSkewMeasuredAt) {
    maintenance.dbClockSkewMeasuredAt = opts.dbClockSkewMeasuredAt ?? Date.now();
  }
  writeFileSync(envFile, candidateEnvSource);
  writeFileSync(canonicalEnvFile, baseEnvSource);
  writeFileSync(rollbackEnvFile, baseEnvSource);

  executable(
    join(bin, 'flock'),
    `#!/bin/sh
[ -e /dev/fd/9 ] || exit 98
python3 -c 'import fcntl; fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)' 9>&9 || exit 97
: > "$LOCK_ACQUIRED_FILE"
echo lock >> "$ORDER_FILE"
exit 0
`
  );
  writeFileSync(clockOffsetFile, '0');
  executable(
    join(bin, 'sleep'),
    `#!/bin/sh
OFFSET=$(cat "$CLOCK_OFFSET_FILE")
DELAY_SECONDS="\${1:-0}"
case "$OFFSET:$DELAY_SECONDS:$SLEEP_ADVANCE_MULTIPLIER" in
  *[!0-9:]*) exit 2 ;;
esac
printf '%s' "$((OFFSET + DELAY_SECONDS * 1000 * SLEEP_ADVANCE_MULTIPLIER))" > "$CLOCK_OFFSET_FILE"
exit 0
`
  );
  executable(
    join(bin, 'python3'),
    `#!/bin/sh
if [ "$1" = "-c" ] && [ "$2" = "import time; print(round(time.time() * 1000))" ]; then
  OFFSET=$(cat "$CLOCK_OFFSET_FILE")
  printf '%s\n' "$((CLOCK_BASE_MS + OFFSET))"
  exit 0
fi
exec "$REAL_PYTHON" "$@"
`
  );
  executable(
    join(bin, 'docker'),
    `#!/bin/sh
case "$1:$2" in
  container:inspect)
    case "$*" in
      *'{{.Name}}|{{json .HostConfig.PortBindings}}'*)
        case "$*" in
          *recovered-publisher-id*) printf '%s\\n' "$RECOVERED_PORT_BINDING_ROWS" ;;
          *all-publisher-id*) printf '%s\\n' "$ALL_PORT_BINDING_ROWS" ;;
          *) printf '%s\\n' "$PORT_BINDING_ROWS" ;;
        esac
        exit 0
        ;;
    esac
    echo inspect >> "$ORDER_FILE"
    COUNT=0
    [ -f "$INSPECT_COUNT_FILE" ] && COUNT=$(cat "$INSPECT_COUNT_FILE")
    COUNT=$((COUNT + 1)); printf '%s' "$COUNT" > "$INSPECT_COUNT_FILE"
    if [ -f "$RECOVERY_MARKER" ]; then
      printf '%s\\n' "$RECOVERY_FINGERPRINT"
    elif [ -f "$UNPAUSE_MARKER" ] && [ -n "$FINGERPRINT_UNPAUSED" ]; then
      printf '%s\\n' "$FINGERPRINT_UNPAUSED"
    elif [ -f "$TARGET_MARKER" ]; then
      if [ -f "$RESTART_POLICY_COMMITTED_MARKER" ]; then
        printf '%s\\n' "$TARGET_COMMITTED_FINGERPRINT"
      elif [ -n "$TARGET_FINGERPRINT_AFTER" ] && [ "$COUNT" -ge "$TARGET_FINGERPRINT_SWITCH_AT" ]; then
        printf '%s\\n' "$TARGET_FINGERPRINT_AFTER"
      else
        printf '%s\\n' "$TARGET_FINGERPRINT"
      fi
    elif [ -z "$FINGERPRINT" ]; then
      exit 1
    elif [ "$COUNT" -ge "$FINGERPRINT_SWITCH_AT" ] && [ -n "$TEST_FINGERPRINT_AFTER" ]; then
      printf '%s\\n' "$TEST_FINGERPRINT_AFTER"
    else
      printf '%s\\n' "$FINGERPRINT"
    fi
    ;;
  image:inspect)
    echo image >> "$ORDER_FILE"
    [ -n "$EXPECTED_IMAGE_ID" ] || exit 1
    case "$*" in
      *club-arena-engine:current*)
        if [ -f "$IMAGE_PROMOTED_MARKER" ]; then
          printf '%s\\n' "$EXPECTED_IMAGE_ID"
        else
          printf '%s\\n' "$TEST_ROLLBACK_IMAGE_ID"
        fi
        ;;
      *) printf '%s\\n' "$EXPECTED_IMAGE_ID" ;;
    esac
    ;;
  tag:*)
    case "$*" in
      *club-arena-engine:current*)
        if [ "$2" = "$TEST_ROLLBACK_IMAGE_ID" ]; then
          echo restore-image >> "$ORDER_FILE"
          rm -f "$IMAGE_PROMOTED_MARKER"
        else
          if [ "$HARD_KILL_AT" = "before_image_promotion" ]; then
            kill -KILL "$PPID"
            exit 137
          fi
          echo promote-image >> "$ORDER_FILE"
          touch "$IMAGE_PROMOTED_MARKER"
          if [ "$HARD_KILL_AT" = "after_image_promotion" ]; then
            kill -KILL "$PPID"
            exit 137
          fi
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  unpause:*)
    echo unpause >> "$ORDER_FILE"
    touch "$UNPAUSE_MARKER"
    ;;
  start:*)
    echo start >> "$ORDER_FILE"
    touch "$TARGET_MARKER"
    ;;
  update:*)
    case "$*" in
      *'--restart always'*)
        echo update-restart-always >> "$ORDER_FILE"
        touch "$RESTART_POLICY_COMMITTED_MARKER"
        if [ "$HARD_KILL_AT" = "after_policy" ]; then kill -KILL "$PPID"; fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  ps:*)
    NAMES="$NAMED_CONTAINERS"; LABELS="$LABELLED_ENGINES"; PORTS="$PORT_PUBLISHERS"
    PREFIX=""
    RECOVERED=0
    if [ -f "$UNPAUSE_MARKER" ] || [ -f "$RECOVERY_MARKER" ] || [ -f "$TARGET_MARKER" ]; then
      NAMES="$RECOVERED_NAMED_CONTAINERS"
      LABELS="$RECOVERED_LABELLED_ENGINES"
      PORTS="$RECOVERED_PORT_PUBLISHERS"
      RECOVERED=1
    fi
    case " $* " in
      *" -aq "*)
        echo all-publishers >> "$ORDER_FILE"
        if [ "$RECOVERED" = 1 ]; then
          printf '%s\\n' recovered-publisher-id
        elif [ -n "$ALL_PORT_PUBLISHERS" ]; then
          printf '%s\\n' all-publisher-id
        fi
        exit 0
        ;;
      *" -q "*)
        echo publishers >> "$ORDER_FILE"
        if [ "$RECOVERED" = 1 ]; then
          printf '%s\\n' recovered-publisher-id
        elif [ -n "$PORT_PUBLISHERS" ]; then
          printf '%s\\n' "$PORT_PUBLISHER_IDS"
        fi
        exit 0
        ;;
      *" -a "*)
        if [ "$RECOVERED" != 1 ]; then
          NAMES="$ALL_NAMED_CONTAINERS"
          LABELS="$ALL_LABELLED_ENGINES"
          PORTS="$ALL_PORT_PUBLISHERS"
        fi
        PREFIX="all-"
        ;;
    esac
    case "$*" in
      *name=*) echo "\${PREFIX}names" >> "$ORDER_FILE"; printf '%s\\n' "$NAMES" ;;
      *label=sp.role=engine*) echo "\${PREFIX}labels" >> "$ORDER_FILE"; printf '%s\\n' "$LABELS" ;;
      *publish=*) echo "\${PREFIX}publishers" >> "$ORDER_FILE"; printf '%s\\n' "$PORTS" ;;
      *) exit 2 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`
  );
  executable(
    join(bin, 'curl'),
    `#!/bin/sh
case "$*" in
  *fn_db_now*)
    echo db >> "$ORDER_FILE"
    python3 -c 'import datetime,json,os; print(json.dumps((datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(milliseconds=float(os.environ["DB_CLOCK_SKEW_MS"]))).isoformat()))'
    ;;
  *engine_leader*)
    echo leader >> "$ORDER_FILE"
    python3 -c 'import datetime,json,os; print(json.dumps([{"engine_version": os.environ["DB_LEADER_VERSION"], "heartbeat_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}]))'
    ;;
  *)
    echo health >> "$ORDER_FILE"
    case "$*" in
      *engine.smarter.poker*)
        [ "$PUBLIC_HEALTH_FAILS" != "1" ] || exit 22
        printf '%s' "$PUBLIC_HEALTH_JSON"
        case "$*" in *%{http_code}*) printf '\\n%s\\n' "$PUBLIC_HEALTH_HTTP_STATUS" ;; esac
        exit 0
        ;;
    esac
    printf '%s' "$HEALTH_JSON"
    case "$*" in *%{http_code}*) printf '\\n%s\\n' "$HEALTH_HTTP_STATUS" ;; esac
    ;;
esac
`
  );
  executable(
    join(bin, 'mv'),
    `#!/bin/sh
LAST_ARG=""
for ARG in "$@"; do LAST_ARG="$ARG"; done
if [ "$LAST_ARG" = "$CANONICAL_ENV_FILE" ] && [ "$HARD_KILL_AT" = "before_promotion" ]; then
  kill -KILL "$PPID"
  exit 137
fi
/bin/mv "$@" || exit $?
if [ "$LAST_ARG" = "$CANONICAL_ENV_FILE" ]; then
  echo promote-env >> "$ORDER_FILE"
  if [ "$HARD_KILL_AT" = "after_promotion" ]; then kill -KILL "$PPID"; fi
fi
if [ "$LAST_ARG" = "$CANONICAL_ENV_FILE" ] && [ "$SIGNAL_DURING_PROMOTION" = "1" ] && [ ! -f "$PROMOTION_SIGNAL_MARKER" ]; then
  touch "$PROMOTION_SIGNAL_MARKER"
  kill -TERM "$PPID"
fi
`
  );
  executable(
    engine,
    `#!/bin/sh
[ "$ENGINE_UP_LOCK_HELD" = "1" ] && [ -e /dev/fd/9 ] && [ -f "$LOCK_ACQUIRED_FILE" ] || exit 90
if python3 -c 'import fcntl,sys; handle=open(sys.argv[1], "w"); fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)' "$LOCK_FILE" 2>/dev/null; then
  exit 91
fi
echo "engine:$ENGINE_UP_LOCK_HELD:$IMAGE" >> "$ORDER_FILE"
if [ "$IMAGE" = "$TEST_ROLLBACK_IMAGE_ID" ]; then
  printf '%s' "$ENGINE_UP_RESTART_POLICY" > "$ROLLBACK_RESTART_POLICY_FILE"
  if [ -n "$SECOND_SIGNAL_DURING_ROLLBACK" ]; then
    kill -"$SECOND_SIGNAL_DURING_ROLLBACK" "$PPID"
  fi
  touch "$RECOVERY_MARKER"
  exit ${opts.rollbackExit ?? 0}
fi
printf '%s' "$ENGINE_UP_RESTART_POLICY" > "$TARGET_RESTART_POLICY_FILE"
if [ ${opts.engineExit ?? 0} -eq 0 ]; then touch "$TARGET_MARKER"; fi
if [ "$HARD_KILL_AT" = "after_candidate" ]; then
  kill -KILL "$PPID"
fi
if [ "$SIGNAL_AFTER_MUTATION" = "1" ]; then
  kill -"$SIGNAL_NAME" "$PPID"
  exit 0
fi
exit ${opts.engineExit ?? 0}
`
  );

  const result = spawnSync('bash', [cutover], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      ORDER_FILE: order,
      INSPECT_COUNT_FILE: join(dir, 'inspect-count'),
      LOCK_ACQUIRED_FILE: join(dir, 'lock-acquired'),
      UNPAUSE_MARKER: join(dir, 'unpaused'),
      RECOVERY_MARKER: join(dir, 'recovered'),
      TARGET_MARKER: join(dir, 'target-started'),
      RESTART_POLICY_COMMITTED_MARKER: restartPolicyCommittedMarker,
      IMAGE_PROMOTED_MARKER: imagePromotedMarker,
      CLOCK_OFFSET_FILE: clockOffsetFile,
      CLOCK_BASE_MS: String(Date.now()),
      REAL_PYTHON,
      TARGET_RESTART_POLICY_FILE: targetRestartPolicyFile,
      ROLLBACK_RESTART_POLICY_FILE: rollbackRestartPolicyFile,
      FINGERPRINT: fingerprint,
      TEST_FINGERPRINT_AFTER: opts.fingerprintAfter ?? '',
      FINGERPRINT_SWITCH_AT: String(opts.fingerprintSwitchAt ?? 2),
      FINGERPRINT_UNPAUSED: opts.unpausedFingerprint ?? '',
      RECOVERY_FINGERPRINT,
      TARGET_FINGERPRINT:
        opts.targetFingerprint ??
        (opts.promoteEnvironment || opts.promoteImage
          ? PENDING_ENV_FINGERPRINT
          : EXACT_FINGERPRINT),
      TARGET_COMMITTED_FINGERPRINT: opts.committedFingerprint ?? EXACT_FINGERPRINT,
      TARGET_FINGERPRINT_AFTER: opts.targetFingerprintAfter ?? '',
      TARGET_FINGERPRINT_SWITCH_AT: String(opts.targetFingerprintSwitchAt ?? 999),
      NAMED_CONTAINERS: opts.named ?? (fingerprint.includes('|running|') ? EXPECTED : ''),
      LABELLED_ENGINES: opts.labelled ?? (fingerprint.includes('|running|') ? EXPECTED : ''),
      PORT_PUBLISHERS: opts.published ?? (fingerprint.includes('|running|') ? EXPECTED : ''),
      RECOVERED_NAMED_CONTAINERS: EXPECTED,
      RECOVERED_LABELLED_ENGINES: EXPECTED,
      RECOVERED_PORT_PUBLISHERS: EXPECTED,
      ALL_NAMED_CONTAINERS: opts.allNamed ?? (fingerprint ? EXPECTED : ''),
      ALL_LABELLED_ENGINES: opts.allLabelled ?? (fingerprint ? EXPECTED : ''),
      ALL_PORT_PUBLISHERS: opts.allPublished ?? (fingerprint ? EXPECTED : ''),
      PORT_BINDING_ROWS:
        opts.publishedBindingRows ??
        `/${opts.published ?? (fingerprint.includes('|running|') ? EXPECTED : '')}|${EXACT_PORT_BINDING}`,
      PORT_PUBLISHER_IDS: opts.publishedIds ?? 'running-publisher-id',
      ALL_PORT_BINDING_ROWS:
        opts.allPublishedBindingRows ??
        `/${opts.allPublished ?? (fingerprint ? EXPECTED : '')}|${EXACT_PORT_BINDING}`,
      RECOVERED_PORT_BINDING_ROWS: `/${EXPECTED}|${EXACT_PORT_BINDING}`,
      HEALTH_JSON: JSON.stringify({
        running: true,
        liveness: opts.liveness ?? 'ok',
        version: opts.healthVersion ?? TEST_HEALTH_VERSION,
        maintenance,
      }),
      PUBLIC_HEALTH_JSON: JSON.stringify({
        running: opts.publicRunning ?? true,
        liveness: opts.publicLiveness ?? 'ok',
        version: opts.publicVersion ?? opts.healthVersion ?? TEST_HEALTH_VERSION,
        maintenance,
      }),
      DB_CLOCK_SKEW_MS: String(opts.dbClockSkewMs ?? 0),
      DB_LEADER_VERSION: opts.databaseLeaderVersion ?? TEST_HEALTH_VERSION,
      HEALTH_HTTP_STATUS: String(
        opts.healthHttpStatus ??
          (opts.liveness === 'standby' || opts.liveness === 'failed' ? 503 : 200)
      ),
      PUBLIC_HEALTH_HTTP_STATUS: String(opts.publicHealthHttpStatus ?? 200),
      EXPECTED_IMAGE_ID: opts.expectedImageId ?? 'sha256:verified',
      TEST_ROLLBACK_IMAGE_ID: opts.currentImageId ?? 'sha256:rollback',
      LOCK_FILE: join(dir, 'lock'),
      ENGINE_UP_SCRIPT: engine,
      ENV_FILE: envFile,
      ...(opts.promoteEnvironment
        ? {
            ROLLBACK_ENV_FILE: rollbackEnvFile,
            CERTIFICATE_ENV_FILE: rollbackEnvFile,
            PROMOTE_ENV_FILE_TO: canonicalEnvFile,
            PUBLIC_HEALTH_URL: 'https://engine.smarter.poker/health',
          }
        : {}),
      ...(opts.promoteImage
        ? {
            PROMOTE_IMAGE_TO: 'club-arena-engine:current',
            PUBLIC_HEALTH_URL: 'https://engine.smarter.poker/health',
            REQUIRED_DATABASE_VERSION: TEST_HEALTH_VERSION,
          }
        : {}),
      IMAGE: opts.image ?? 'club-arena-engine:target',
      ROLLBACK_IMAGE: 'club-arena-engine:current',
      MIN_BREAK_LEFT_MS: '180000',
      MAX_REMAINING_SKEW_MS: '15000',
      MAX_DB_CLOCK_SKEW_MS: '5000',
      RECOVER_IF_NOT_RUNNING: opts.recoverIfNotRunning ? '1' : '0',
      ENSURE_RUNNING_ONLY: opts.ensureRunningOnly ? '1' : '0',
      SIGNAL_AFTER_MUTATION: opts.signalAfterMutation ? '1' : '0',
      SIGNAL_NAME: opts.signalName ?? 'TERM',
      SECOND_SIGNAL_DURING_ROLLBACK: opts.secondSignalDuringRollback ?? '',
      SIGNAL_DURING_PROMOTION: opts.signalDuringPromotion ? '1' : '0',
      PROMOTION_SIGNAL_MARKER: promotionSignalMarker,
      CANONICAL_ENV_FILE: canonicalEnvFile,
      ENV_ROLLBACK_SENTINEL: envRollbackSentinel,
      HARD_KILL_AT: opts.hardKillAt ?? '',
      PUBLIC_HEALTH_FAILS: opts.publicHealthFails ? '1' : '0',
      SLEEP_ADVANCE_MULTIPLIER: String(opts.sleepAdvanceMultiplier ?? 1),
    },
  });
  const steps = readFileSync(order, 'utf8').trim().split('\n');
  return {
    dir,
    result,
    steps,
    envFile,
    canonicalEnvFile,
    rollbackEnvFile,
    envRollbackSentinel,
    restartPolicyCommittedMarker,
    imagePromotedMarker,
    clockOffsetFile,
    targetRestartPolicyFile,
    rollbackRestartPolicyFile,
    baseEnvSource,
    candidateEnvSource,
  };
}

function reconcileCrashedEnvironment(run: ReturnType<typeof runCutover>) {
  const bin = join(run.dir, 'supervisor-bin');
  mkdirSync(bin);
  const order = join(run.dir, 'supervisor-order');
  const dockerState = join(run.dir, 'persisted-docker-state');
  const stateDir = join(run.dir, 'supervisor-state');
  const metricDir = join(run.dir, 'supervisor-metrics');
  const engine = join(run.dir, 'supervisor-engine-up');
  const supervisor = join(run.dir, 'engine-supervisor');
  const candidateDigest = createHash('sha256').update(run.candidateEnvSource).digest('hex');
  const rollbackDigest = createHash('sha256').update(run.baseEnvSource).digest('hex');

  // This state is deliberately persisted after the cutover process has been
  // SIGKILLed. A reboot leaves restart=no stopped; the fresh supervisor process
  // must not rely on any variable or trap from the dead wrapper.
  writeFileSync(dockerState, `exited|engine|true|no|${candidateDigest}|sha256:verified\n`);
  executable(
    supervisor,
    readFileSync(SUPERVISOR, 'utf8')
      .replace(
        'CANONICAL_ENV_FILE="/opt/club-arena/server/.env"',
        `CANONICAL_ENV_FILE=${JSON.stringify(run.canonicalEnvFile)}`
      )
      .replace(
        'ENV_ROLLBACK_SENTINEL="/opt/club-arena/server/.env.pending-rollback"',
        `ENV_ROLLBACK_SENTINEL=${JSON.stringify(run.envRollbackSentinel)}`
      )
  );

  executable(
    join(bin, 'flock'),
    `#!/bin/sh
[ -e /dev/fd/9 ] || exit 98
echo supervisor-lock >> "$SUPERVISOR_ORDER"
exit 0
`
  );
  executable(join(bin, 'logger'), '#!/bin/sh\nexit 0\n');
  executable(
    join(bin, 'docker'),
    `#!/bin/sh
case "$1:$2" in
  info:*) echo docker-info >> "$SUPERVISOR_ORDER" ;;
  image:inspect)
    echo image-inspect >> "$SUPERVISOR_ORDER"
    printf '%s\n' sha256:rollback
    ;;
  container:inspect)
    case "$*" in
      *sp.env-sha256*)
        echo verify-container >> "$SUPERVISOR_ORDER"
        cat "$SUPERVISOR_DOCKER_STATE"
        ;;
      *) exit 0 ;;
    esac
    ;;
  *) echo "unexpected-docker:$*" >> "$SUPERVISOR_ORDER"; exit 2 ;;
esac
`
  );
  executable(
    engine,
    `#!/bin/sh
[ "$ENGINE_UP_LOCK_HELD" = 1 ] || exit 90
[ "$ENGINE_UP_RESTART_POLICY" = always ] || exit 91
[ "$ENV_FILE" = "$CANONICAL_ENV_FILE" ] || exit 92
DIGEST=$(sha256sum "$ENV_FILE" | awk '{print $1}') || exit 93
printf 'running|engine|true|always|%s|sha256:rollback\n' "$DIGEST" > "$SUPERVISOR_DOCKER_STATE"
echo recreate-from-canonical >> "$SUPERVISOR_ORDER"
`
  );

  const result = spawnSync('bash', [supervisor], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SUPERVISOR_ORDER: order,
      SUPERVISOR_DOCKER_STATE: dockerState,
      CONTAINER: EXPECTED,
      IMAGE: 'club-arena-engine:current',
      PORT: '8080',
      UP_SCRIPT: engine,
      CANONICAL_ENV_FILE: run.canonicalEnvFile,
      ENV_ROLLBACK_SENTINEL: run.envRollbackSentinel,
      LOCK_FILE: join(run.dir, 'supervisor-lock'),
      STATE_DIR: stateDir,
      TEXTFILE_DIR: metricDir,
    },
  });

  return {
    result,
    order: readFileSync(order, 'utf8').trim().split('\n'),
    dockerState,
    rollbackDigest,
  };
}

describe('the maintenance certificate and engine mutation share one host lock', () => {
  it('identifies the sole labelled/published container, reads its exact certificate, rechecks identity, then mutates', () => {
    expect(CUTOVER_SOURCE).toContain("curl -q --noproxy '*'");
    expect(CUTOVER_SOURCE).toContain('curl -q --config /dev/fd/8');
    expect(CUTOVER_SOURCE).not.toMatch(/-H "(?:apikey|Authorization): \$service_key"/);
    const { result, steps } = runCutover();
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'image',
      'health',
      'db',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'inspect',
      'engine:1:sha256:verified',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'health',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'inspect',
    ]);
  });

  it('refuses before health or mutation when another labelled engine is running', () => {
    const { result, steps } = runCutover({ labelled: `${EXPECTED}\nrogue-engine` });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(result.stdout).toMatch(/labelled-engine set is not exactly/);
  });

  it('refuses before health or mutation when another container publishes the engine port', () => {
    const { result, steps } = runCutover({ published: 'lookalike' });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(result.stdout).toMatch(/publisher of host port/);
  });

  it('finds host 8080 ownership on the second container even when its private port is 9090', () => {
    const rogueBinding = '{"9090/tcp":[{"HostIp":"","HostPort":"8080"}]}';
    const { result, steps } = runCutover({
      published: `${EXPECTED}\nrogue-port-owner`,
      publishedIds: 'first-id\nsecond-id',
      publishedBindingRows: `/${EXPECTED}|${EXACT_PORT_BINDING}\n/rogue-port-owner|${rogueBinding}`,
    });
    expect(result.status).toBe(75);
    expect(steps).not.toContain('health');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/publisher of host port 8080/);
  });

  it('refuses a certificate whose remainingMs disagrees with breakEndsAt minus now', () => {
    const { result, steps } = runCutover({ remainingMs: 4 * 60_000 });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'image',
      'health',
      'db',
    ]);
    expect(result.stdout).toMatch(/remainingSkew/);
  });

  it('refuses a self-consistent certificate outside the fixed five-minute break', () => {
    const { result, steps } = runCutover({
      remainingMs: 5 * 60_000 + 1_000,
      endDeltaMs: 5 * 60_000 + 1_000,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'image',
      'health',
      'db',
    ]);
    expect(result.stdout).toMatch(/remaining=301000/);
  });

  it('requires a finite, recent database-clock measurement inside the five-second bound', () => {
    const missing = runCutover({ omitDbClockSkew: true });
    expect(missing.result.status).toBe(75);
    expect(missing.result.stdout).toMatch(/reportedDbClockSkew=None/);

    const excessive = runCutover({ dbClockSkewMs: 5_001 });
    expect(excessive.result.status).toBe(75);
    expect(excessive.result.stdout).toMatch(/dbClockSkew=\d+/);
    expect(excessive.steps.some((step) => step.startsWith('engine:'))).toBe(false);

    // This additive publisher ships in the target build. The outgoing legacy
    // build may not have it yet, so the fresh direct database probe remains
    // authoritative and avoids a one-release bootstrap deadlock.
    const legacyHealth = runCutover({ omitDbClockSkewMeasuredAt: true });
    expect(legacyHealth.result.status, legacyHealth.result.stderr).toBe(0);
    expect(legacyHealth.steps).toContain('db');

    const stale = runCutover({ dbClockSkewMeasuredAt: Date.now() - 120_001 });
    expect(stale.result.status).toBe(75);
    expect(stale.result.stdout).toMatch(/reportedDbClockAge=12\d{4}/);

    const future = runCutover({ dbClockSkewMeasuredAt: Date.now() + 60_000 });
    expect(future.result.status).toBe(75);
    expect(future.result.stdout).toMatch(/reportedDbClockAge=-/);
  }, 45_000);

  it('uses database-adjusted time, not only local time, for the three-minute floor', () => {
    const { result } = runCutover({
      remainingMs: 181_000,
      endDeltaMs: 181_000,
      dbClockSkewMs: -2_000,
    });
    expect(result.status).toBe(75);
    expect(result.stdout).toMatch(/dbEndDelta=17\d{4}/);
  });

  it('refuses a running container whose host port is not exactly bound to container 8080', () => {
    expect(CUTOVER_SOURCE).toContain('[ "$PORT" = "8080" ]');
    const wrongBinding =
      'container-id|2026-09-09T01:00:00.000000000Z|running|engine|true|always|sha256:verified|' +
      '{"9090/tcp":[{"HostIp":"","HostPort":"8080"}]}';
    const { result, steps } = runCutover({ fingerprint: wrongBinding });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(result.stdout).toMatch(/exact 8080:8080-only published-port run spec/);
    expect(steps).not.toContain('health');
  });

  it('refuses when durable proof is absent', () => {
    const { result, steps } = runCutover({ safe: false });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'image',
      'health',
      'db',
    ]);
    expect(result.stdout).toMatch(/REFUSED before mutation/);
  });

  it('invalidates proof when the container restarts while its certificate is read', () => {
    const { result, steps } = runCutover({
      fingerprintAfter: `container-id|2026-09-09T01:55:01.000000000Z|running|engine|true|always|sha256:verified|${EXACT_PORT_BINDING}`,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'image',
      'health',
      'db',
      'inspect',
    ]);
    expect(result.stdout).toMatch(/changed identity/);
  });

  it('invalidates proof when the container restarts during final authority inventory', () => {
    const { result, steps } = runCutover({
      fingerprintAfter: `container-id|2026-09-09T01:55:01.000000000Z|running|engine|true|always|sha256:verified|${EXACT_PORT_BINDING}`,
      fingerprintSwitchAt: 3,
    });
    expect(result.status).toBe(75);
    expect(steps.filter((step) => step === 'inspect')).toHaveLength(3);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/final certificate authority was revalidated/);
  });

  it('never misclassifies a post-authorization child status 75 as a safe refusal', () => {
    const { result, steps } = runCutover({ engineExit: 75 });
    expect(steps).toContain('engine:1:sha256:verified');
    expect(steps).toContain('engine:1:sha256:rollback');
    expect(result.status).toBe(76);
    expect(result.status).not.toBe(75);
    expect(result.stdout).toMatch(/failed after authorization/);
    expect(result.stdout).toMatch(/host-local recovery verified/);
  });

  it('restores the verified recovery image for HUP, INT, TERM, and PIPE after mutation starts', () => {
    expect(CUTOVER_SOURCE).toContain('trap on_mutation_signal HUP INT TERM PIPE');
    expect(CUTOVER_SOURCE).toContain('trap on_mutation_exit EXIT');
    for (const signalName of ['HUP', 'INT', 'TERM', 'PIPE'] as const) {
      const { result, steps } = runCutover({ signalAfterMutation: true, signalName });
      expect(result.status).toBe(76);
      expect(steps).toContain('engine:1:sha256:verified');
      expect(steps).toContain('engine:1:sha256:rollback');
      expect(result.stdout).toMatch(/received a cancellation signal after mutation began/);
      expect(result.stdout).toMatch(/host-local recovery verified/);
    }
  }, 45_000);

  it('promotes a staged environment only after the exact target is healthy', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=verified\n';
    const run = runCutover({ promoteEnvironment: true, envSource: candidate });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.steps).toContain('engine:1:sha256:verified');
    expect(readFileSync(run.targetRestartPolicyFile, 'utf8')).toBe('no');
    expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(candidate);
    expect(readFileSync(run.rollbackEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(readFileSync(run.envFile, 'utf8')).toBe(candidate);
    expect(existsSync(run.restartPolicyCommittedMarker)).toBe(true);
    expect(existsSync(run.envRollbackSentinel)).toBe(false);
    expect(run.result.stdout).toMatch(
      /durably promoted the environment used by the verified target/
    );
    const engineStarted = run.steps.indexOf('engine:1:sha256:verified');
    const promotion = run.steps.indexOf('promote-env');
    const restartCommit = run.steps.indexOf('update-restart-always');
    const healthBeforePromotion = run.steps
      .map((step, index) => ({ step, index }))
      .filter(({ step, index }) => step === 'health' && index > engineStarted && index < promotion);
    const healthAfterCommit = run.steps.findIndex(
      (step, index) => step === 'health' && index > restartCommit
    );
    expect(healthBeforePromotion).toHaveLength(4);
    expect(promotion).toBeGreaterThan(engineStarted);
    expect(restartCommit).toBeGreaterThan(promotion);
    expect(healthAfterCommit).toBeGreaterThan(restartCommit);
  }, 20_000);

  it('rolls back when the candidate cannot pass fresh public health before promotion', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=public-proof-fails\n';
    const run = runCutover({
      promoteEnvironment: true,
      envSource: candidate,
      publicHealthFails: true,
    });
    expect(run.result.status).toBe(76);
    expect(run.steps).toContain('engine:1:sha256:verified');
    expect(run.steps).toContain('engine:1:sha256:rollback');
    expect(readFileSync(run.rollbackRestartPolicyFile, 'utf8')).toBe('always');
    expect(readFileSync(run.targetRestartPolicyFile, 'utf8')).toBe('no');
    expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(existsSync(run.restartPolicyCommittedMarker)).toBe(false);
  }, 20_000);

  it('requires public HTTP 200, running=true, liveness=ok, and the exact version before promotion', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=public-must-be-serving\n';
    const invalidPublicProofs: CutoverOptions[] = [
      { publicHealthHttpStatus: 503 },
      { publicRunning: false },
      { publicLiveness: 'standby' },
      { publicVersion: 'not-target' },
    ];

    for (const invalidPublicProof of invalidPublicProofs) {
      const run = runCutover({
        promoteEnvironment: true,
        envSource: candidate,
        sleepAdvanceMultiplier: 12,
        ...invalidPublicProof,
      });
      expect(run.result.status).toBe(76);
      expect(run.steps).not.toContain('promote-env');
      expect(run.steps).not.toContain('update-restart-always');
      expect(run.steps).toContain('engine:1:sha256:rollback');
      expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(run.baseEnvSource);
    }
  }, 30_000);

  it('commits an image pointer and restart policy only after public and database proof', () => {
    const run = runCutover({ promoteImage: true });
    expect(run.result.status, run.result.stderr).toBe(0);
    expect(readFileSync(run.targetRestartPolicyFile, 'utf8')).toBe('no');
    const engineStarted = run.steps.indexOf('engine:1:sha256:verified');
    const publicHealth = run.steps.findIndex(
      (step, index) => step === 'health' && index > engineStarted
    );
    const leader = run.steps.indexOf('leader');
    const promotion = run.steps.indexOf('promote-image');
    const restartCommit = run.steps.indexOf('update-restart-always');
    expect(publicHealth).toBeGreaterThan(engineStarted);
    expect(leader).toBeGreaterThan(publicHealth);
    expect(promotion).toBeGreaterThan(leader);
    expect(restartCommit).toBeGreaterThan(promotion);
    expect(existsSync(run.imagePromotedMarker)).toBe(true);
    expect(existsSync(run.restartPolicyCommittedMarker)).toBe(true);
  }, 15_000);

  it('refuses an immutable image whose own health version is not the required target SHA', () => {
    const run = runCutover({
      promoteImage: true,
      healthVersion: 'feedface',
      publicVersion: 'feedface',
    });
    expect(run.result.status).toBe(76);
    expect(run.steps).not.toContain('promote-image');
    expect(run.steps).not.toContain('update-restart-always');
    expect(run.steps).not.toContain('leader');
    expect(run.steps).toContain('engine:1:sha256:rollback');
    expect(run.result.stdout).toContain('not required version abc123ef');
  }, 15_000);

  it('rolls an image candidate back when the fresh database leader never names it', () => {
    const run = runCutover({
      promoteImage: true,
      databaseLeaderVersion: 'previous',
      sleepAdvanceMultiplier: 12,
    });
    expect(run.result.status).toBe(76);
    expect(run.steps).not.toContain('promote-image');
    expect(run.steps).not.toContain('update-restart-always');
    expect(run.steps).toContain('engine:1:sha256:rollback');
    expect(run.steps.filter((step) => step === 'leader').length).toBeLessThan(24);
    expect(Number(readFileSync(run.clockOffsetFile, 'utf8'))).toBeLessThanOrEqual(120_000);
    expect(CUTOVER_SOURCE).toContain('PROMOTION_START_FLOOR_MS=285000');
    expect(CUTOVER_SOURCE).toContain('ROLLBACK_RESERVE_MS=180000');
    expect(CUTOVER_SOURCE).toContain(
      'TARGET_PROOF_DEADLINE_MS=$((CERTIFIED_BREAK_END_MS - ROLLBACK_RESERVE_MS))'
    );
  }, 15_000);

  it('refuses promotion before mutation unless the absolute break deadline preserves rollback time', () => {
    const run = runCutover({
      promoteImage: true,
      remainingMs: 284_999,
      endDeltaMs: 284_999,
    });
    expect(run.result.status).toBe(75);
    expect(run.steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(run.result.stdout).toMatch(
      /direct certificate was not exact, fresh, and internally consistent/
    );
  });

  it('leaves a deterministic reboot decision on both sides of image-pointer promotion', () => {
    for (const [point, promoted] of [
      ['before_image_promotion', false],
      ['after_image_promotion', true],
    ] as const) {
      const run = runCutover({ promoteImage: true, hardKillAt: point });
      expect(run.result.status).toBeNull();
      expect(run.result.signal).toBe('SIGKILL');
      expect(readFileSync(run.targetRestartPolicyFile, 'utf8')).toBe('no');
      expect(existsSync(run.imagePromotedMarker)).toBe(promoted);
      expect(existsSync(run.restartPolicyCommittedMarker)).toBe(false);
    }
  }, 15_000);

  it('rolls back if restart-policy commit changes the verified container identity', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=identity-race\n';
    const changed = `replacement-id|2026-09-09T01:02:00.000000000Z|running|engine|true|always|sha256:verified|${EXACT_PORT_BINDING}`;
    const run = runCutover({
      promoteEnvironment: true,
      envSource: candidate,
      committedFingerprint: changed,
    });
    expect(run.result.status).toBe(76);
    expect(run.steps).toContain('update-restart-always');
    expect(run.steps).toContain('engine:1:sha256:rollback');
    expect(readFileSync(run.rollbackRestartPolicyFile, 'utf8')).toBe('always');
    expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(run.result.stdout).toMatch(/engine identity changed while restart=always was committed/);
  }, 15_000);

  it('leaves only reboot-safe state at every SIGKILL boundary of environment commit', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=hard-crash\n';
    const cases = [
      { point: 'after_candidate', canonical: 'old', committed: false },
      { point: 'before_promotion', canonical: 'old', committed: false },
      { point: 'after_promotion', canonical: 'new', committed: false },
      { point: 'after_policy', canonical: 'new', committed: true },
    ] as const;

    for (const crash of cases) {
      const run = runCutover({
        promoteEnvironment: true,
        envSource: candidate,
        hardKillAt: crash.point,
      });
      expect(run.result.status).toBeNull();
      expect(run.result.signal).toBe('SIGKILL');
      expect(readFileSync(run.targetRestartPolicyFile, 'utf8')).toBe('no');
      expect(readFileSync(run.canonicalEnvFile, 'utf8'), crash.point).toBe(
        crash.canonical === 'old' ? run.baseEnvSource : candidate
      );
      expect(existsSync(run.restartPolicyCommittedMarker)).toBe(crash.committed);
      expect(existsSync(run.envRollbackSentinel)).toBe(true);
      expect(readFileSync(run.envRollbackSentinel, 'utf8')).toBe(run.baseEnvSource);
      if (!crash.committed) expect(run.steps).not.toContain('update-restart-always');
    }
  }, 45_000);

  it('converges from persisted rollback state in a fresh supervisor process after wrapper SIGKILL and reboot', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=must-not-survive-reboot\n';

    for (const point of ['after_candidate', 'after_promotion'] as const) {
      const crashed = runCutover({
        promoteEnvironment: true,
        envSource: candidate,
        hardKillAt: point,
      });
      expect(crashed.result.status).toBeNull();
      expect(crashed.result.signal).toBe('SIGKILL');
      expect(existsSync(crashed.envRollbackSentinel)).toBe(true);

      const reboot = reconcileCrashedEnvironment(crashed);
      expect(reboot.result.status, reboot.result.stderr).toBe(0);
      expect(readFileSync(crashed.canonicalEnvFile, 'utf8')).toBe(crashed.baseEnvSource);
      expect(existsSync(crashed.envRollbackSentinel)).toBe(false);
      expect(readFileSync(reboot.dockerState, 'utf8').trim()).toBe(
        `running|engine|true|always|${reboot.rollbackDigest}|sha256:rollback`
      );
      expect(reboot.order).toEqual([
        'docker-info',
        'supervisor-lock',
        'recreate-from-canonical',
        'image-inspect',
        'verify-container',
      ]);
      expect(reboot.result.stdout).toMatch(/verified rollback convergence/);
    }
  }, 45_000);

  it('leaves canonical env bytes untouched on a clean certificate refusal', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=not-yet-authorized\n';
    const run = runCutover({ promoteEnvironment: true, envSource: candidate, safe: false });
    expect(run.result.status).toBe(75);
    expect(run.steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(readFileSync(run.envFile, 'utf8')).toBe(candidate);
  });

  it('keeps the canonical environment unchanged when target startup fails', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=unverified\n';
    const run = runCutover({ promoteEnvironment: true, envSource: candidate, engineExit: 7 });
    expect(run.result.status).toBe(76);
    expect(run.steps).toContain('engine:1:sha256:verified');
    expect(run.steps).toContain('engine:1:sha256:rollback');
    expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(readFileSync(run.envFile, 'utf8')).toBe(candidate);
  });

  it('restores canonical env bytes and the rollback image when a signal lands during promotion', () => {
    const candidate =
      'SUPABASE_URL=https://example.supabase.co\n' +
      'SUPABASE_SERVICE_ROLE_KEY=test-service-key\n' +
      'FEATURE_FLAG=signal-window\n';
    const run = runCutover({
      promoteEnvironment: true,
      envSource: candidate,
      signalDuringPromotion: true,
    });
    expect(run.result.status).toBe(76);
    expect(run.steps).toContain('engine:1:sha256:verified');
    expect(run.steps).toContain('engine:1:sha256:rollback');
    expect(readFileSync(run.canonicalEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(readFileSync(run.rollbackEnvFile, 'utf8')).toBe(run.baseEnvSource);
    expect(run.result.stdout).toMatch(/received a cancellation signal after mutation began/);
  }, 20_000);

  it('masks a second SSH cancellation signal before EXIT dispatches rollback', () => {
    expect(CUTOVER_SOURCE).toMatch(
      /local status="\$\?"\n(?:\s*#[^\n]*\n|\s*\n)*\s*trap '' HUP INT TERM PIPE/
    );
    const { result, steps } = runCutover({
      signalAfterMutation: true,
      signalName: 'TERM',
      secondSignalDuringRollback: 'HUP',
    });
    expect(result.status).toBe(76);
    expect(steps).toContain('engine:1:sha256:rollback');
    expect(result.stdout).toMatch(/host-local recovery verified/);
  });

  it('installs recovery traps before publishing mutation-started state', () => {
    const begin = CUTOVER_SOURCE.slice(
      CUTOVER_SOURCE.indexOf('begin_mutation_transaction()'),
      CUTOVER_SOURCE.indexOf('commit_mutation_transaction()')
    );
    expect(begin.indexOf('trap on_mutation_signal HUP INT TERM PIPE')).toBeLessThan(
      begin.indexOf('MUTATION_STARTED=1')
    );
    expect(begin.indexOf('trap on_mutation_exit EXIT')).toBeLessThan(
      begin.indexOf('MUTATION_STARTED=1')
    );
    expect(
      begin.indexOf('durable_copy_replace "$ROLLBACK_ENV_FILE" "$ENV_ROLLBACK_SENTINEL"')
    ).toBeLessThan(begin.indexOf('MUTATION_STARTED=1'));
  });
});

describe('state-safe rollback and final guarantee modes', () => {
  it('plain-recovers an absent engine only when explicitly authorized', () => {
    const { result, steps } = runCutover({
      fingerprint: '',
      named: '',
      labelled: '',
      published: '',
      recoverIfNotRunning: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'image',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'engine:1:sha256:verified',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'health',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'inspect',
    ]);
    expect(steps).toContain('health');
  });

  it('does not treat absence as cutover authority without explicit recovery mode', () => {
    const { result, steps } = runCutover({
      fingerprint: '',
      named: '',
      labelled: '',
      published: '',
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('does not recover when the expected running container is temporarily uninspectable', () => {
    const { result, steps } = runCutover({
      fingerprint: '',
      named: EXPECTED,
      labelled: '',
      published: '',
      recoverIfNotRunning: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/identity could not be inspected/);
  });

  it('ensure-only leaves an exact running engine untouched', () => {
    const { result, steps } = runCutover({
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'health',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'inspect',
    ]);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('leaves an already-restored exact previous image untouched during rollback reconciliation', () => {
    const { result, steps } = runCutover({
      image: 'club-arena-engine:previous',
      currentImageId: 'sha256:verified',
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(steps).not.toContain('promote-image');
    expect(steps).not.toContain('update-restart-always');
    expect(result.stdout).toContain('leaving it untouched');
  });

  it('refuses a running target while a foreign paused engine authority remains on the host', () => {
    const { result, steps } = runCutover({
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      allLabelled: `${EXPECTED}\nforeign-paused-engine`,
    });
    expect(result.status).toBe(75);
    expect(steps).toContain('all-labels');
    expect(steps).not.toContain('health');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('ensure-only refuses an exact image whose direct process health is not live', () => {
    const { result, steps } = runCutover({
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      liveness: 'failed',
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'health',
    ]);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('refuses a paused engine as cutover authority without mutating it', () => {
    const paused = EXACT_FINGERPRINT.replace('|running|', '|paused|');
    const { result, steps } = runCutover({ fingerprint: paused });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(steps).not.toContain('unpause');
    expect(result.stdout).toMatch(/paused; cutover cannot replace suspended engine authority/);
  });

  it('ensure-only unpauses the same validated identity and proves its direct health', () => {
    const paused = RECOVERY_FINGERPRINT.replace('|running|', '|paused|');
    const { result, steps } = runCutover({
      fingerprint: paused,
      unpausedFingerprint: RECOVERY_FINGERPRINT,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      image: 'club-arena-engine:current',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
      'unpause',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'health',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'inspect',
    ]);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/safely unpaused/);
  });

  it('recovery mode also unpauses an already-correct image instead of recreating it', () => {
    const paused = RECOVERY_FINGERPRINT.replace('|running|', '|paused|');
    const { result, steps } = runCutover({
      fingerprint: paused,
      unpausedFingerprint: RECOVERY_FINGERPRINT,
      recoverIfNotRunning: true,
      image: 'club-arena-engine:current',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toContain('unpause');
    expect(steps).toContain('health');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('refuses to unpause a validated container unless target and rollback resolve to its exact image', () => {
    const pausedTarget = EXACT_FINGERPRINT.replace('|running|', '|paused|');
    const { result, steps } = runCutover({
      fingerprint: pausedTarget,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toContain('all-names');
    expect(steps.filter((step) => step === 'image')).toHaveLength(2);
    expect(steps).not.toContain('unpause');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('does not reinterpret a transient inspect failure for a stopped container as absence', () => {
    const { result, steps } = runCutover({
      fingerprint: '',
      named: '',
      labelled: '',
      published: '',
      allNamed: EXPECTED,
      allLabelled: EXPECTED,
      allPublished: EXPECTED,
      recoverIfNotRunning: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
    ]);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('does not recover absence beside a foreign paused engine authority', () => {
    const { result, steps } = runCutover({
      fingerprint: '',
      named: '',
      labelled: '',
      published: '',
      allNamed: '',
      allLabelled: 'foreign-paused-engine',
      allPublished: 'foreign-paused-engine',
      recoverIfNotRunning: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toContain('all-labels');
    expect(steps).toContain('all-publishers');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('starts an exact stopped last-known-good container in place and proves the same identity', () => {
    const stopped = RECOVERY_FINGERPRINT.replace('|running|', '|exited|');
    const { result, steps } = runCutover({
      fingerprint: stopped,
      targetFingerprint: RECOVERY_FINGERPRINT,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      image: 'club-arena-engine:current',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toContain('start');
    expect(steps).toContain('health');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/safely started in place/);
  });

  it('rechecks health and pins the new StartedAt when autoheal restarts during stopped recovery proof', () => {
    const stopped = RECOVERY_FINGERPRINT.replace('|running|', '|exited|');
    const restarted = RECOVERY_FINGERPRINT.replace(
      '2026-09-09T01:01:00.000000000Z',
      '2026-09-09T01:02:00.000000000Z'
    );
    const { result, steps } = runCutover({
      fingerprint: stopped,
      targetFingerprint: RECOVERY_FINGERPRINT,
      targetFingerprintAfter: restarted,
      targetFingerprintSwitchAt: 4,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      image: 'club-arena-engine:current',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps.filter((step) => step === 'health')).toHaveLength(2);
    expect(result.stdout).toMatch(
      /verified the exact healthy engine image with restart=always on attempt 2/
    );
    expect(result.stdout).toMatch(/safely started in place/);
  }, 15_000);

  it('refuses transitional container states without certificate-free mutation', () => {
    const restarting = EXACT_FINGERPRINT.replace('|running|', '|restarting|');
    const { result, steps } = runCutover({
      fingerprint: restarting,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status).toBe(75);
    expect(steps).not.toContain('start');
    expect(steps).not.toContain('unpause');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/transitional or unsafe state 'restarting'/);
  });

  it('accepts a standby process body even though the real endpoint returns HTTP 503', () => {
    expect(CUTOVER_SOURCE).toContain("curl -q --noproxy '*' -sS --max-time 10");
    const { result, steps } = runCutover({
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      liveness: 'standby',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(steps).toContain('health');
  });

  it('rejects a degraded HTTP 503 body that is not an exact standby', () => {
    const { result, steps } = runCutover({
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      liveness: 'ok',
      healthHttpStatus: 503,
    });
    expect(result.status).toBe(75);
    expect(steps).toContain('health');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('explicitly refuses shell-quoted credential syntax before mutation', () => {
    const { result, steps } = runCutover({
      envSource:
        'SUPABASE_URL=https://example.supabase.co\nSUPABASE_SERVICE_ROLE_KEY="quoted-key"\n',
    });
    expect(result.status).toBe(75);
    expect(steps).toContain('health');
    expect(steps).not.toContain('db');
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });

  it('never blesses a replacement process that appears while a paused identity is unpaused', () => {
    const paused = RECOVERY_FINGERPRINT.replace('|running|', '|paused|');
    const replacement = RECOVERY_FINGERPRINT.replace('rollback-id|', 'replacement-id|');
    const { result, steps } = runCutover({
      fingerprint: paused,
      unpausedFingerprint: replacement,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
      image: 'club-arena-engine:current',
    });
    expect(result.status).toBe(76);
    expect(result.status).not.toBe(75);
    expect(steps).toContain('unpause');
    expect(steps).toContain('engine:1:sha256:rollback');
    expect(result.stdout).toMatch(/changed identity or run spec while it was unpaused/);
    expect(result.stdout).toMatch(/host-local recovery verified/);
  });

  it('ensure-only never recreates a running target with a wrong autoheal label', () => {
    const { result, steps } = runCutover({
      fingerprint: `container-id|2026-09-09T01:00:00.000000000Z|running|engine|false|always|sha256:verified|${EXACT_PORT_BINDING}`,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/autoheal=true/);
  });

  it('ensure-only refuses a running engine that is not the verified :current image', () => {
    const { result, steps } = runCutover({
      fingerprint: `container-id|2026-09-09T01:00:00.000000000Z|running|engine|true|always|sha256:other|${EXACT_PORT_BINDING}`,
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual([
      'lock',
      'inspect',
      'names',
      'labels',
      'publishers',
      'all-names',
      'all-labels',
      'all-publishers',
      'image',
    ]);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
    expect(result.stdout).toMatch(/verified recovery pointer/);
  });

  it('does not recover an absent target while another authority publishes the port', () => {
    const { result, steps } = runCutover({
      fingerprint: '',
      named: '',
      labelled: 'other-engine',
      published: 'other-engine',
      recoverIfNotRunning: true,
      ensureRunningOnly: true,
    });
    expect(result.status).toBe(75);
    expect(steps).toEqual(['lock', 'inspect', 'names', 'labels', 'publishers']);
    expect(steps.some((step) => step.startsWith('engine:'))).toBe(false);
  });
});
