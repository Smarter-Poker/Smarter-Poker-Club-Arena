/** Closed control-only turn census. The serving image and original journal stay read-only. */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, lstatSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateHorseTurnCensusPacket,
  horseTurnCensusPacketDigest,
  sanitizeHorseTurnCensusResult,
} from '../../scripts/ci/horse-turn-census-proof.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw Error('turn_census_transport_contract');
  return source.replace(before, after);
}

/** Reuse the maintained isolation/identity/cleanup transaction, never a second publisher. */
export function turnCensusRemoteObserver(original) {
  let source = replaceOnce(
    original,
    'fleet=p.get("mode")=="fleet"',
    'turn_census=p.get("mode")=="fleet-turns"\nfleet=p.get("mode")=="fleet" or turn_census'
  );
  source = replaceOnce(
    source,
    ' source=base64.b64decode(p["packet"],validate=True)',
    ' packet_source=base64.b64decode(p["packet"],validate=True)\n assert 0<len(packet_source)<=1048576, "fleet_packet_bounds"\n source=base64.b64decode(p["program"],validate=True) if turn_census else packet_source'
  );
  source = replaceOnce(source, ' packet=json.loads(source)', ' packet=json.loads(packet_source)');
  source = replaceOnce(
    source,
    ' args=["dist/scripts/horseJournalReview.js","--fleet",mount,"/dev/stdin"] if fleet else ["--no-warnings","--input-type=module","-","observe",declaration]',
    ' args=["--no-warnings","--input-type=module","-"] if turn_census else (["dist/scripts/horseJournalReview.js","--fleet",mount,"/dev/stdin"] if fleet else ["--no-warnings","--input-type=module","-","observe",declaration])'
  );
  return replaceOnce(source, ' assert len(r.stdout)<=16777216', ' assert len(r.stdout)<=1572864');
}

export function turnCensusProgram(packet) {
  validateHorseTurnCensusPacket(packet);
  const module = readFileSync(
    new URL('../../scripts/ci/horse-turn-census-proof.mjs', import.meta.url),
    'utf8'
  );
  // Only maintained module bytes execute. Caller data is base64 JSON, never source or a path.
  const encoded = Buffer.from(JSON.stringify(packet)).toString('base64');
  const program =
    module +
    `\ntry {
    const packet = JSON.parse(Buffer.from('${encoded}', 'base64').toString('utf8'));
    const api = await loadInstalledTurnCensusApis();
    const batch = await readInstalledTurnCensusBatch(packet, api);
    const observation = sanitizeHorseTurnCensusResult(await inspectHorseTurnCensus(packet, batch, api));
    await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(observation), error => error ? reject(error) : resolve()));
  } catch {
    await new Promise(resolve => process.stdout.write(JSON.stringify({status:'unavailable',failureCode:'turn_census_unavailable'}), resolve));
    process.exitCode = 2;
  }\n`;
  if (Buffer.byteLength(program) > 1048576) throw Error('turn_census_program_bound');
  return program;
}

function privateFile(path) {
  if (!isAbsolute(path ?? '')) throw Error('turn_census_private_paths');
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw Error('turn_census_private_paths');
  return stat;
}

