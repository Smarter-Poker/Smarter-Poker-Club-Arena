import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ORIGIN = 'https://engine.smarter.poker';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function diagnosticSelection(event) {
  if (event?.action !== 'audit-production-integrity') throw new Error('Wrong audit event');
  const selection = event?.client_payload?.tournament_diagnostic;
  if (!Array.isArray(selection) || selection.length < 1 || selection.length > 2)
    throw new Error('Select one or two tournaments');
  const seen = new Set();
  return selection.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).some((key) => !['tournamentId', 'tableIds'].includes(key)) ||
      typeof item.tournamentId !== 'string' ||
      !UUID.test(item.tournamentId) ||
      !Array.isArray(item.tableIds) ||
      item.tableIds.length < 1 ||
      item.tableIds.length > 8 ||
      item.tableIds.some((id) => typeof id !== 'string' || !UUID.test(id))
    )
      throw new Error('Invalid diagnostic scope');
    const tournamentId = item.tournamentId.toLowerCase();
    const tableIds = item.tableIds.map((id) => id.toLowerCase());
    if (seen.has(tournamentId) || new Set(tableIds).size !== tableIds.length)
      throw new Error('Duplicate diagnostic scope');
    seen.add(tournamentId);
    return { tournamentId, tableIds };
  });
}

async function boundedJson(response, limit) {
  if (response.status !== 200 || !response.body)
    throw new Error('Diagnostic HTTP read unavailable');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Diagnostic response exceeded its byte limit');
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Diagnostic JSON unavailable');
  }
}

function engineIdentity(health) {
  if (
    typeof health?.version !== 'string' ||
    !/^[0-9a-f]{8,40}$/.test(health.version) ||
    typeof health?.instanceId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(health.instanceId)
  )
    throw new Error('Engine identity unavailable');
  return { version: health.version, instanceId: health.instanceId };
}

export async function readTournamentDiagnostics(event, key, fetcher = fetch) {
  // Validate the entire request before credentials can leave this process.
  const selection = diagnosticSelection(event);
  if (typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))
    throw new Error('Configured diagnostic access unavailable');
  const get = async (url, authorized, limit) => {
    let response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
        headers: authorized ? { Authorization: `Bearer ${key}` } : {},
      });
    } catch {
      // Never print provider/network errors, which may contain request metadata.
      throw new Error('Diagnostic transport unavailable');
    }
    return boundedJson(response, limit);
  };
  const healthUrl = `${ORIGIN}/health?diagnostic=${Date.now()}`;
  const before = engineIdentity(await get(healthUrl, false, 256 * 1024));
  const snapshots = [];
  for (const item of selection) {
    const url = new URL(`/internal/tournament-diagnostics/${item.tournamentId}`, ORIGIN);
    url.searchParams.set('table_ids', item.tableIds.join(','));
    const snapshot = await get(url.toString(), true, 64 * 1024);
    if (
      snapshot?.schema !== 'tournament-lifecycle-diagnostic/v1' ||
      snapshot.tournamentId !== item.tournamentId ||
      snapshot.diagnosticOnly !== true
    )
      throw new Error('Diagnostic identity or contract mismatch');
    // The serving route itself emits only its fixed diagnostic wire allowlist.
    // Never retain a credential if a broken upstream happens to echo it.
    if (JSON.stringify(snapshot).includes(key)) throw new Error('Diagnostic response refused');
    snapshots.push({ selection: item, snapshot });
  }
  const after = engineIdentity(
    await get(`${ORIGIN}/health?diagnostic=${Date.now()}`, false, 256 * 1024)
  );
  if (before.version !== after.version || before.instanceId !== after.instanceId)
    throw new Error('Engine changed during diagnostic observation');
  return {
    schema: 'scoped-tournament-observation/v1',
    observedAt: new Date().toISOString(),
    engine: after,
    snapshots,
  };
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== 'repository_dispatch')
    throw new Error('Manual dispatch required');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await readTournamentDiagnostics(event, process.env.INTERNAL_API_KEY);
  const directory = 'artifacts/tournament-diagnostic';
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/observation.json`, JSON.stringify(result, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    `Observed ${result.snapshots.length} tournament scope(s) on ${result.engine.version}; read-only evidence saved.`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('Scoped tournament observation unavailable. No production action was performed.');
    process.exitCode = 1;
  });
}
