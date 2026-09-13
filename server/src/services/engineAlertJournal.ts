import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface JournalAlert {
  status: 'firing' | 'resolved';
  fingerprint: string;
  labels: Record<string, string>;
  annotations: { summary: string; description?: string };
  startsAt: string;
  endsAt?: string;
}
export interface JournalEvent {
  sequence: number;
  alert: JournalAlert;
}
export interface ActiveAlert {
  fingerprint: string;
  alertname: string;
  component: string;
  startsAt: string;
  episodeId: string;
  priority: 'page' | 'normal';
}
export interface AlertJournalState {
  version: 1;
  nextSequence: number;
  active: ActiveAlert[];
  pending: JournalEvent[];
}
export const emptyAlertJournal = (): AlertJournalState => ({
  version: 1,
  nextSequence: 1,
  active: [],
  pending: [],
});
export interface AlertJournalStore {
  load(): Promise<AlertJournalState>;
  save(state: AlertJournalState): Promise<void>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const instant = (value: unknown): value is string =>
  text(value) && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string =>
  text(value) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const strings = (value: unknown): value is Record<string, string> =>
  record(value) && Object.values(value).every((v) => typeof v === 'string');

/** Refuse unknown/corrupt state; an empty queue is never an error fallback. */
export function validateAlertJournal(value: unknown): asserts value is AlertJournalState {
  const invalid = () => {
    throw new Error('Invalid engine alert journal state');
  };
  if (
    !record(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.nextSequence) ||
    Number(value.nextSequence) < 1 ||
    !Array.isArray(value.active) ||
    !Array.isArray(value.pending)
  )
    invalid();
  const state = value as AlertJournalState;
  const activeIds = new Set<string>();
  for (const active of state.active) {
    if (
      !record(active) ||
      !text(active.fingerprint) ||
      !text(active.alertname) ||
      !text(active.component) ||
      !instant(active.startsAt) ||
      !uuid(active.episodeId) ||
      !['page', 'normal'].includes(active.priority) ||
      active.fingerprint !== `${active.alertname}:${active.component}` ||
      activeIds.has(active.fingerprint)
    )
      invalid();
    activeIds.add(active.fingerprint);
  }
  let sequence = 0;
  const eventIds = new Set<string>();
  for (const event of state.pending) {
    if (
      !record(event) ||
      !Number.isSafeInteger(event.sequence) ||
      event.sequence <= sequence ||
      event.sequence >= state.nextSequence ||
      !record(event.alert)
    )
      invalid();
    const alert = event.alert;
    if (
      !['firing', 'resolved'].includes(alert.status) ||
      !text(alert.fingerprint) ||
      !strings(alert.labels) ||
      !text(alert.labels.alertname) ||
      !text(alert.labels.component) ||
      !uuid(alert.labels.engine_alert_episode_id) ||
      !uuid(alert.labels.engine_alert_event_id) ||
      !['page', 'normal'].includes(alert.labels.engine_alert_priority) ||
      eventIds.has(alert.labels.engine_alert_event_id) ||
      !record(alert.annotations) ||
      typeof alert.annotations.summary !== 'string' ||
      !instant(alert.startsAt) ||
      (alert.annotations.description !== undefined &&
        typeof alert.annotations.description !== 'string') ||
      (alert.status === 'resolved' && !instant(alert.endsAt)) ||
      alert.fingerprint !== `${alert.labels.alertname}:${alert.labels.component}`
    )
      invalid();
    eventIds.add(alert.labels.engine_alert_event_id);
    sequence = event.sequence;
  }
}

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

/** Atomic, fsynced checkpoints live on the host bind mount, outside images.
 * A corrupt checkpoint is copied byte-for-byte to a deterministic quarantine
 * file and left in place: neither the old evidence nor the failure is hidden
 * by replacing it with an empty state. */
export class FileAlertJournal implements AlertJournalStore {
  readonly path: string;
  constructor(readonly directory: string) {
    this.path = join(directory, 'journal.json');
  }

  private async syncDirectory(): Promise<void> {
    const directory = await open(this.directory, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async load(): Promise<AlertJournalState> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyAlertJournal();
      throw error;
    }
    try {
      const envelope: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !record(envelope) ||
        typeof envelope.checksum !== 'string' ||
        envelope.checksum !== digest(JSON.stringify(envelope.state))
      )
        throw new Error('checksum mismatch');
      validateAlertJournal(envelope.state);
      return envelope.state;
    } catch {
      const quarantine = join(this.directory, `journal.corrupt.${digest(bytes)}.json`);
      try {
        const file = await open(quarantine, 'wx', 0o600);
        try {
          await file.writeFile(bytes);
          await file.sync();
        } finally {
          await file.close();
        }
        await this.syncDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      throw new Error(
        `Engine alert journal is corrupt; delivery paused; evidence retained at ${quarantine}`
      );
    }
  }

  async save(state: AlertJournalState): Promise<void> {
    validateAlertJournal(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `.journal.${randomUUID()}.tmp`);
    const serialized = JSON.stringify(state);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ checksum: digest(serialized), state }) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      await this.syncDirectory();
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
