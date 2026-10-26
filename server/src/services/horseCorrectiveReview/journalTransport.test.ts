import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHorseJournalRecord } from '../horseDecisionJournal/record.js';
import { currentHorseDecisionRuntime } from '../../engine/horseDecision/replayState.js';
import {
  createAuthenticatedHorseJournalReader,
  exportCanonicalHorseJournalBatch,
  isAuthenticatedHorseJournalBatch,
  PRIVATE_JOURNAL_REMOTE_COMMAND,
} from './journalTransport.js';
import { runHorsePrivateJournalExport } from '../../scripts/horsePrivateJournalExport.js';
const source = 'a'.repeat(40),
  hand = 'b'.repeat(64);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup() {
  const d = mkdtempSync(join(tmpdir(), 'canonical-journal-transport-'));
  dirs.push(d);
  const key = join(d, 'identity'),
    known = join(d, 'known_hosts');
  writeFileSync(key, 'synthetic metadata-only identity fixture', { mode: 0o600 });
  writeFileSync(known, 'synthetic pinned-host fixture', { mode: 0o600 });
  return {
    env: {
      HORSE_REVIEW_SSH_HOST: 'engine.invalid',
      HORSE_REVIEW_SSH_KEY_PATH: key,
      HORSE_REVIEW_SSH_KNOWN_HOSTS_PATH: known,
    },
    key,
    known,
  };
}
const record = (sequence = 1, privateMarker = 'fixture-private-card-data') =>
  makeHorseJournalRecord(
    {
      producerId: '00000000-0000-4000-8000-000000000001',
      sequence,
      atMs: 1,
      sourceRelease: source,
      kind: 'decision',
      handKey: hand,
      turnKey: 'c'.repeat(64),
    },
    { privateMarker }
  );
