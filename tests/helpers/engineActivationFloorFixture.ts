import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** An operation which already entered must recover without rereading mutable Git. */
export function enteredFloorFixture(
  generation: string,
  requests: string,
  runId: string,
  targetSha: string,
  controlSha: string
) {
  writeFileSync(join(generation, 'control-sha'), `${controlSha}\n`);
  writeFileSync(
    join(generation, 'engine-release-activation-floor.py'),
    readFileSync(join(process.cwd(), 'server/scripts/engine-release-activation-floor.py'))
  );
  writeFileSync(
    join(requests, `${runId}.activation-entry`),
    JSON.stringify({
      schema: 'engine-release-activation-floor/v1',
      runId,
      targetSha,
      controlSha,
      manifestSha256: 'a'.repeat(64),
    }),
    { mode: 0o600 }
  );
}

/** macOS Bash 3 lacks mapfile; adapt only the new request reader in fixtures. */
export function portableFloorReader(source: string) {
  return source.replace(
    'mapfile -t FLOOR_REQUEST < "$REQUEST_ROOT/$RUN_ID.request"',
    'FLOOR_REQUEST=(); while IFS= read -r line; do FLOOR_REQUEST[${#FLOOR_REQUEST[@]}]="$line"; done < "$REQUEST_ROOT/$RUN_ID.request"'
  );
}
