/** Separate socket/auth readiness from the SDK's channel join deadline.
 * A live cold socket took 15.164s to open while subscribe() spent its 10s
 * join budget in the send buffer. Admission has its own finite 20s budget;
 * channel joins retain the SDK's original timeout. No retry or refresher here.
 */
interface RealtimeOwner {
  setAuth(): Promise<void>;
  connect(): void;
  isConnected(): boolean;
}

export class RealtimeAdmission {
  readonly transport: typeof WebSocket;
  private socket: WebSocket | null = null;
  private observers = new Set<(error?: Error) => void>();

  constructor(NativeSocket?: typeof WebSocket) {
    // The supported custom transport returns the native socket. Event listeners
    // observe it; the SDK still owns onopen/onclose and reconnect/heartbeat.
    const createSocket = (url: string | URL, protocols?: string | string[]) => {
      const Socket = NativeSocket ?? globalThis.WebSocket;
      const socket = new Socket(url, protocols);
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (this.socket === socket) this.notify();
      });
      const failed = () => {
        if (this.socket === socket)
          this.notify(new Error('Realtime transport closed before admission'));
      };
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      return socket;
    };
    this.transport = function (url: string | URL, protocols?: string | string[]) {
      return createSocket(url, protocols);
    } as unknown as typeof WebSocket;
  }

  private notify(error?: Error): void {
    for (const observer of [...this.observers]) observer(error);
  }

  ready(client: RealtimeOwner, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let authenticated = false;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.observers.delete(observe);
        signal.removeEventListener('abort', aborted);
        if (error) reject(error);
        else resolve();
      };
      const observe = (error?: Error) => {
        if (error) return finish(error);
        // Resume after dispatch so the native SDK onopen runs first.
        queueMicrotask(() => {
          if (authenticated && client.isConnected()) finish();
        });
      };
      const aborted = () => finish(new DOMException('Realtime admission cancelled', 'AbortError'));
      const timer = setTimeout(
        () =>
          finish(new DOMException('Realtime transport/auth admission timed out', 'TimeoutError')),
        20_000
      );
      this.observers.add(observe);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) return aborted();
      try {
        client.connect();
        void client.setAuth().then(
          () => {
            authenticated = true;
            observe();
          },
          (error: unknown) =>
            finish(error instanceof Error ? error : new Error('Realtime authentication failed'))
        );
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Realtime connection failed'));
      }
    });
  }
}

export const realtimeAdmission = new RealtimeAdmission();
