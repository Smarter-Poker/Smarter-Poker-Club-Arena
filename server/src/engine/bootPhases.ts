/**
 * THE BOOT NAMES WHERE ITS TIME GOES (2026-10-24).
 *
 * A cutover is admitted only while the candidate reaches HTTP 200 with
 * `dealerPrerequisitesReady` inside a fixed budget. On 2026-10-24 release
 * e4f793b6 took ~63 s from launch to readiness and de8ada47 ~96 s; two
 * releases rolled back because readiness came too late, and the only evidence
 * of where the time went was the gaps between unrelated log lines ("~24 s
 * silent, then hydration, then ~24 s silent").
 *
 * Every awaited boot phase now records when it started and ended, measured
 * from the PROCESS start (`performance.timeOrigin`), which is the clock the
 * release transaction's readiness budget actually runs on. Phases may overlap
 * (the decision lanes and the stale-data cleanup run concurrently), so each
 * carries its own start and end rather than a "since previous" delta. The
 * same record is printed one line per phase and published on /health as
 * `bootPhases`, so the next cutover shows its own breakdown from outside the
 * container.
 *
 * Deliberately zero imports, like engineStartBudget.ts: a pure recorder that
 * tests can drive with a fake clock without initialising a database client.
 */

export interface BootPhaseRecord {
  name: string;
  /** Milliseconds after process start the phase began. */
  startMs: number;
  /** Milliseconds after process start the phase ended; null while running. */
  endMs: number | null;
  /** endMs - startMs; null while running. */
  durationMs: number | null;
  /** How it ended: ok, failed or cancelled; null while running. */
  outcome: BootPhaseOutcome | null;
}

export type BootPhaseOutcome = 'ok' | 'failed' | 'cancelled';

export interface BootPhaseSnapshot {
  /** ISO time the process started (performance.timeOrigin). */
  processStartedAt: string;
  /** Milliseconds after process start the dealer gate opened; null until then. */
  dealerReadyMs: number | null;
  phases: BootPhaseRecord[];
}

/** At most this many phases are kept; a boot has about a dozen. */
const MAX_PHASES = 64;

export class BootPhaseTimeline {
  private readonly phases: BootPhaseRecord[] = [];
  private dealerReadyMs: number | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly processStartedAtMs: number = Math.round(performance.timeOrigin),
    private readonly log: (line: string) => void = (line) => console.log(line)
  ) {}

  private sinceStart(): number {
    return Math.max(0, Math.round(this.now() - this.processStartedAtMs));
  }

  private writeLog(line: string): void {
    try {
      this.log(line);
    } catch {
      // Timing diagnostics cannot change boot readiness or mask its error.
      // The recorded phase remains available through the health snapshot.
    }
  }

  /**
   * Begin a phase. The returned function ends it (once; later calls are
   * ignored) and prints one line. Recording never throws into the boot.
   */
  begin(name: string): (outcome?: BootPhaseOutcome) => void {
    const record: BootPhaseRecord = {
      name,
      startMs: this.sinceStart(),
      endMs: null,
      durationMs: null,
      outcome: null,
    };
    if (this.phases.length < MAX_PHASES) this.phases.push(record);
    return (outcome: BootPhaseOutcome = 'ok') => {
      if (record.endMs !== null) return;
      record.endMs = this.sinceStart();
      record.durationMs = record.endMs - record.startMs;
      record.outcome = outcome;
      this.writeLog(
        `[BootPhase] ${name} ${outcome} in ${record.durationMs}ms ` +
          `(started ${record.startMs}ms, ended ${record.endMs}ms after process start)`
      );
    };
  }

  /** Time one awaited operation as a phase; the operation's result is unchanged. */
  async measure<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const end = this.begin(name);
    try {
      const value = await operation();
      end('ok');
      return value;
    } catch (error) {
      end('failed');
      throw error;
    }
  }

  /** A zero-length milestone, e.g. the HTTP listener opening. */
  mark(name: string): void {
    this.begin(name)('ok');
  }

  /** The dealer gate opened: the instant /health can first answer 200. */
  markDealerReady(): void {
    if (this.dealerReadyMs !== null) return;
    this.dealerReadyMs = this.sinceStart();
    const summary = this.phases
      .filter((p) => p.durationMs !== null)
      .map((p) => `${p.name}=${p.durationMs}`)
      .join(' ');
    this.writeLog(
      `[BootPhase] dealer prerequisites ready ${this.dealerReadyMs}ms after process start; ` +
        `phase durations ms: ${summary}`
    );
  }

  snapshot(): BootPhaseSnapshot {
    return {
      processStartedAt: new Date(this.processStartedAtMs).toISOString(),
      dealerReadyMs: this.dealerReadyMs,
      phases: this.phases.map((p) => ({ ...p })),
    };
  }
}