function payload(keys = [hand]) {
  return {
    version: 1,
    status: 'canonical_journal_export',
    sourceRelease: source,
    runtime: currentHorseDecisionRuntime(),
    recordsByHand: keys.map((handKey) => ({ handKey, records: [record()] })),
  };
}
const wire = (value = payload(), label = source) => label + '\n' + JSON.stringify(value) + '\n';
describe('canonical authenticated private journal transport', () => {
  it('the fixed same-container command parses in the remote POSIX shell', () => {
    expect(() =>
      execFileSync('/bin/sh', ['-n'], {
        input: PRIVATE_JOURNAL_REMOTE_COMMAND,
        env: { PATH: '/usr/bin:/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    ).not.toThrow();
  });
  it('uses a fixed pinned SSH command and brands only exact image-bound validated records', async () => {
    const s = setup(),
      run = vi.fn(async () => wire());
    const result = await createAuthenticatedHorseJournalReader(s.env, { execute: run })([hand]);
    expect(result.status).toBe('authenticated_journal_batch');
    expect(isAuthenticatedHorseJournalBatch(result)).toBe(true);
    expect(isAuthenticatedHorseJournalBatch(JSON.parse(JSON.stringify(result)))).toBe(false);
    const [args, input] = run.mock.calls[0]! as unknown as [string[], string];
    expect(args).toContain('StrictHostKeyChecking=yes');
    expect(args).toContain('GlobalKnownHostsFile=/dev/null');
    expect(args).toContain('VerifyHostKeyDNS=no');
    expect(args).toContain('IdentitiesOnly=yes');
    expect(args).toContain(PRIVATE_JOURNAL_REMOTE_COMMAND);
    expect(PRIVATE_JOURNAL_REMOTE_COMMAND).toContain('docker image inspect');
    expect(PRIVATE_JOURNAL_REMOTE_COMMAND).toContain(
      "docker inspect --format '{{.Id}}' club-arena-engine"
    );
    expect(PRIVATE_JOURNAL_REMOTE_COMMAND).toContain('docker exec -i "$horse_journal_container"');
    expect(JSON.parse(input)).toEqual({ version: 1, handKeys: [hand] });
    if (result.status === 'authenticated_journal_batch') {
      expect(Object.isFrozen(result.recordsByHand[0]!.records[0])).toBe(true);
      expect(result.qualified).toBe(false);
      expect(result.activationAllowed).toBe(false);
    }
  });
  it('refuses mutable runtime source disagreement with the immutable image label', async () => {
    const s = setup();
    const r = await createAuthenticatedHorseJournalReader(s.env, {
      execute: async () => wire(payload(), 'd'.repeat(40)),
    })([hand]);
    expect(r.status).toBe('unavailable');
    expect(isAuthenticatedHorseJournalBatch(r)).toBe(false);
  });
  it('refuses reordered, omitted, substituted or corrupt journal rows', async () => {
    for (const change of [
      (p: ReturnType<typeof payload>) => {
        p.recordsByHand = [];
      },
      (p: ReturnType<typeof payload>) => {
        p.recordsByHand[0]!.handKey = 'd'.repeat(64);
      },
      (p: ReturnType<typeof payload>) => {
        p.recordsByHand[0]!.records = [{ ...record(), body: '{}' }];
      },
    ]) {
      const s = setup(),
        p = payload();
      change(p);
      expect(
        (
          await createAuthenticatedHorseJournalReader(s.env, { execute: async () => wire(p) })([
            hand,
          ])
        ).status
      ).toBe('unavailable');
    }
  });
  it('does not invoke SSH for malformed keys, duplicate requests or unsafe identity metadata', async () => {
    const s = setup(),
      run = vi.fn(async () => wire());
    const reader = createAuthenticatedHorseJournalReader(s.env, { execute: run });
    expect((await reader([hand, hand])).status).toBe('unavailable');
    expect((await reader(['bad'])).status).toBe('unavailable');
    expect(
      (await reader(Array.from({ length: 129 }, (_, i) => i.toString(16).padStart(64, '0')))).status
    ).toBe('unavailable');
    chmodSync(s.key, 0o644);
    expect(
      (await createAuthenticatedHorseJournalReader(s.env, { execute: run })([hand])).status
    ).toBe('unavailable');
    expect(
      (
        await createAuthenticatedHorseJournalReader(
          { ...s.env, HORSE_REVIEW_SSH_HOST: 'host; echo private' },
          { execute: run }
        )([hand])
      ).status
    ).toBe('unavailable');
    expect(run).not.toHaveBeenCalled();
  });
  it('keeps transport failures generic and does not brand partial data', async () => {
    const s = setup();
    expect(
      await createAuthenticatedHorseJournalReader(s.env, {
        execute: async () => {
          throw Error('fixture-private-card-data');
        },
      })([hand])
    ).toEqual({
      status: 'unavailable',
      reason: 'journal_transport_unavailable',
      qualified: false,
      activationAllowed: false,
    });
  });
  it('exports only configured canonical paths and validates the original private records', () => {
    const read = vi.fn(() => [record()]);
    const result = exportCanonicalHorseJournalBatch(
      [hand],
      { GIT_COMMIT_SHA: source, HORSE_DECISION_JOURNAL_DIR: '/configured/private/journal' },
      read
    );
    expect(result?.recordsByHand[0]!.records).toEqual([record()]);
    expect(read).toHaveBeenCalledWith('/configured/private/journal', hand);
    expect(
      exportCanonicalHorseJournalBatch(
        [hand],
        { GIT_COMMIT_SHA: 'bad', HORSE_DECISION_JOURNAL_DIR: '/configured/private/journal' },
        read
      )
    ).toBeNull();
    expect(
      exportCanonicalHorseJournalBatch(
        [hand],
        { GIT_COMMIT_SHA: source, HORSE_DECISION_JOURNAL_DIR: '/configured/private/journal' },
        () => [{ ...record(), sourceRelease: 'd'.repeat(40) }]
      )
    ).toBeNull();
  });
  it('supports an explicit metadata-only probe without reading any hand', async () => {
    const read = vi.fn(() => [record()]);
    const p = exportCanonicalHorseJournalBatch(
      [],
      { GIT_COMMIT_SHA: source, HORSE_DECISION_JOURNAL_DIR: '/configured/private/journal' },
      read
    );
    expect(p?.recordsByHand).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    const s = setup();
    const r = await createAuthenticatedHorseJournalReader(s.env, {
      execute: async () => source + '\n' + JSON.stringify(p),
    })([]);
    expect(r.status).toBe('authenticated_journal_batch');
  });
  it('streams a multi-record batch above the unrelated single-record serialization limit', async () => {
    const records = [
      record(1, 'x'.repeat(200000)),
      record(2, 'y'.repeat(200000)),
      record(3, 'z'.repeat(200000)),
    ];
    const p = exportCanonicalHorseJournalBatch(
      [hand],
      { GIT_COMMIT_SHA: source, HORSE_DECISION_JOURNAL_DIR: '/configured/private/journal' },
      () => records
    );
    expect(p).not.toBeNull();
    const output = source + '\n' + JSON.stringify(p);
    expect(Buffer.byteLength(output)).toBeGreaterThan(512 * 1024);
    const s = setup();
    const result = await createAuthenticatedHorseJournalReader(s.env, {
      execute: async () => output,
    })([hand]);
    expect(isAuthenticatedHorseJournalBatch(result)).toBe(true);
    if (result.status === 'authenticated_journal_batch')
      expect(result.recordsByHand[0]!.records).toHaveLength(3);
  });
  it('stdin endpoint rejects paths, extra options and oversized input without private error output', async () => {
    async function* input(value: string) {
      yield value;
    }
    expect(await runHorsePrivateJournalExport(['/caller/path'], input('{}'), {})).toEqual({
      code: 64,
      output: '',
    });
    expect(
      await runHorsePrivateJournalExport(
        [],
        input(JSON.stringify({ version: 1, handKeys: [], directory: '/caller/private' })),
        {}
      )
    ).toEqual({ code: 3, output: '' });
    expect(await runHorsePrivateJournalExport([], input('x'.repeat(65537)), {})).toEqual({
      code: 3,
      output: '',
    });
    const probe = await runHorsePrivateJournalExport(
      [],
      input(JSON.stringify({ version: 1, handKeys: [] })),
      { GIT_COMMIT_SHA: source, HORSE_DECISION_JOURNAL_DIR: '/configured/private/journal' }
    );
    expect(probe.code).toBe(0);
    expect(JSON.parse(probe.output).recordsByHand).toEqual([]);
  });
});
