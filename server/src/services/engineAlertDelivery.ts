import { randomUUID } from 'node:crypto';
import type { EngineAlertInput } from './engineAlerts.js';
import type {
  ActiveAlert,
  AlertJournalState,
  AlertJournalStore,
  JournalAlert,
} from './engineAlertJournal.js';

type Observation =
  | { input: EngineAlertInput }
  | { alertname: string; component: string; summary: string };
type Options = {
  store: AlertJournalStore;
  post: (alert: JournalAlert) => Promise<boolean>;
  report: (error: unknown) => void;
  raised?: (input: EngineAlertInput, startsAt: string) => void;
  now?: () => string;
  id?: () => string;
  retryMs?: number;
  automatic?: boolean;
};

/** Observation state and delivery state are separate. Firing -> recovery ->
 * firing is three immutable, ordered events even when the receiver is offline.
 * File operations serialize; a slow network send never holds that lock or
 * prevents a later observation from becoming durable. */
export class EngineAlertDelivery {
  private state: AlertJournalState | undefined;
  private observations: Array<{ observation: Observation; observedAt: string; eventId?: string }> =
    [];
  private dirty = false;
  private serial: Promise<unknown> = Promise.resolve();
  private sending: Promise<string | undefined> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private lastError: string | null = null;
  private lastAttemptAt: string | null = null;
  private lastAcknowledgedAt: string | null = null;
  private readonly now: () => string;
  private readonly id: () => string;

