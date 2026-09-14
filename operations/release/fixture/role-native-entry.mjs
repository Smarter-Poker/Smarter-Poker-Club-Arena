import assert from 'node:assert/strict';
import { qualifyRoleNativeFaults } from './role-native-faults.mjs';
import { qualifyRoleNativeAccess } from './role-native-access.mjs';

// The fixture owns held-client retirement/reconnection. This source adds no
// hook to the production installer and never changes its immutable template.
export const roleNativePostgresArguments = Object.freeze(['-c', 'max_prepared_transactions=1']);
export async function runRoleNativeFaultPhase({ Client, password, signal, deadlineMs }) {
  return qualifyRoleNativeFaults({ Client, password, signal, deadlineMs });
}
export async function runRoleNativeAccessPhase({ Client, password, signal, applicationClient, roleProof, deadlineMs }) {
  assert.equal(roleProof?.scope, 'native-full-role-installer');
  assert.equal(roleProof.status, 'passed');
  assert.equal(roleProof.catalog_outcome, 'committed');
  assert.equal(roleProof.graph_assertion, true);
  assert.equal(roleProof.membership_assertion, true);
  assert.equal(roleProof.all_driver_clients_closed, true);
  return qualifyRoleNativeAccess({ Client, password, signal, applicationPid: applicationClient.processID, deadlineMs });
}
