import { describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isolateMemoryIsValid, sampleIsolateMemory } from './isolateMemory.js';

describe('worker-isolate diagnostic scalars', () => {
  it('samples the real worker isolate without confusing main-process RSS', async () => {
    expect(sampleIsolateMemory(0)).toBeNull();
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/esm/api/index.mjs')).href;
    const source = resolve('src/observability/isolateMemory.ts');
    const worker = new Worker(
      `(async () => {
      const { tsImport } = await import(${JSON.stringify(loader)});
      const { sampleIsolateMemory } = await tsImport(${JSON.stringify(source)}, ${JSON.stringify(import.meta.url)});
      require('node:worker_threads').parentPort.postMessage(sampleIsolateMemory(3));
    })()`,
      { eval: true }
    );
    try {
      const sample = await new Promise<any>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      });
      expect(isolateMemoryIsValid(sample, 3)).toBe(true);
      expect(sample.threadId).toBe(worker.threadId);
      expect(sample.heapUsedBytes).toBeGreaterThan(0);
      expect(Object.keys(sample)).toHaveLength(7);
      for (const bad of [
        null,
        { ...sample, shardIndex: 4 },
        { ...sample, heapUsedBytes: NaN },
        { ...sample, threadId: 0 },
        { ...sample, privatePayload: 'forbidden' },
      ])
        expect(isolateMemoryIsValid(bad, 3)).toBe(false);
    } finally {
      await worker.terminate();
    }
  });
});
