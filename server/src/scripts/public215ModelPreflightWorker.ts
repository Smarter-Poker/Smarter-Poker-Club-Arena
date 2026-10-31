import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runPublic215Preflight } from './public215ModelPreflight.js';
if (isMainThread || !parentPort) throw Error('PUBLIC215_PREFLIGHT_WORKER_REQUIRED');
parentPort.postMessage(runPublic215Preflight(workerData));
