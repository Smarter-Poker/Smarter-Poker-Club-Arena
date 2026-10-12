type Frame = { topic: string; event: string; ref: string; payload: unknown };
type Observation = { sequence: number; elapsedMs: number; event: string; socket?: number };

function frame(message: string | Buffer): Frame | null {
  try {
    const value = JSON.parse(typeof message === 'string' ? message : message.toString('utf8'));
    const topic = Array.isArray(value) ? value[2] : value?.topic;
    const event = Array.isArray(value) ? value[3] : value?.event;
    const ref = Array.isArray(value) ? value[1] : value?.ref;
    const payload = Array.isArray(value) ? value[4] : value?.payload;
    if (typeof topic !== 'string' || typeof event !== 'string') return null;
    if (typeof ref !== 'string' && typeof ref !== 'number') return null;
    return { topic, event, ref: String(ref), payload };
  } catch {
    return null;
  }
}

/** Passive certification evidence. Socket creation alone never authorizes a cursor read. */
export class MissionCursorLifecycle {
  private pendingJoins = new Set<string>();
  private credits = 0;
  private armedAt: number | null = null;
  private lastResumeAt = -Infinity;
  private observations: Observation[] = [];
  private unexplainedReads = 0;
  private joins = 0;
  private resumes = 0;
  private reads = 0;

  constructor(
    private readonly missionTopic: string,
    private readonly now = Date.now
  ) {}

  begin(): void {
    this.armedAt = this.now();
    this.credits = 0;
    this.observations = [];
    this.unexplainedReads = this.joins = this.resumes = this.reads = 0;
    this.lastResumeAt = -Infinity;
  }

  clientMessage(socket: number, message: string | Buffer): void {
    const parsed = frame(message);
    if (parsed?.topic !== this.missionTopic || parsed.event !== 'phx_join') return;
    // Bound transport metadata; never retain authentication payloads or raw frames.
    if (this.pendingJoins.size >= 128)
      throw new Error('Mission join observation exceeded its bound');
    this.pendingJoins.add(`${socket}:${parsed.ref}`);
  }

  serverMessage(socket: number, message: string | Buffer): void {
    const parsed = frame(message);
    if (parsed?.topic !== this.missionTopic || parsed.event !== 'phx_reply') return;
    const key = `${socket}:${parsed.ref}`;
    if (!this.pendingJoins.delete(key)) return;
    if (!parsed.payload || typeof parsed.payload !== 'object') return;
    if ((parsed.payload as { status?: unknown }).status !== 'ok') return;
    if (this.armedAt === null) return;
    this.joins += 1;
    this.credits += 1;
    this.record('mission_join', socket);
  }

  resume(event: 'focus' | 'visible'): void {
    if (this.armedAt === null) return;
    const at = this.now();
    // Same event coalescing as the page's existing resume handler.
    if (at - this.lastResumeAt < 1000) return;
    this.lastResumeAt = at;
    this.resumes += 1;
    this.credits += 1;
    this.record(event);
  }

  cursorRead(): void {
    if (this.armedAt === null) return;
    this.reads += 1;
    if (this.credits > 0) this.credits -= 1;
    else this.unexplainedReads += 1;
    this.record('cursor_read');
  }

  receipt() {
    return {
      joins: this.joins,
      resumes: this.resumes,
      reads: this.reads,
      unexplainedReads: this.unexplainedReads,
      timeline: [...this.observations],
    };
  }

  private record(event: string, socket?: number): void {
    if (this.observations.length >= 512)
      throw new Error('Mission lifecycle observation exceeded its bound');
    this.observations.push({
      sequence: this.observations.length + 1,
      elapsedMs: this.now() - this.armedAt!,
      event,
      ...(socket === undefined ? {} : { socket }),
    });
  }
}
