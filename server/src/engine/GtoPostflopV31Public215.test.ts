import { beforeEach, expect, it } from 'vitest';
import { isMainThread } from 'node:worker_threads';
import {
  _clearGtoPostflopV31,
  replaceGtoPostflopV31,
  replaceGtoPostflopV31Async,
  gtoPostflopV31Count,
  gtoPostflopV31Dataset,
  gtoStreetAdviceV31,
  gtoV31CellMatrix,
} from './GtoPostflopV31.js';
import { public215Digest } from './GtoPublicHist215Model.js';
import { fixture, bind, hex, input } from './__tests__/public215Fixture.js';
beforeEach(() => _clearGtoPostflopV31());
it('yields between detached model admissions and retains the old complete store until the final swap', async () => {
  const old = fixture(20);
  replaceGtoPostflopV31([old]);
  const a = fixture(),
    b = fixture(40);
  a.dataset_cells = b.dataset_cells = 2;
  a.dataset_checksum = b.dataset_checksum = 'b'.repeat(64);
  const replacing = replaceGtoPostflopV31Async([a, b]);
  await new Promise<void>((resolve) => process.nextTick(resolve));
  expect(gtoPostflopV31Count()).toBe(1);
  expect(gtoPostflopV31Dataset()?.checksum).toBe(old.dataset_checksum);
  await expect(replacing).resolves.toBe(2);
  expect(gtoPostflopV31Dataset()?.checksum).toBe(a.dataset_checksum);
});
it('admits real model rows with explicit head order despite reversed action-spec object order', () => {
  const r = fixture();
  expect(replaceGtoPostflopV31([r])).toBe(1);
  expect(gtoPostflopV31Count()).toBe(1);
  expect(gtoPostflopV31Dataset()).toMatchObject({
    checksum: r.dataset_checksum,
    feature_contract_version: 'holdem-public-hist215-v1',
  });
  expect(isMainThread).toBe(true);
  expect(gtoStreetAdviceV31(input)).toEqual({ hit: false, miss: 'worker_required' });
  expect(gtoV31CellMatrix({ ...input, texture: 'Brud' })).toBeNull();
});
it('rejects malformed model, context, provenance and fake matrices without replacing last snapshot', () => {
  const good = fixture();
  replaceGtoPostflopV31([good]);
  for (const change of [
    (r: any) => (r.model_checksum = 'b'.repeat(64)),
    (r: any) => r.public_model.heads.pop(),
    (r: any) => (r.public_template.context.depth_bucket = 40),
    (r: any) => (r.public_training_provenance.machine_id = 'M2'),
    (r: any) => (r.public_training_provenance.manifest_checksum = 'b'.repeat(64)),
    (r: any) => (r.hand_matrix = {}),
    (r: any) => (r.public_model.action_ids = ['c', 'missing']),
  ]) {
    const r = fixture();
    change(r);
    if (r.model_checksum === good.model_checksum) bind(r);
    expect(() => replaceGtoPostflopV31([r])).toThrow();
    expect(gtoPostflopV31Count()).toBe(1);
    expect(gtoPostflopV31Dataset()?.checksum).toBe(good.dataset_checksum);
  }
});
it('permits different per-context source lists while enforcing shared global training authority', () => {
  const a = fixture(),
    b = fixture(40);
  a.dataset_cells = b.dataset_cells = 2;
  b.public_training_provenance.sources[0].source_node = 'r:0:c';
  b.public_training_provenance.sources[0].board = 'Qh9d7c3h';
  bind(b);
  expect(replaceGtoPostflopV31([a, b])).toBe(2);
  for (const change of [
    (r: any) => {
      r.public_training_provenance.whole_variant = 'coherent';
      r.public_model.variant = 'coherent';
    },
    (r: any) => (r.public_training_provenance.training_recipe_checksum = 'b'.repeat(64)),
    (r: any) => (r.public_training_provenance.runtime_parity_protocol_checksum = 'b'.repeat(64)),
  ]) {
    const bad = structuredClone(b);
    change(bad);
    bind(bad);
    expect(() => replaceGtoPostflopV31([a, bad])).toThrow();
    expect(gtoPostflopV31Count()).toBe(2);
  }
});
it('requires a bound post-model receipt and refuses false raw heads, runtime and cost claims', () => {
  const good = fixture();
  replaceGtoPostflopV31([good]);
  for (const mutate of [
    (r: any) => (r.model_build_receipt_checksum = 'b'.repeat(64)),
    (r: any) => (r.public_model_build_receipt.runtime.platform = 'darwin'),
    (r: any) => (r.public_model_build_receipt.cases[0].raw_heads_f64[4] = hex(0.5)),
    (r: any) => (r.public_model_build_receipt.cases[0].inference_ms_f64 = hex(8001)),
    (r: any) => (r.public_model_build_receipt.cost.max_inference_ms_f64 = hex(2)),
    (r: any) =>
      (r.public_model_build_receipt.cases[1] = structuredClone(
        r.public_model_build_receipt.cases[0]
      )),
  ]) {
    const r = fixture();
    mutate(r);
    if (r.model_build_receipt_checksum === good.model_build_receipt_checksum)
      r.model_build_receipt_checksum = public215Digest(r.public_model_build_receipt);
    expect(() => replaceGtoPostflopV31([r])).toThrow();
    expect(gtoPostflopV31Dataset()?.checksum).toBe(good.dataset_checksum);
  }
});

it('serves the synthetic model through one actual worker/native query with the complete model source seal', async () => {
  type Outcome = {
    exitCode: number;
    workerExitCode: number;
    acknowledged: boolean;
    error: string | null;
  };
  const helper: { runFiniteEvaluationWorker: (entry: URL, argv: string[]) => Promise<Outcome> } =
    await import(
      /* @vite-ignore */ new URL('../../scripts/finite-evaluation-worker.mjs', import.meta.url).href
    );
  const result = await helper.runFiniteEvaluationWorker(
    new URL('../../scripts/fixtures/public215-serving-smoke.ts', import.meta.url),
    [JSON.stringify({ row: fixture(), input })]
  );
  expect(result).toEqual({ exitCode: 0, workerExitCode: 0, acknowledged: true, error: null });
});
