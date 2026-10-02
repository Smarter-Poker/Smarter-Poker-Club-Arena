#!/usr/bin/env node
/**
 * Phase 6D chain export (for G8 replay).
 *
 * A Phase 6D population is built by walking the committed declaration's
 * strata in archive_events rowid order, exactly as
 * server/scripts/phase6d-population.mjs's own observer does (same window,
 * same handsPerStratum, same order). That walk is deterministic against an
 * append-only, ring-retiring archive read moments later. This tool re-walks
 * the SAME declaration, read-only, inside a throwaway network-none observer
 * container built from the serving image, and collects the exact decision
 * records whose journaled eventId equals one of the population's admitted
 * chains' decisionId, in population chain order, as NDJSON for
 * server/scripts/phase6c-replay.mjs --population to replay.
 *
 * No record is written anywhere on the engine host. A decision whose eventId
 * is not found by the end of the same walk (retired by the ring, or the hand
 * selection cutoff landed differently on re-walk) is reported as not_found
 * and is not exported; nothing is filled, inferred or substituted for it.
 *
 * The walk covers every archive shard (one catalog per decision-shard writer
 * since #5541), shard 0 first, each with its own handsPerStratum, exactly as the
 * population observer does.
 *
 * Usage
 *   node server/scripts/phase6d-chain-export.mjs run --declaration <json> --population <json> --out <ndjson> [--report <json>] [--ssh-target root@host] [--ssh-key path]
 *   node server/scripts/phase6d-chain-export.mjs export <base64 payload>   (runs inside the observer container only)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const HOUR_MS = 3_600_000;

/* THE ARCHIVE IS ONE CATALOG PER DECISION SHARD (2026-09-29). This file is sent
   whole to the observer container, so it cannot import the population tool's
   copy of these helpers; tests/phase6ReviewToolsReadEveryShard pins that the
   two agree. Shard 0 is 'archive', later shards 'archive-shard-N', and the
   names come from the journal's own directory listing. */
export function archiveShardNames(config, directory) {
  const names = config.horseJournalArchiveDirectoryNames(directory);
  if (!Array.isArray(names) || !names.length) throw Error('archive_custody_unavailable');
  return names;
}
export const shardCatalogPath = (directory, shardName) =>
  directory + '/' + shardName + '/horse-journal-archive.sqlite';
export const shardSegmentPath = (directory, shardName, sha) =>
  directory + '/' + shardName + '/segments/' + sha + '.ndjson.gz';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--declaration') out.declaration = argv[++i];
    else if (a === '--population') out.population = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--ssh-target') out.sshTarget = argv[++i];
    else if (a === '--ssh-key') out.sshKey = argv[++i];
    else out._.push(a);
  }
  return out;
}