  constructor(private readonly options: Options) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.id = options.id ?? randomUUID;
    if (options.automatic !== false) {
      this.timer = setInterval(() => {
        void this.sendOne();
      }, options.retryMs ?? 5000);
      this.timer.unref();
      void this.sendOne();
    }
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => undefined);
    return result;
  }

  private failed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.lastError !== message) {
      this.lastError = message;
      try {
        this.options.report(error);
      } catch {
        /* alarms never throw into gameplay */
      }
    }
  }

  private transition(observation: Observation, observedAt: string): string | undefined {
    const state = this.state!;
    const input = 'input' in observation ? observation.input : observation;
    const fingerprint = `${input.alertname}:${input.component}`;
    const existing = state.active.find((active) => active.fingerprint === fingerprint);
    let active: ActiveAlert;
    let alert: JournalAlert;
    const eventId = this.id();
    if ('input' in observation) {
      if (existing) return undefined;
      active = {
        fingerprint,
        alertname: input.alertname,
        component: input.component,
        startsAt: observedAt,
        episodeId: this.id(),
        priority: observation.input.page === true ? 'page' : 'normal',
      };
      const raised = observation.input;
      alert = {
        status: 'firing',
        fingerprint,
        startsAt: active.startsAt,
        labels: {
          ...(raised.labels ?? {}),
          alertname: raised.alertname,
          severity: raised.severity,
          component: raised.component,
          engine_alert_episode_id: active.episodeId,
          engine_alert_event_id: eventId,
          engine_alert_priority: active.priority,
        },
        annotations: { summary: raised.summary, description: raised.description ?? '' },
      };
      state.active.push(active);
      try {
        this.options.raised?.(raised, active.startsAt);
      } catch (error) {
        this.failed(error);
      }
    } else {
      if (!existing) return undefined;
      active = existing;
      alert = {
        status: 'resolved',
        fingerprint,
        startsAt: active.startsAt,
        endsAt: observedAt,
        labels: {
          alertname: active.alertname,
          severity: 'info',
          component: active.component,
          engine_alert_episode_id: active.episodeId,
          engine_alert_event_id: eventId,
          engine_alert_priority: active.priority,
        },
        annotations: { summary: observation.summary },
      };
      state.active = state.active.filter((candidate) => candidate.fingerprint !== fingerprint);
    }
    state.pending.push({ sequence: state.nextSequence++, alert });
    this.dirty = true;
    return eventId;
  }

  private async ready(): Promise<void> {
    if (!this.state) this.state = await this.options.store.load();
    // Retained observations are replayed after a temporarily unreadable store
    // becomes available. A corrupt store stays quarantined and never becomes
    // an invented empty state.
    while (this.observations.length) {
      const queued = this.observations[0];
      queued.eventId = this.transition(queued.observation, queued.observedAt);
      this.observations.shift();
    }
    if (this.dirty) {
      await this.options.store.save(this.state);
      this.dirty = false;
    }
    // A healed store can contain no pending event (for example, only healthy
    // observations with no active episode). Do not leave a phantom failure in
    // /health forever merely because no HTTP acknowledgment will follow.
    if (!this.state.pending.length) this.lastError = null;
  }

  private async observe(observation: Observation): Promise<string | undefined> {
    const observedAt = this.now();
    return this.exclusive(async () => {
      // Do not lose the observation if loading the journal fails.
      const queued: { observation: Observation; observedAt: string; eventId?: string } = {
        observation,
        observedAt,
      };
      this.observations.push(queued);
      try {
        await this.ready();
        return queued.eventId;
      } catch (error) {
        this.failed(error);
        return undefined;
      }
    });
  }

  async raise(input: EngineAlertInput): Promise<boolean> {
    const eventId = await this.observe({
      input: { ...input, labels: { ...(input.labels ?? {}) } },
    });
    const acknowledged = await this.sendOne();
    return eventId !== undefined && acknowledged === eventId;
  }

  async resolve(alertname: string, component: string, summary: string): Promise<boolean> {
    const eventId = await this.observe({ alertname, component, summary });
    const acknowledged = await this.sendOne();
    return eventId !== undefined && acknowledged === eventId;
  }

  private async attempt(): Promise<string | undefined> {
    const event = await this.exclusive(async () => {
      await this.ready();
      return this.state!.pending[0];
    });
    if (!event || this.stopped) return undefined;
    this.lastAttemptAt = this.now();
    if (!(await this.options.post(event.alert)) || this.stopped) return undefined;
    return this.exclusive(async () => {
      // A lost acknowledgement checkpoint leaves the same event pending. Its
      // immutable event ID makes the replay idempotent at the durable receiver.
      const state = this.state!;
      if (state.pending[0]?.sequence !== event.sequence)
        throw new Error('Engine alert queue order changed');
      const next = { ...state, pending: state.pending.slice(1) };
      await this.options.store.save(next);
      this.state = next;
      this.dirty = false;
      this.lastError = null;
      this.lastAcknowledgedAt = this.now();
      return event.alert.labels.engine_alert_event_id;
    });
  }

  /** At most one network attempt is in flight. Public calls wait for at most
   * that attempt; subsequent events drain independently in the background. */
  sendOne(): Promise<string | undefined> {
    if (this.sending) return this.sending;
    if (this.stopped) return Promise.resolve(undefined);
    let acknowledged: string | undefined;
    this.sending = this.attempt()
      .then((id) => {
        acknowledged = id;
        return id;
      })
      .catch((error) => {
        this.failed(error);
        return undefined;
      })
      .finally(() => {
        this.sending = null;
        if (
          acknowledged &&
          this.options.automatic !== false &&
          !this.stopped &&
          this.state?.pending.length
        )
          setImmediate(() => {
            void this.sendOne();
          });
      });
    return this.sending;
  }

  /** Test/operational seam, without changing or clearing queued evidence. */
  snapshot() {
    return {
      loaded: this.state !== undefined,
      pending: this.state?.pending.length ?? 0,
      oldestPendingAt:
        this.state?.pending[0]?.alert.endsAt ?? this.state?.pending[0]?.alert.startsAt ?? null,
      lastAttemptAt: this.lastAttemptAt,
      lastAcknowledgedAt: this.lastAcknowledgedAt,
      unpersistedObservations: this.observations.length,
      dirty: this.dirty,
      firing: this.state?.active.map((active) => active.fingerprint).sort() ?? [],
      error: this.lastError,
    };
  }
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
  async persistBeforeExit(): Promise<boolean> {
    this.stop();
    try {
      await this.exclusive(async () => {
        await this.ready();
      });
      return true;
    } catch (error) {
      this.failed(error);
      return false;
    }
  }
}

/** Explicit in-memory test seam; production always uses FileAlertJournal. */
export class MemoryAlertJournal implements AlertJournalStore {
  constructor(public state: AlertJournalState) {}
  async load(): Promise<AlertJournalState> {
    return structuredClone(this.state);
  }
  async save(state: AlertJournalState): Promise<void> {
    this.state = structuredClone(state);
  }
}
