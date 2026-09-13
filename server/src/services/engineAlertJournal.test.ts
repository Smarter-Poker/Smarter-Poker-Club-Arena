import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileAlertJournal, emptyAlertJournal } from './engineAlertJournal.js';
import { EngineAlertDelivery } from './engineAlertDelivery.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.length = 0;
});
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'engine-alert-journal-'));
  directories.push(directory);
  return new FileAlertJournal(directory);
}
const input = {
  alertname: 'JournalProof',
  component: 'engine',
  severity: 'critical' as const,
  summary: 'Failed',
};

describe('engine alert journal on persistent disk', () => {
  it.each(['engine_alert_event_id', 'engine_alert_episode_id', 'engine_alert_priority'])(
    'quarantines a checksummed but invalid receiver contract: %s',
    async (field) => {
      const journal = await store();
      const delivery = new EngineAlertDelivery({
        store: journal,
        post: async () => false,
        report: vi.fn(),
        automatic: false,
      });
      await delivery.raise(input);
      delivery.stop();
      const state = await journal.load();
      state.pending[0].alert.labels[field] = 'invalid';
      const raw = JSON.stringify({
        checksum: createHash('sha256').update(JSON.stringify(state)).digest('hex'),
        state,
      });
      await writeFile(journal.path, raw);
      await expect(journal.load()).rejects.toThrow('corrupt');
      expect(await readFile(journal.path, 'utf8')).toBe(raw);
      expect(
        (await readdir(journal.directory)).filter((name) => name.startsWith('journal.corrupt.'))
      ).toHaveLength(1);
    }
  );

  it('retains malformed non-UTF8 checkpoint bytes exactly', async () => {
    const journal = await store();
    const bytes = Buffer.from([123, 255, 254, 0, 125]);
    await writeFile(journal.path, bytes);
    await expect(journal.load()).rejects.toThrow('corrupt');
    const quarantine = (await readdir(journal.directory)).find((name) =>
      name.startsWith('journal.corrupt.')
    )!;
    expect(await readFile(journal.path)).toEqual(bytes);
    expect(await readFile(join(journal.directory, quarantine))).toEqual(bytes);
  });

  it('survives an actual process exit and resumes with the original event ID', async () => {
    const journal = await store();
    const script = `
      import { FileAlertJournal } from './src/services/engineAlertJournal.js';
      import { EngineAlertDelivery } from './src/services/engineAlertDelivery.js';
      const journal = new FileAlertJournal(process.env.ENGINE_ALERT_TEST_DIR);
      const delivery = new EngineAlertDelivery({ store: journal, automatic: false,
        report: () => {}, post: async () => false });
      await delivery.raise({ alertname: 'ProcessExit', component: 'test', severity: 'critical', summary: 'persisted' });
      process.exit(0);
    `;
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        env: { ...process.env, ENGINE_ALERT_TEST_DIR: journal.directory },
        encoding: 'utf8',
        timeout: 8000,
      }
    );
    expect(child.status, child.stderr).toBe(0);
    const persisted = (await journal.load()).pending[0].alert;
    const post = vi.fn().mockResolvedValue(true);
    const resumed = new EngineAlertDelivery({
      store: new FileAlertJournal(journal.directory),
      automatic: false,
      post,
      report: vi.fn(),
    });
    await resumed.sendOne();
    resumed.stop();
    expect(post).toHaveBeenCalledWith(persisted);
    expect((await journal.load()).pending).toEqual([]);
  });

  it('restores firing and pending identity from a new process instance', async () => {
    const journal = await store();
    const first = new EngineAlertDelivery({
      store: journal,
      post: async () => false,
      report: vi.fn(),
      automatic: false,
    });
    await first.raise(input);
    first.stop();
    const checkpoint = await journal.load();
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
    expect((await readdir(journal.directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const post = vi.fn().mockResolvedValue(true);
    const second = new EngineAlertDelivery({
      store: new FileAlertJournal(journal.directory),
      post,
      report: vi.fn(),
      automatic: false,
    });
    await second.sendOne();
    expect(post).toHaveBeenCalledWith(checkpoint.pending[0].alert);
    await second.resolve(input.alertname, input.component, 'Recovered');
    expect(post.mock.calls[1][0].startsAt).toBe(checkpoint.pending[0].alert.startsAt);
    expect((await journal.load()).pending).toEqual([]);
    second.stop();
  });

  it.each(['{broken JSON', '{"checksum":"bad","state":{"version":1}}'])(
    'quarantines readable corrupt state without silently clearing it: %s',
    async (raw) => {
      const journal = await store();
      await writeFile(journal.path, raw);
      const report = vi.fn();
      const post = vi.fn().mockResolvedValue(true);
      const delivery = new EngineAlertDelivery({ store: journal, post, report, automatic: false });
      await delivery.raise(input);
      await delivery.sendOne();
      expect(post).not.toHaveBeenCalled();
      expect(delivery.snapshot()).toMatchObject({ loaded: false, unpersistedObservations: 1 });
      expect(delivery.snapshot().error).toContain('corrupt');
      expect(await readFile(journal.path, 'utf8')).toBe(raw);
      const quarantines = (await readdir(journal.directory)).filter((name) =>
        name.startsWith('journal.corrupt.')
      );
      expect(quarantines).toHaveLength(1);
      expect(await readFile(join(journal.directory, quarantines[0]), 'utf8')).toBe(raw);
      expect(report).toHaveBeenCalledTimes(1);
      // Explicit repair restores a validated checkpoint. The queued observation
      // is then retried; the quarantined original remains available for review.
      await journal.save(emptyAlertJournal());
      await delivery.sendOne();
      expect(post).toHaveBeenCalledTimes(1);
      expect(
        (await readdir(journal.directory)).filter((name) => name.startsWith('journal.corrupt.'))
      ).toEqual(quarantines);
      delivery.stop();
    }
  );
});
