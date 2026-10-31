import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runFiniteEvaluationWorker} from './finite-evaluation-worker.mjs';
const fixture=new URL('./fixtures/finite-evaluation-worker-smoke.ts',import.meta.url);
test('entire TypeScript CLI executes in worker and terminates with an acknowledgment',async()=>{const r=await runFiniteEvaluationWorker(fixture);assert.equal(r.exitCode,0);assert.equal(r.acknowledged,true);assert.equal(r.error,null);});
test('preserves nonzero CLI status',async()=>{const r=await runFiniteEvaluationWorker(fixture,['--exit-seven']);assert.equal(r.exitCode,7);assert.equal(r.workerExitCode,7);});
test('propagates uncaught TypeScript failure',async()=>{const r=await runFiniteEvaluationWorker(fixture,['--throw']);assert.equal(r.exitCode,1);assert.match(r.error,/SYNTHETIC_WORKER_FAILURE/);});
test('refuses zero exit without terminal acknowledgment',async()=>{const r=await runFiniteEvaluationWorker(fixture,['--exit-without-ack']);assert.equal(r.exitCode,1);assert.equal(r.error,'MISSING_WORKER_TERMINAL_ACK');});
