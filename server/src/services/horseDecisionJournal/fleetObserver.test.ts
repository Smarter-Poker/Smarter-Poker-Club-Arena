import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error maintained standalone observer has no declaration
import { runFleetObservation, REMOTE_OBSERVER } from '../../../scripts/phase6d-population.mjs';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture(change: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-observer-'));
  dirs.push(dir);
  const packet = {
    version: 1,
    sourceSha: 'a'.repeat(40),
    window: { startUtc: '2026-10-25T19:00:00.000Z', endUtc: '2026-10-25T19:15:00.000Z' },
    horseIds: Array.from(
      { length: 1000 },
      (_, i) => `10000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`
    ),
    handKeys: ['b'.repeat(64)],
  };
  const packetPath = join(dir, 'packet.json'),
    sshCommand = join(dir, 'hssh'),
    outputPath = join(dir, 'result.json');
  writeFileSync(packetPath, JSON.stringify(packet), { mode: 0o600 });
  // Real authenticated-wrapper subprocess boundary, isolated substitute for
  // transport only. Existing fleet native SQLite tests qualify the reader.
  writeFileSync(
    sshCommand,
    `#!/usr/bin/env python3
import json,sys,hashlib
p=json.load(sys.stdin)
packet=json.loads(__import__('base64').b64decode(p['packet']))
digest=hashlib.sha256(json.dumps(packet,sort_keys=True,separators=(',',':')).encode()).hexdigest()
r={'exitCode':2,'containerExitCode':2,'oomKilled':False,'sameServingIdentityAfter':True,'observerRemoved':True,'cleanupExitCode':0,'horseJournalMountVerified':True,'observation':{'packetDigest':digest,'sourceSha':packet['sourceSha'],'completeHorseCoverage':False,'observedHorses':7}}
r.update(json.loads(${JSON.stringify(JSON.stringify(change))}))
print(json.dumps(r))
`,
    { mode: 0o700 }
  );
  return { dir, packet, packetPath, sshCommand, outputPath };
}
describe('existing phase6d explicit private fleet observer', () => {
  it('preserves Python program syntax and resource, read-only and cleanup boundaries', () => {
    execFileSync('python3', ['-c', 'import sys;compile(sys.stdin.read(),"observer","exec")'], {
      input: REMOTE_OBSERVER,
    });
    for (const token of [
      '--network',
      'none',
      '--read-only',
      '512m',
      '0.5',
      '--pids-limit',
      'readonly',
      '/dev/stdin',
      'dist/scripts/horseJournalReview.js',
      'sameServingIdentityAfter',
      'observerRemoved',
    ])
      expect(REMOTE_OBSERVER).toContain(token);
    expect(REMOTE_OBSERVER).not.toContain('SERVICE_ROLE');
  });
  it('captures private IDs only into a new0600file; stdout return is aggregate and not canonical certification', () => {
    const f = fixture();
    const result = runFleetObservation(f);
    expect(result).toMatchObject({
      qualifiedExecution: true,
      observedHorses: 7,
      completeHorseCoverage: false,
      canonicalRosterVerified: false,
      allPhasesVerified: false,
    });
    expect(JSON.stringify(result)).not.toContain(f.packet.horseIds[0]);
    expect(statSync(f.outputPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(f.outputPath, 'utf8'))).toMatchObject({
      completePopulation: false,
      canonicalRosterVerified: false,
    });
    expect(() => runFleetObservation(f)).toThrow();
  });
  it.each([
    { observerRemoved: false },
    { sameServingIdentityAfter: false },
    { oomKilled: true },
    { containerExitCode: 0 },
    { observation: { packetDigest: 'wrong' } },
  ])('refuses incomplete execution %j', (change) => {
    expect(runFleetObservation(fixture(change)).qualifiedExecution).toBe(false);
  });
  it('refuses an oversized window before invoking transport', () => {
    const f = fixture();
    f.packet.window.endUtc = '2026-10-25T19:15:01.000Z';
    writeFileSync(f.packetPath, JSON.stringify(f.packet));
    expect(() => runFleetObservation(f)).toThrow('fleet_window');
  });
});

describe('real remote Python transaction with isolated Docker command fixture', () => {
  it('runs exact installed CLI, validates mounted serving identity and removes its observer', () => {
    const f = fixture(),
      docker = join(f.dir, 'docker'),
      commands = join(f.dir, 'commands.jsonl');
    writeFileSync(
      docker,
      `#!/usr/bin/env python3
import sys,json
args=sys.argv[1:]
with open(${JSON.stringify(commands)},'a') as out:out.write(json.dumps(args)+'\\n')
sha='a'*40;image='sha256:'+'c'*64;container='d'*64
if args[0]=='image':print(sha)
elif args[0]=='inspect':
 fmt=args[2]
 if '.Mounts' in fmt:print(json.dumps([{'Destination':'/var/lib/club-arena/horse-decisions','Source':'/var/lib/club-arena/horse-decisions','Type':'bind','RW':True}]))
 elif '.Config.Env' in fmt:print('HORSE_DECISION_JOURNAL_DIR=/var/lib/club-arena/horse-decisions')
 elif '.State}}' in fmt:print(json.dumps({'OOMKilled':False,'ExitCode':2}))
 else:print(container,image,'true',sha,'2026-10-25T19:00:00Z')
elif args[0]=='create':print('observer')
elif args[0]=='start':
 p=json.load(sys.stdin);print(json.dumps({'sourceSha':p['sourceSha'],'observedHorses':0,'completeHorseCoverage':False}))
`,
      { mode: 0o700 }
    );
    const payload = {
      mode: 'fleet',
      release: f.packet.sourceSha,
      name: 'horse-phase6d-fleet-20261025t190000z',
      deadline: 90,
      packet: Buffer.from(JSON.stringify(f.packet)).toString('base64'),
    };
    const result = JSON.parse(
      execFileSync('python3', ['-c', REMOTE_OBSERVER], {
        input: JSON.stringify(payload),
        env: { ...process.env, PATH: f.dir + ':' + process.env.PATH },
      }).toString()
    );
    expect(result).toMatchObject({
      sameServingIdentityAfter: true,
      observerRemoved: true,
      cleanupExitCode: 0,
      containerExitCode: 2,
      horseJournalMountVerified: true,
    });
    const calls = readFileSync(commands, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const create = calls.find((args) => args[0] === 'create');
    expect(create.slice(-5)).toEqual([
      'sha256:' + 'c'.repeat(64),
      'dist/scripts/horseJournalReview.js',
      '--fleet',
      '/var/lib/club-arena/horse-decisions',
      '/dev/stdin',
    ]);
    expect(create).toContain(
      'type=bind,src=/var/lib/club-arena/horse-decisions,dst=/var/lib/club-arena/horse-decisions,readonly'
    );
    expect(calls.filter((args) => args[0] === 'start')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'rm')).toHaveLength(1);
  });
});
