import { WEBSOCKET_HARD_BACKPRESSURE_BYTES } from './webSocketBackpressure.js';

/** The original socket owns this finite ordered queue; no grant is cached. */
export class AuthorizedPrivateSend {
  private pending: Array<{
    data: string;
    delivered?: () => void;
    current?: () => boolean;
    bytes: number;
  }> = [];
  private bytes = 0;
  private draining = false;
  constructor(
    private readonly owner: {
      current: () => boolean;
      authorize: () => Promise<boolean>;
      send: (data: string, complete: (error?: Error) => void) => void;
      buffered: () => number;
      retire: () => void;
      error: (error: unknown) => void;
    }
  ) {}
  enqueue(data: string, delivered?: () => void, current?: () => boolean): void {
    if (!this.owner.current()) return;
    const bytes = Buffer.byteLength(data);
    if (
      this.pending.length >= 256 ||
      this.bytes + bytes + this.owner.buffered() > WEBSOCKET_HARD_BACKPRESSURE_BYTES
    ) {
      this.pending = [];
      this.bytes = 0;
      try {
        this.owner.retire();
      } catch (error) {
        this.owner.error(error);
      }
      return;
    }
    this.pending.push({ data, delivered, current, bytes });
    this.bytes += bytes;
    if (!this.draining) void this.drain();
  }
  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.pending.length) {
        const frame = this.pending[0];
        if (!this.owner.current()) {
          this.pending = [];
          this.bytes = 0;
          return;
        }
        const allowed = await this.owner.authorize();
        if (this.pending[0] !== frame) continue;
        if (!allowed || !this.owner.current() || (frame.current && !frame.current())) {
          this.pending.shift();
          this.bytes -= frame.bytes;
          continue;
        }
        if (this.owner.buffered() > WEBSOCKET_HARD_BACKPRESSURE_BYTES) {
          this.pending = [];
          this.bytes = 0;
          this.owner.retire();
          return;
        }
        try {
          await new Promise<void>((resolve, reject) => {
            this.owner.send(frame.data, (error) => (error ? reject(error) : resolve()));
          });
          if (
            this.pending[0] === frame &&
            this.owner.current() &&
            (!frame.current || frame.current())
          ) {
            frame.delivered?.();
          }
        } catch (error) {
          this.owner.error(error);
        } finally {
          if (this.pending[0] === frame) {
            this.pending.shift();
            this.bytes -= frame.bytes;
          }
        }
      }
    } catch (error) {
      this.pending = [];
      this.bytes = 0;
      this.owner.error(error);
    } finally {
      this.draining = false;
    }
  }
}
