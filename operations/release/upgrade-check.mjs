#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, connect } from './journal.mjs';
import { rootOwnedFile } from './installed-bundle.mjs';
import { controllerDatabase, verifyControllerPrincipal } from './controller-owner.mjs';

// Run by the already installed native oneshot BEFORE stopping its predecessor.
// Only read-only inspection; it cannot mark the upgrade/release successful.
export function validateUpgrade(snapshot, intent) {
  const operation = snapshot.external.find((e) => e.id === intent.operation_id);
  const queue = snapshot.queue.find((q) => q.release_id === intent.release_id);
  if (
    snapshot.controller.instance_id !== intent.instance_id ||
    snapshot.controller.active_release !== intent.release_id ||
    !operation ||
    !['INTENT', 'UNKNOWN'].includes(operation.status) ||
    !isDeepStrictEqual(operation.intent.native_upgrade, intent.native_upgrade) ||
    operation.intent.manifest_digest !== queue?.resolution_manifest_digest ||
    !queue?.resolution_manifest?.components.some(
      (component) =>
        component.target === operation.intent.target &&
        isDeepStrictEqual(component.controller_upgrade, intent.native_upgrade)
    )
  ) {
    throw new Error('RELEASE_UPGRADE_INTENT_NOT_PENDING');
  }
  return {
    pending: true,
    operation_id: operation.id,
    instance_id: snapshot.controller.instance_id,
  };
}
async function main() {
  let client;
  try {
    const config = JSON.parse(
      await rootOwnedFile('/etc/club-arena-release-controller/controller.json')
    );
    const database = await controllerDatabase(config);
    client = await connect(database);
    await verifyControllerPrincipal(client, database.ownerPrincipal);
    const bootstrap = process.argv[2] === '--bootstrap';
    const intent = bootstrap ? null : JSON.parse(await readFile(process.argv[2], 'utf8'));
    const snapshot = await call(client, 'inspect', [intent?.release_id ?? null]);
    if (bootstrap) {
      if (snapshot.controller.execution_enabled || snapshot.controller.active_release !== null)
        throw new Error('RELEASE_BOOTSTRAP_NOT_IDLE');
      console.log(
        JSON.stringify({
          bootstrap_observe_only: true,
          instance_id: snapshot.controller.instance_id,
          epoch: snapshot.controller.epoch,
        })
      );
    } else {
      console.log(JSON.stringify(validateUpgrade(snapshot, intent)));
    }
  } catch {
    console.error('RELEASE_UPGRADE_JOURNAL_PROOF_FAILED');
    process.exitCode = 1;
  } finally {
    await client?.end().catch(() => {});
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