function shellQuote(text) {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

/** Runs inside the throwaway observer container only. Re-walks the
 * declaration's strata in rowid order (the population's own algorithm) and
 * collects the raw decision records whose eventId is in the wanted set.
 * Prints one JSON object (never partial) to stdout. */
async function runExport(payloadB64) {
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
  const directory = process.env.HORSE_DECISION_JOURNAL_DIR;
  if (directory !== '/var/lib/club-arena/horse-decisions') throw Error('private_mount_required');
  if (process.env.GIT_COMMIT_SHA !== payload.release) throw Error('exact_release_required');
  const declaration = payload.declaration;
  const wanted = new Set(payload.wantedEventIds);
  const { DatabaseSync } = await import('node:sqlite');
  const { gunzipSync } = await import('node:zlib');
  const { readFileSync: readFile } = await import('node:fs');
  const [store, config, record] = await Promise.all([
    import('/app/dist/services/horseDecisionJournal/store.js'),
    import('/app/dist/services/horseDecisionJournal/config.js'),
    import('/app/dist/services/horseDecisionJournal/record.js'),
  ]);
  // Every archive shard, exactly as the population observer walks them
  // (phase6d-population.mjs, archiveShardNames): a decision the population
  // admitted from any shard must be found here in that shard.
  const shardNames = archiveShardNames(config, directory);
  const found = new Map();
  let handsTotal = 0;
  const strataCount = Math.ceil((declaration.window.endMs - declaration.window.startMs) / HOUR_MS);
  const windowEnd = declaration.window.endMs;
  shards: for (const shardName of shardNames) {
    const journal = new store.HorseDecisionJournalStore(
      directory,
      config.readonlyHorseJournalStoreOptions(directory, shardName)
    );
    const catalog = new DatabaseSync(shardCatalogPath(directory, shardName), {
      readOnly: true,
      allowExtension: false,
    });
    try {
      catalog.exec('PRAGMA busy_timeout=250; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
      const maxRowid = catalog
        .prepare('SELECT COALESCE(max(rowid),0) AS rowid FROM archive_events')
        .get().rowid;
      const minRowid = catalog
        .prepare('SELECT COALESCE(min(rowid),0) AS rowid FROM archive_events')
        .get().rowid;
      if (!maxRowid) continue;
      const existingAtOrAfter = catalog.prepare(
        'SELECT rowid FROM archive_events WHERE rowid >= ? ORDER BY rowid LIMIT 1'
      );
      const rowMeta = catalog.prepare(
        `SELECT e.hand_key, e.ordinal, s.sha, s.compressed_sha
         FROM archive_events e JOIN archive_segments s ON s.sha = e.segment_sha WHERE e.rowid = ?`
      );
      const segmentCache = new Map();
      const atMsOf = (rowid) => {
        const row = rowMeta.get(rowid);
        if (!row) throw Error('rowid_unavailable');
        let lines = segmentCache.get(row.sha);
        if (!lines) {
          const compressed = readFile(shardSegmentPath(directory, shardName, row.sha));
          if (record.journalHash(compressed) !== row.compressed_sha) throw Error('segment_digest');
          const decoded = gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 + 65536 });
          if (record.journalHash(decoded) !== row.sha) throw Error('segment_digest');
          lines = decoded.toString('utf8').slice(0, -1).split('\n');
          if (segmentCache.size > 128) segmentCache.clear();
          segmentCache.set(row.sha, lines);
        }
        const parsed = JSON.parse(lines[Number(row.ordinal)]);
        record.validateHorseJournalRecord(parsed);
        return parsed.atMs;
      };
      const lowerBound = (t) => {
        let lo = Math.max(1, Number(minRowid)),
          hi = maxRowid + 1;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          const row = Number(existingAtOrAfter.get(mid).rowid);
          if (atMsOf(row) < t) lo = row + 1;
          else hi = mid;
        }
        return lo;
      };
      const handRows = catalog.prepare(
        'SELECT rowid, hand_key FROM archive_events WHERE rowid >= ? AND rowid < ? ORDER BY rowid LIMIT 4096'
      );
      outer: for (let h = 0; h < strataCount; h++) {
        const startMs = declaration.window.startMs + h * HOUR_MS;
        const endMs = Math.min(startMs + HOUR_MS, windowEnd);
        const firstRowid = lowerBound(startMs);
        const nextRowid = lowerBound(endMs);
        const seen = new Set();
        let cursor = firstRowid;
        while (seen.size < declaration.selection.handsPerStratum && cursor < nextRowid) {
          const rows = handRows.all(cursor, nextRowid);
          if (!rows.length) break;
          for (const row of rows) {
            cursor = Number(row.rowid) + 1;
            if (seen.has(row.hand_key)) continue;
            if (seen.size >= declaration.selection.handsPerStratum) break;
            seen.add(row.hand_key);
            if (++handsTotal > declaration.selection.bounds.maxHandsInspected) break shards;
            if (found.size >= wanted.size) break shards;
            let records;
            try {
              records = journal.readHand(row.hand_key);
            } catch {
              continue;
            }
            for (const r of records) {
              if (r.kind === 'decision' && wanted.has(r.eventId) && !found.has(r.eventId)) {
                found.set(r.eventId, r);
              }
            }
          }
        }
      }
    } finally {
      try {
        catalog.close();
      } catch {
        /* read-only connection cleanup */
      }
      try {
        journal.close();
      } catch {
        /* read-only connection cleanup */
      }
    }
  }
  process.stdout.write(
    JSON.stringify({
      exportedAt: new Date().toISOString(),
      release: process.env.GIT_COMMIT_SHA,
      wanted: wanted.size,
      found: found.size,
      handsWalked: handsTotal,
      shardsRead: shardNames.length,
      records: [...found.values()],
    })
  );
}

