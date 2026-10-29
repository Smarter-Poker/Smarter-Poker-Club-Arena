/** Finite isolated Linux execution proof. Never admits unqualified programs to a store. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isMainThread, Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import {
  canonicalPublic215Json,
  compilePublicHist215,
  compilePublic215Provenance,
  public215Digest,
  strictObject,
  validPublic215Digest,
} from '../engine/GtoPublicHist215Model.js';
import {
  compilePublic215Template,
  encodePublic215Features,
  public215TemplateMatchesContext,
  PUBLIC_HIST215_FEATURE_SCHEMA_SHA256,
} from '../engine/GtoPublicHist215Features.js';
import { validatePublic215BuildReceipt } from '../engine/GtoPublicHist215BuildReceipt.js';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NATIVE_SOURCE = '83442cb6604dfaa30ec7ecc6ce38957355609e722b5df85b866365c97f0ccf9b';
const word = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeDoubleBE(n);
  return b.toString('hex');
};
const fail = (why: string): never => {
  throw Error('PUBLIC215_PREFLIGHT_' + why);
};
export function validatePreflightRequest(input: unknown) {
  const r = strictObject(input, ['format', 'dataset_id', 'program', 'cases']);
  if (
    r.format !== 'public_hist215_preflight_request_v1' ||
    typeof r.dataset_id !== 'string' ||
    !UUID.test(r.dataset_id)
  )
    return fail('REQUEST');
  const p = strictObject(r.program, [
    'context',
    'policy_representation',
    'public_model',
    'public_template',
    'public_training_provenance',
    'model_checksum',
    'template_checksum',
    'feature_schema_checksum',
    'training_provenance_checksum',
  ]);
  if (p.policy_representation !== 'public_hist215_v1') return fail('REPRESENTATION');
  if (p.feature_schema_checksum !== PUBLIC_HIST215_FEATURE_SCHEMA_SHA256)
    return fail('IMPLEMENTED_FEATURE_SCHEMA');
  const t = compilePublic215Template(p.public_template, p.template_checksum as string);
  if (!public215TemplateMatchesContext(t, p.context as any)) return fail('CONTEXT');
  const provenance = compilePublic215Provenance(
    p.public_training_provenance,
    p.training_provenance_checksum as string
  );
  const payload = p.public_model as any,
    raw = p.public_training_provenance as any;
  if (
    p.feature_schema_checksum !== provenance.featureSchemaChecksum ||
    raw.whole_variant !== payload.variant
  )
    return fail('PROVENANCE');
  const model = compilePublicHist215(payload, {
    model_sha256: p.model_checksum as string,
    template_sha256: p.template_checksum as string,
    feature_schema_sha256: p.feature_schema_checksum as string,
    provenance_sha256: p.training_provenance_checksum as string,
    action_ids: payload.action_ids,
  });
  if (!Array.isArray(r.cases) || r.cases.length < 2 || r.cases.length > 32) return fail('CASES');
  const seen = new Set<string>();
  const cases = r.cases.map((value) => {
    const c = strictObject(value, ['board', 'own']);
    if (
      typeof c.board !== 'string' ||
      !Array.isArray(c.own) ||
      c.own.length !== 2 ||
      ![c.board, ...c.own].every((v) => typeof v === 'string' && /^(?:[2-9TJQKA][cdhs])+$/.test(v))
    )
      return fail('CARDS');
    const id = (card: string) => '23456789TJQKA'.indexOf(card[0]) * 4 + 'cdhs'.indexOf(card[1]);
    if (id(c.own[0] as string) >= id(c.own[1] as string)) return fail('CANONICAL_OWN');
    if (
      c.own.some((v) => (v as string).length !== 2) ||
      c.board.length !== ({ flop: 6, turn: 8, river: 10 } as any)[t.context.street]
    )
      return fail('STREET');
    const all = [...(c.board.match(/../g) ?? []), ...c.own];
    if (new Set(all).size !== all.length) return fail('DUPLICATE_CARD');
    const key = c.board + ':' + [...c.own].sort().join('');
    if (seen.has(key)) return fail('DUPLICATE_CASE');
    seen.add(key);
    return { board: c.board, own: c.own as string[] };
  });
  return { r, p, t, model, raw, cases };
}
export function runPublic215Preflight(input: unknown) {
  if (isMainThread) return fail('WORKER_REQUIRED');
  if (process.platform !== 'linux' || !/^v22\./.test(process.version))
    return fail('LINUX_NODE22_REQUIRED');
  const { r, p, t, model, raw, cases } = validatePreflightRequest(input);
  const started = process.hrtime.bigint();
  const results = cases.map((c) => {
    const start = process.hrtime.bigint();
    const features = encodePublic215Features(c.own, c.board.match(/../g)!, t);
    const physics = Number(process.hrtime.bigint() - start) / 1e6;
    const prediction = model.predict(features);
    const inference = Number(process.hrtime.bigint() - start) / 1e6;
    if (inference > 8000) return fail('EXECUTION_BUDGET');
    return {
      ...c,
      features_f64: features.map(word),
      raw_heads_f64: model.predictRaw(features).map(word),
      policy_ev_f64: word(prediction.policyEvBb),
      Q_f64: model.actionIds.map((id) => word(prediction.actionEvsBb[id])),
      frequency_f64: model.actionIds.map((id) => word(prediction.mix[id])),
      physics_ms_f64: word(physics),
      inference_ms_f64: word(inference),
    };
  });
  const max = (key: 'physics_ms_f64' | 'inference_ms_f64') =>
    word(Math.max(...results.map((c) => Buffer.from(c[key], 'hex').readDoubleBE())));
  const receipt = {
    format: 'public_hist215_build_receipt_v1',
    dataset_id: r.dataset_id,
    input_bundle_checksum: raw.input_bundle_checksum,
    model_checksum: p.model_checksum,
    training_provenance_checksum: p.training_provenance_checksum,
    template_checksum: p.template_checksum,
    feature_schema_checksum: p.feature_schema_checksum,
    encoder_checksum: raw.encoder_checksum,
    physics_checksum: raw.physics_checksum,
    dependency_lock_checksum: raw.dependency_lock_checksum,
    producer_commit: raw.producer_commit,
    producer_bundle_checksum: raw.producer_bundle_checksum,
    runtime: {
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      napi_version: 8,
      native_source_checksum: NATIVE_SOURCE,
      native_binary_checksum: createHash('sha256')
        .update(
          readFileSync(new URL('../../native/build/public_hist215_wtl.node', import.meta.url))
        )
        .digest('hex'),
    },
    cases: results,
    cost: {
      method: 'cold_public215_features_and_all_heads_v1',
      clock: 'process.hrtime.bigint',
      cold_cases: results.length,
      max_physics_ms_f64: max('physics_ms_f64'),
      max_inference_ms_f64: max('inference_ms_f64'),
      execution_limit_ms: 8000,
      model_bytes: Buffer.byteLength(canonicalPublic215Json(p.public_model), 'ascii'),
      head_count: 1 + 2 * model.actionIds.length,
    },
  };
  const checksum = public215Digest(receipt);
  validatePublic215BuildReceipt(receipt, {
    ...receipt,
    receipt_checksum: checksum,
    model_payload: p.public_model,
    model,
    street: t.context.street as 'flop' | 'turn' | 'river',
  } as any);
  return {
    format: 'public_hist215_preflight_result_v1',
    receipt,
    receipt_checksum: checksum,
    execution_ms_f64: word(Number(process.hrtime.bigint() - started) / 1e6),
    peak_rss_bytes: process.resourceUsage().maxRSS * 1024,
  };
}
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1 || !validPublic215Digest(argv[0])) return fail('REQUEST_SHA_REQUIRED');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 4 * 1024 * 1024) return fail('REQUEST_TOO_LARGE');
    chunks.push(b);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== argv[0]) return fail('REQUEST_SHA');
  const input = JSON.parse(bytes.toString('utf8'));
  validatePreflightRequest(input);
  // The wrapper validates and transfers public programs only. All native physics
  // and model advice executes in one finite worker with a terminal exit+ack.
  const worker = new Worker(new URL('./public215ModelPreflightWorker.js', import.meta.url), {
    workerData: input,
    execArgv: [],
  });
  let result: unknown,
    failed = false;
  worker.on('message', (m) => {
    if (result !== undefined) {
      failed = true;
      return;
    }
    result = m;
  });
  worker.on('error', () => {
    failed = true;
  });
  const code = await new Promise<number>((resolve) => worker.once('exit', resolve));
  if (code !== 0 || failed || result === undefined) return fail('WORKER_TERMINAL');
  process.stdout.write(canonicalPublic215Json(result) + '\n');
}
if (isMainThread && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : 'PUBLIC215_PREFLIGHT_FAILED');
    process.exitCode = 1;
  });
