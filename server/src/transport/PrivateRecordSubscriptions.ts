import { AuthorizedPrivateSend } from './AuthorizedPrivateSend.js';

export const PRIVATE_RECORD_TOPIC =
  /^(?:member-record:[0-9a-f-]{36}:[0-9a-f-]{36}|club-roster:[0-9a-f-]{36})$/;
interface Invalidation {
  pipe: AuthorizedPrivateSend;
  queued: boolean;
  dirty: boolean;
}
/** Each socket owns its own topic intent and delivery authorization. */
export class PrivateRecordSubscriptions {
  private topics = new Map<string, AuthorizedPrivateSend>();
  private invalidations = new Map<string, Invalidation>();
  constructor(
    private owner: {
      current: () => boolean;
      authorize: (topic: string) => Promise<boolean>;
      send: (data: string, complete: (error?: Error) => void) => void;
      buffered: () => number;
      retire: () => void;
      error: (error: unknown) => void;
    }
  ) {}
  async join(topic: string, ready: () => boolean): Promise<void> {
    if (!PRIVATE_RECORD_TOPIC.test(topic) || (!this.topics.has(topic) && this.topics.size >= 64))
      return;
    this.leave(topic);
    const pipe: AuthorizedPrivateSend = new AuthorizedPrivateSend({
      ...this.owner,
      current: () => this.owner.current() && this.topics.get(topic) === pipe,
      authorize: async () => {
        const allowed = await this.owner.authorize(topic);
        if (!allowed) this.owner.retire();
        return allowed;
      },
    });
    this.topics.set(topic, pipe);
    if (
      !(await this.owner.authorize(topic)) ||
      !this.owner.current() ||
      this.topics.get(topic) !== pipe
    ) {
      if (this.topics.get(topic) === pipe) this.topics.delete(topic);
      return;
    }
    pipe.enqueue(JSON.stringify({ type: 'PRIVATE_RECORD_STATUS', topic, ready: ready() }));
  }
  leave(topic: string): void {
    this.topics.delete(topic);
    this.invalidations.delete(topic);
  }
  clear(): void {
    this.topics.clear();
    this.invalidations.clear();
  }
  notify(topic: string): void {
    const pipe = this.topics.get(topic);
    if (!pipe) return;
    let state = this.invalidations.get(topic);
    if (!state || state.pipe !== pipe) {
      state = { pipe, queued: false, dirty: false };
      this.invalidations.set(topic, state);
    }
    state.dirty = true;
    if (!state.queued) this.flushInvalidation(topic, state);
  }
  private flushInvalidation(topic: string, state: Invalidation): void {
    state.dirty = false;
    state.queued = true;
    state.pipe.enqueue(JSON.stringify({ type: 'PRIVATE_RECORD_CHANGED', topic }), () => {
      if (this.topics.get(topic) !== state.pipe) return;
      state.queued = false;
      // Commit notifications arriving before delivery completes owe a trailing
      // invalidation. Each actual frame still performs a fresh private ACL read.
      if (state.dirty) this.flushInvalidation(topic, state);
    });
  }
  readiness(ready: boolean): void {
    for (const [topic, pipe] of this.topics) {
      pipe.enqueue(JSON.stringify({ type: 'PRIVATE_RECORD_STATUS', topic, ready }));
    }
  }
}
