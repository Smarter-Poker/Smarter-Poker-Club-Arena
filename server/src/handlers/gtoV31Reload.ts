import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody } from '../http/body.js';
import { sendJSON } from '../http/respond.js';
import { supabase } from '../services/supabase/client.js';
import { getLiveHorseDecisionWorker } from '../engine/horseDecision/lane.js';
import {
  v31ControlIdentity,
  type V31ControlAck,
  type V31ControlRequest,
} from '../engine/horseDecision/v31ReloadControl.js';
type Identity = { requestId: string; datasetId: string; checksum: string };
type Ack = V31ControlAck & { worker: number };
export interface V31ReloadReceipt {
  requestId: string;
  datasetId: string;
  checksum: string;
  state: 'complete' | 'partial';
  expectedCells: number;
  workers: Ack[];
}
export class V31ReloadRequests {
  private receipts = new Map<
    string,
    { binding: string; settled: boolean; pending: Promise<V31ReloadReceipt> }
  >();
  constructor(
    private authority: (id: Identity) => Promise<number>,
    private dispatch: (request: V31ControlRequest) => Promise<Ack[]>
  ) {}
  async run(value: unknown, operation: 'reload' | 'status'): Promise<V31ReloadReceipt> {
    if (
      !v31ControlIdentity(value) ||
      Object.keys(value as object)
        .sort()
        .join(',') !== 'checksum,datasetId,requestId'
    )
      throw Error('invalid_request');
    const id = value as Identity,
      binding = JSON.stringify([id.datasetId, id.checksum]),
      key = operation + ':' + id.requestId,
      known = this.receipts.get(key);
    if (known) {
      if (known.binding !== binding) throw Error('request_identity_conflict');
      if (operation === 'reload' || !known.settled) return known.pending;
      this.receipts.delete(key);
    }
    if (this.receipts.size >= 16) {
      const evict = [...this.receipts].find(([, r]) => r.settled);
      if (!evict) throw Error('reload_capacity_busy');
      this.receipts.delete(evict[0]);
    }
    const pending = (async () => {
      // Current authority is checked before any message can request a worker load.
      const expectedCells = await this.authority(id);
      if (!Number.isSafeInteger(expectedCells) || expectedCells < 1 || expectedCells > 10000)
        throw Error('active_census_invalid');
      const workers = await this.dispatch({
        type: 'V31_STORE_CONTROL',
        operation,
        ...id,
        expectedCells,
      });
      if ((await this.authority(id)) !== expectedCells)
        throw Error('active_authority_changed_during_reload');
      const complete =
        workers.length === 8 &&
        new Set(workers.map((w) => w.worker)).size === 8 &&
        workers.every(
          (w) =>
            Number.isInteger(w.worker) &&
            w.worker >= 0 &&
            w.worker < 8 &&
            w.requestId === id.requestId &&
            w.operation === operation &&
            w.ok &&
            w.count === expectedCells &&
            w.dataset?.id === id.datasetId &&
            w.dataset.checksum === id.checksum
        );
      return {
        ...id,
        state: complete ? ('complete' as const) : ('partial' as const),
        expectedCells,
        workers,
      };
    })();
    // Reserve synchronously before authority/network await, so concurrent duplicates join one owner.
    const record = { binding, settled: false, pending };
    this.receipts.set(key, record);
    const markSettled = () => {
      record.settled = true;
    };
    void pending.then(markSettled).catch(markSettled);
    return pending;
  }
}
const requests = new V31ReloadRequests(
  async (id) => {
    const { data, error } = await supabase.rpc('ca_gto_v31_certification_status', {
      p_dataset_id: id.datasetId,
    });
    if (error) throw Error('active_authority_unavailable');
    const active = (data as any)?.active_dataset;
    if (
      active?.dataset_id !== id.datasetId ||
      active?.dataset_checksum !== id.checksum ||
      active?.state !== 'active' ||
      active?.quality_status !== 'validated'
    )
      throw Error('requested_dataset_not_active');
    return active.runtime_cells;
  },
  async (request) => {
    const lane = getLiveHorseDecisionWorker();
    if (lane.status().workerCount !== 8 || !lane.requestV31Control)
      throw Error('eight_worker_owner_unavailable');
    return lane.requestV31Control(request);
  }
);
/** Existing router INTERNAL_API_KEY is the sole request authority. No new secret. */
export async function handleGtoV31Reload(
  req: IncomingMessage,
  res: ServerResponse,
  verifyInternalKey: (req: IncomingMessage) => boolean,
  owner: V31ReloadRequests = requests
) {
  res.setHeader('Cache-Control', 'no-store');
  if (!verifyInternalKey(req)) return sendJSON(res, 401, { error: 'Unauthorized' });
  try {
    const url = new URL(req.url ?? '/', 'http://engine.local');
    if (req.method === 'GET' && url.searchParams.size !== 3) throw Error('invalid_request');
    const input =
      req.method === 'POST'
        ? JSON.parse(await readBody(req))
        : Object.fromEntries(url.searchParams);
    const receipt = await owner.run(input, req.method === 'POST' ? 'reload' : 'status');
    return sendJSON(res, receipt.state === 'complete' ? 200 : 409, receipt);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'reload_outcome_unknown';
    const invalid = error instanceof SyntaxError || reason === 'invalid_request';
    return sendJSON(res, invalid ? 400 : reason === 'request_identity_conflict' ? 409 : 503, {
      error: invalid ? 'invalid_request' : reason,
      activationPerformed: false,
    });
  }
}
