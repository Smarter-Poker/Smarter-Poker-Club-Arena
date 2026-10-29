/** Request-scoped administrative reads/loads, separate from decision FIFO clocks. */
export interface V31ControlRequest {
  type: 'V31_STORE_CONTROL';
  operation: 'reload' | 'status';
  requestId: string;
  datasetId: string;
  checksum: string;
  expectedCells: number;
}
export interface V31ControlAck {
  type: 'V31_STORE_CONTROL_ACK';
  operation: 'reload' | 'status';
  requestId: string;
  ok: boolean;
  count: number;
  dataset: { id: string; checksum: string } | null;
  error: string | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
export function v31ControlIdentity(
  value: unknown
): value is { requestId: string; datasetId: string; checksum: string } {
  const v = value as any;
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.requestId === 'string' &&
    typeof v.datasetId === 'string' &&
    typeof v.checksum === 'string' &&
    uuid.test(v.requestId) &&
    uuid.test(v.datasetId) &&
    hash.test(v.checksum) &&
    v.checksum !== '0'.repeat(64)
  );
}
export function v31ControlRequestValid(v: any): v is V31ControlRequest {
  return (
    v31ControlIdentity(v) &&
    (v as any).type === 'V31_STORE_CONTROL' &&
    ['reload', 'status'].includes((v as any).operation) &&
    Number.isSafeInteger((v as any).expectedCells) &&
    (v as any).expectedCells > 0 &&
    (v as any).expectedCells <= 10000 &&
    Object.keys(v).sort().join(',') === 'checksum,datasetId,expectedCells,operation,requestId,type'
  );
}
export function v31ControlAckValid(v: any): v is V31ControlAck {
  return (
    !!v &&
    v.type === 'V31_STORE_CONTROL_ACK' &&
    ['reload', 'status'].includes((v as any).operation) &&
    typeof v.requestId === 'string' &&
    uuid.test(v.requestId) &&
    typeof v.ok === 'boolean' &&
    Number.isSafeInteger(v.count) &&
    v.count >= 0 &&
    v.count <= 10000 &&
    (v.error === null || typeof v.error === 'string') &&
    (v.count === 0
      ? v.dataset === null
      : !!v.dataset &&
        Object.keys(v.dataset).sort().join(',') === 'checksum,id' &&
        typeof v.dataset.id === 'string' &&
        typeof v.dataset.checksum === 'string' &&
        uuid.test(v.dataset.id) &&
        hash.test(v.dataset.checksum) &&
        v.dataset.checksum !== '0'.repeat(64)) &&
    Object.keys(v).sort().join(',') === 'count,dataset,error,ok,operation,requestId,type'
  );
}
export function createV31WorkerControl(deps: {
  load: () => Promise<{ ok: boolean; count: number }>;
  snapshot: () => { count: number; dataset: V31ControlAck['dataset'] };
  send: (ack: V31ControlAck) => void;
}) {
  const receipts = new Map<
    string,
    { binding: string; pending: Promise<V31ControlAck>; settled: boolean }
  >();
  let loading = false;
  return (input: unknown): boolean => {
    if ((input as any)?.type !== 'V31_STORE_CONTROL') return false;
    if (!v31ControlRequestValid(input)) return true;
    const r = input,
      key = r.operation + ':' + r.requestId,
      binding = JSON.stringify(r);
    let known = receipts.get(key);
    if (known && r.operation === 'status' && known.settled) {
      receipts.delete(key);
      known = undefined;
    }
    if (known) {
      if (known.binding === binding) void known.pending.then(deps.send);
      else
        deps.send({
          type: 'V31_STORE_CONTROL_ACK',
          operation: r.operation,
          requestId: r.requestId,
          ok: false,
          ...deps.snapshot(),
          error: 'request_identity_conflict',
        });
      return true;
    }
    // Never evict a pending operation, and never start a retry after losing its owner.
    if (receipts.size >= 32) {
      const evict = [...receipts].find(([, v]) => v.settled);
      if (evict) receipts.delete(evict[0]);
    }
    if (receipts.size >= 32 || (r.operation === 'reload' && loading)) {
      deps.send({
        type: 'V31_STORE_CONTROL_ACK',
        operation: r.operation,
        requestId: r.requestId,
        ok: false,
        ...deps.snapshot(),
        error: 'control_capacity_or_reload_busy',
      });
      return true;
    }
    if (r.operation === 'reload') loading = true;
    const pending = (async () => {
      let loadOk = true,
        error: string | null = null;
      try {
        if (r.operation === 'reload') {
          const result = await deps.load();
          loadOk = result.ok === true && result.count === r.expectedCells;
        }
      } catch {
        loadOk = false;
        error = 'active_store_load_failed';
      }
      const actual = deps.snapshot(),
        ok =
          loadOk &&
          actual.count === r.expectedCells &&
          actual.dataset?.id === r.datasetId &&
          actual.dataset?.checksum === r.checksum;
      return {
        type: 'V31_STORE_CONTROL_ACK' as const,
        operation: r.operation,
        requestId: r.requestId,
        ok,
        ...actual,
        error: ok ? null : (error ?? 'active_store_identity_not_confirmed'),
      };
    })().finally(() => {
      if (r.operation === 'reload') loading = false;
    });
    const receipt = { binding, pending, settled: false };
    receipts.set(key, receipt);
    void pending.then((ack) => {
      receipt.settled = true;
      deps.send(ack);
    });
    return true;
  };
}
/** Only one request deadline; a timeout reports unknown and never retries or terminates a healthy worker. */
export class V31ControlClient {
  private pending = new Map<
    string,
    {
      binding: string;
      resolve: (a: V31ControlAck) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private post: (request: V31ControlRequest) => void,
    private deadlineMs = 120000
  ) {}
  request(request: V31ControlRequest): Promise<V31ControlAck> {
    if (!v31ControlRequestValid(request))
      return Promise.reject(Error('invalid_v31_control_request'));
    const key = request.operation + ':' + request.requestId,
      binding = JSON.stringify(request),
      known = this.pending.get(key);
    if (known) return Promise.reject(Error('v31_control_request_already_pending'));
    if (this.pending.size >= 2) return Promise.reject(Error('v31_control_capacity'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(Error('v31_control_outcome_unknown'));
      }, this.deadlineMs);
      timer.unref?.();
      this.pending.set(key, { binding, resolve, reject, timer });
      try {
        this.post(request);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
  close(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
  receive(value: unknown): boolean {
    if ((value as any)?.type !== 'V31_STORE_CONTROL_ACK') return false;
    if (!v31ControlAckValid(value)) return true;
    const key = value.operation + ':' + value.requestId,
      pending = this.pending.get(key);
    if (!pending) return true;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    const expected = JSON.parse(pending.binding) as V31ControlRequest;
    if (
      value.ok &&
      (value.error !== null ||
        value.count !== expected.expectedCells ||
        value.dataset?.id !== expected.datasetId ||
        value.dataset.checksum !== expected.checksum)
    ) {
      pending.reject(Error('v31_control_ack_binding_mismatch'));
      return true;
    }
    pending.resolve(value);
    return true;
  }
}