export function runFleetTurnCensus(
  { packetPath, sshCommand, outputPath, remoteObserver },
  deps = {}
) {
  if (privateFile(packetPath).size > 1048576 || !isAbsolute(outputPath ?? ''))
    throw Error('turn_census_private_paths');
  // The configured authenticated wrapper is an existing private executable, never caller source.
  privateFile(sshCommand);
  const text = readFileSync(packetPath, 'utf8');
  const packet = validateHorseTurnCensusPacket(JSON.parse(text));
  const packetDigest = horseTurnCensusPacketDigest(packet);
  const program = turnCensusProgram(packet);
  const remote = turnCensusRemoteObserver(remoteObserver);
  const fd = openSync(outputPath, 'wx', 0o600);
  try {
    const runId = process.env.GITHUB_RUN_ID;
    const attempt = process.env.GITHUB_RUN_ATTEMPT;
    const identity =
      /^[1-9][0-9]*$/.test(runId ?? '') && /^[1-9][0-9]*$/.test(attempt ?? '')
        ? `${runId}t${attempt}z`
        : `${Date.now()}t${randomBytes(8).readBigUInt64BE()}z`;
    const payload = {
      mode: 'fleet-turns',
      release: packet.sourceSha,
      name: 'horse-phase6d-fleet-' + identity,
      deadline: 90,
      packet: Buffer.from(text).toString('base64'),
      program: Buffer.from(program).toString('base64'),
    };
    const run = (deps.spawnSync ?? spawnSync)(sshCommand, ['python3 -c ' + shellQuote(remote)], {
      input: JSON.stringify(payload),
      maxBuffer: 2 * 1024 * 1024,
      timeout: 105000,
    });
    let execution = null;
    let qualifiedExecution = false;
    try {
      if (run.status === 0 && run.stdout.length <= 2 * 1024 * 1024) {
        execution = JSON.parse(run.stdout.toString('utf8'));
        const fields = new Set([
          'containerName',
          'release',
          'imageId',
          'servingContainer',
          'servingStartedAt',
          'horseJournalMountVerified',
          'readOnly',
          'network',
          'memoryBytes',
          'cpus',
          'exitCode',
          'stderrBytes',
          'v8HeapExhausted',
          'oomKilled',
          'containerExitCode',
          'observation',
          'sameServingIdentityAfter',
          'cleanupExitCode',
          'observerRemoved',
          'executionStatus',
          'errorClass',
          'errorText',
          'cleanupStatus',
          'cleanupErrorClass',
          'absenceErrorClass',
        ]);
        if (!execution || Object.keys(execution).some((key) => !fields.has(key)))
          throw Error('turn_census_execution_contract');
        execution.observation = sanitizeHorseTurnCensusResult(execution.observation);
        const e = execution;
        qualifiedExecution =
          !e.executionStatus &&
          [0, 2].includes(e.exitCode) &&
          e.containerExitCode === e.exitCode &&
          e.oomKilled === false &&
          e.sameServingIdentityAfter === true &&
          e.observerRemoved === true &&
          e.cleanupExitCode === 0 &&
          e.horseJournalMountVerified === true &&
          e.readOnly === true &&
          e.network === 'none' &&
          e.release === packet.sourceSha &&
          e.containerName === payload.name &&
          e.memoryBytes === 536870912 &&
          e.cpus === 0.5 &&
          Number.isFinite(Date.parse(e.servingStartedAt)) &&
          /^sha256:[0-9a-f]{64}$/.test(e.imageId ?? '') &&
          /^[0-9a-f]{64}$/.test(e.servingContainer ?? '') &&
          e.observation.packetDigest === packetDigest &&
          e.observation.sourceSha === packet.sourceSha;
      }
    } catch {
      execution = null;
    }
    const result = {
      version: 2,
      scope: 'private_committed_turn_census',
      packetDigest,
      sourceSha: packet.sourceSha,
      qualifiedExecution,
      operationDigest: hash(payload.name),
      controlProgramSha256: hash(program),
      inputBytesSha256: hash(text),
      sshExitCode: run.status,
      execution,
      canonicalRosterVerified: false,
      completePopulation: false,
      allPhasesVerified: false,
    };
    writeFileSync(fd, JSON.stringify(result) + '\n');
    return {
      qualifiedExecution,
      packetDigest,
      sourceSha: packet.sourceSha,
      operationDigest: result.operationDigest,
      ...(qualifiedExecution ? {} : { failureCode: 'turn_census_execution_unverified' }),
      completePopulation: false,
      allPhasesVerified: false,
    };
  } finally {
    closeSync(fd);
  }
}

export async function runFleetTurnCensusCli(argv, remoteObserver) {
  try {
    if (argv.length !== 6) throw Error('turn_census_cli');
    const options = {};
    for (let i = 0; i < argv.length; i += 2) {
      const key = argv[i];
      if (!['--packet', '--ssh-command', '--out'].includes(key) || Object.hasOwn(options, key))
        throw Error('turn_census_cli');
      options[key] = argv[i + 1];
    }
    const result = runFleetTurnCensus({
      packetPath: options['--packet'],
      sshCommand: options['--ssh-command'],
      outputPath: options['--out'],
      remoteObserver,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.qualifiedExecution ? 0 : 2;
  } catch {
    process.stdout.write(
      JSON.stringify({
        qualifiedExecution: false,
        status: 'unavailable',
        failureCode: 'turn_census_setup_unavailable',
      }) + '\n'
    );
    process.exitCode = 3;
  }
}
