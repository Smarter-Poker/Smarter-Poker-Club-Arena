import { isMainThread } from 'node:worker_threads';
if (isMainThread) throw Error('SMOKE_DID_NOT_ENTER_WORKER');
if (process.argv.includes('--throw')) throw Error('SYNTHETIC_WORKER_FAILURE');
if (process.argv.includes('--exit-seven')) process.exitCode = 7;
if (process.argv.includes('--exit-without-ack')) process.exit(0);
