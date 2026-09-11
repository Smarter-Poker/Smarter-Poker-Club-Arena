import { trace, errors } from './recovery-native-transport.mjs';
import { recoverStuckCompletingTournaments } from '../../../server/dist/tournament/tournamentRecovery.js';
import {
  prepareSatelliteQualification,
  requestSatelliteQualificationReceipt,
} from '../../../server/dist/tournament/satelliteSettlementRpc.js';
const source = 'e1000000-0000-4000-8000-000000000001';
const cohort = [
  '10000000-0000-0000-0000-000000000001',
  'e1000000-0000-4000-8000-000000000004',
  'e1000000-0000-4000-8000-000000000005',
];
const mode = process.argv[2];
globalThis.fetch = () => {
  throw new Error('External network forbidden in native recovery proof');
};
let receipt = null;
if (mode === 'prepare-and-crash') {
  await prepareSatelliteQualification(source, cohort, 'e1000000-0000-4000-8000-000000000051');
  console.log(JSON.stringify({ prepared: true, pid: process.pid, trace, errors }));
  setInterval(() => {}, 1000);
} else {
  if (mode === 'recover') await recoverStuckCompletingTournaments('native process restart', source);
  else if (mode === 'replay') receipt = await requestSatelliteQualificationReceipt(source, cohort);
  else throw new Error('Unexpected proof mode');
  console.log(JSON.stringify({ mode, pid: process.pid, receipt, trace, errors }));
  if (errors.length) process.exitCode = 1;
}