const REMOTE_RUNNER = String.raw`import base64,json,re,subprocess,sys,time
p=json.load(sys.stdin)
sha=p["release"]; name=p["name"]; deadline_s=int(p["deadline"])
assert re.fullmatch(r"[0-9a-f]{40}",sha) and re.fullmatch(r"horse-phase6d-export-[0-9tz]+",name), "payload_identity"
source=base64.b64decode(p["source"],validate=True)
payload=p["payload"]
assert len(source)<=262144, "payload_bounds"
mount="/var/lib/club-arena/horse-decisions"
deadline=time.monotonic()+deadline_s
def command(args,**kw):
 cleanup=kw.pop("cleanup",False)
 remaining=deadline-time.monotonic()-(0 if cleanup else 10)
 if remaining<=0: raise TimeoutError("observation_deadline")
 return subprocess.run(args,capture_output=True,timeout=min(kw.pop("timeout",3),remaining),**kw)
def serving():
 r=command(["docker","inspect","--format","{{.Id}} {{.Image}} {{.State.Running}} {{index .Config.Labels \"sp.release.sha\"}} {{.State.StartedAt}}","club-arena-engine"])
 assert r.returncode==0, "serving_inspect"
 parts=r.stdout.decode().strip().split()
 assert len(parts)==5 and re.fullmatch(r"[0-9a-f]{64}",parts[0]) and re.fullmatch(r"sha256:[0-9a-f]{64}",parts[1]) and parts[2:4]==["true",sha] and re.fullmatch(r"[0-9TZ:.+-]+",parts[4]), "serving_identity"
 return parts
identity=serving(); image=identity[1]
r=command(["docker","image","inspect","--format","{{index .Config.Labels \"org.opencontainers.image.revision\"}}",image]); assert r.returncode==0 and r.stdout.decode().strip()==sha, "image_revision"
result={"containerName":name,"release":sha,"imageId":image,"servingContainer":identity[0],"servingStartedAt":identity[4],"readOnly":True,"network":"none"}
try:
 r=command(["docker","create","--name",name,"-i","--network","none","--no-healthcheck","--read-only","--memory","512m","--memory-swap","512m","--cpus","0.5","--pids-limit","32","--mount","type=bind,src="+mount+",dst="+mount+",readonly","--env","HORSE_DECISION_JOURNAL_DIR="+mount,"--entrypoint","node",image,"--no-warnings","--input-type=module","-","export",payload])
 assert r.returncode==0, r.stderr.decode()[:200]
 r=command(["docker","start","-ai",name],input=source,timeout=deadline_s-20)
 result["exitCode"]=r.returncode
 result["stderrBytes"]=len(r.stderr)
 result["stderrTail"]=r.stderr.decode(errors="replace")[-400:]
 assert len(r.stdout)<=33554432
 result["export"]=json.loads(r.stdout)
 state=command(["docker","inspect","--format","{{json .State}}",name]); assert state.returncode==0
 state=json.loads(state.stdout);result["oomKilled"]=state["OOMKilled"];result["containerExitCode"]=state["ExitCode"]
 result["sameServingIdentityAfter"]=serving()==identity
except Exception as error:
 result["executionStatus"]="unavailable";result["errorClass"]=type(error).__name__;result["errorText"]=str(error)[:300]
finally:
 try:
  cleanup=command(["docker","rm","-f",name],cleanup=True,timeout=5)
  result["cleanupExitCode"]=cleanup.returncode
 except Exception as error:
  result["cleanupStatus"]="unknown";result["cleanupErrorClass"]=type(error).__name__
 try:
  check=command(["docker","ps","-a","--format","{{.Names}}","--filter","name=^/"+name+"$"],cleanup=True,timeout=5)
  result["observerRemoved"]=check.returncode==0 and not check.stdout.strip()
 except Exception as error:
  result["observerRemoved"]=False;result["absenceErrorClass"]=type(error).__name__
 print(json.dumps(result))
`;

function runOnHost({ declarationPath, population, sshTarget, sshKey, out, reportPath }) {
  const declaration = JSON.parse(readFileSync(resolve(declarationPath), 'utf8'));
  const populationText = readFileSync(resolve(population), 'utf8');
  const pop = JSON.parse(populationText);
  const release =
    typeof pop.servingRelease === 'string' ? pop.servingRelease : pop.servingRelease.sha;
  const wantedEventIds = pop.chains.map((c) => c.decisionId);
  const source = readFileSync(new URL(import.meta.url));
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
  const name = 'horse-phase6d-export-' + stamp;
  const deadline = 300;
  const payload = {
    release,
    name,
    deadline,
    source: source.toString('base64'),
    payload: Buffer.from(JSON.stringify({ release, declaration, wantedEventIds })).toString(
      'base64'
    ),
  };
  const startedAt = new Date().toISOString();
  const run = spawnSync(
    'ssh',
    [
      '-i',
      sshKey,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      sshTarget,
      'python3 -c ' + shellQuote(REMOTE_RUNNER),
    ],
    { input: JSON.stringify(payload), maxBuffer: 128 * 1024 * 1024, timeout: (deadline + 90) * 1000 }
  );
  if (run.status !== 0) {
    throw Error(
      'ssh_exit_' + run.status + ': ' + (run.stderr ? run.stderr.toString('utf8').slice(-500) : '')
    );
  }
  const result = JSON.parse(run.stdout.toString('utf8'));
  if (result.executionStatus === 'unavailable') throw Error('export_unavailable: ' + result.errorText);
  const exportResult = result.export;
  const byEventId = new Map(exportResult.records.map((r) => [r.eventId, r]));
  const lines = [];
  let missing = 0;
  for (const c of pop.chains) {
    const r = byEventId.get(c.decisionId);
    if (r) lines.push(JSON.stringify(r));
    else missing++;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), lines.join('\n') + (lines.length ? '\n' : ''));
  const report = {
    exportedAt: startedAt,
    finishedAt: new Date().toISOString(),
    release,
    declarationFile: basename(declarationPath),
    populationFile: basename(population),
    chainsInPopulation: pop.chains.length,
    wanted: exportResult.wanted,
    foundOnHost: exportResult.found,
    handsWalked: exportResult.handsWalked,
    exported: lines.length,
    missing,
    sameServingIdentityAfter: result.sameServingIdentityAfter,
    observerRemoved: result.observerRemoved,
    exitCode: result.exitCode,
    containerExitCode: result.containerExitCode,
    oomKilled: result.oomKilled,
    scriptSha256: sha256(source),
  };
  if (reportPath) writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv[0];
  if (mode === 'export') {
    try {
      await runExport(argv[1]);
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ status: 'unavailable', reason: String((error && error.message) || error) })
      );
      process.exitCode = 3;
    }
    return;
  }
  if (mode === 'run') {
    const args = parseArgs(argv.slice(1));
    if (!args.declaration || !args.population || !args.out) {
      process.stderr.write(
        'usage: phase6d-chain-export.mjs run --declaration <json> --population <json> --out <ndjson> [--report <json>]\n'
      );
      process.exitCode = 2;
      return;
    }
    runOnHost({
      declarationPath: args.declaration,
      population: args.population,
      out: args.out,
      reportPath: args.report,
      sshTarget: args.sshTarget ?? 'root@5.161.252.33',
      sshKey: args.sshKey ?? '/Users/smarter.poker/.ssh/hetzner_engine_key',
    });
    return;
  }
  process.stderr.write(
    'usage: phase6d-chain-export.mjs run --declaration <json> --population <json> --out <ndjson>\n'
  );
  process.exitCode = 2;
}

const entry = process.argv[1] ? basename(process.argv[1]) : '';
if (entry === '-' || entry === 'phase6d-chain-export.mjs') await main();
