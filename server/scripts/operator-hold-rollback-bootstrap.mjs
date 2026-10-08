/** Exact predecessor compatibility preload, selected only by the owning run-spec.
 * It restores each table's latest native hold before original start and refuses
 * legacy operator commands until a qualified current runtime replaces it.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { installRollbackBootFence } from './operator-hold-checkpoint-guard.mjs';
const root = '/run/club-arena/operator-hold';
const profile = JSON.parse(readFileSync(`${root}/operator-hold-predecessor-profile.json`, 'utf8'));
const handoff = JSON.parse(readFileSync(`${root}/handoff.json`, 'utf8'));
const release = '4dbbd0672dd46d86116140cde77da1bd143c6b8f';
const paths = [
  '/app/dist/GameServer.js',
  '/app/dist/engine/ServerTableEngineBase.js',
  '/app/dist/engine/ServerTableEngineSeating.js',
  '/app/dist/engine/ServerTableEngineDealing.js',
  '/app/dist/handlers/admin.js',
  '/app/dist/tournament/TournamentManagerBase.js',
  '/app/dist/services/tableLease.js',
  '/app/dist/services/supabase/client.js',
  '/app/dist/releaseIdentity.js',
  '/app/dist/http/createEngineHttpServer.js',
  '/app/dist/engine/ServerTableEngine.js',
  '/app/dist/maintenance/MaintenanceBreak.js',
  '/app/dist/maintenance/freezeState.js',
  '/app/dist/services/supabase/dataActorContext.js',
];
const demand = (ok, code) => {
  if (!ok) throw new Error(`operator_hold_bootstrap:${code}`);
};
demand(
  profile.kind === 'operator_hold_predecessor_v1' &&
    profile.releaseSha === release &&
    process.version === profile.runtimeNode &&
    process.pid === 1 &&
    process.env.GIT_COMMIT_SHA === release &&
    !/--(?:inspect|debug)/.test(process.env.NODE_OPTIONS ?? ''),
  'runtime_identity'
);
demand(
  handoff.kind === 'operator_hold_handoff_v1' &&
    handoff.sourceRelease === release &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handoff.handoffId),
  'handoff_identity'
);
demand(
  Array.isArray(profile.compiled) &&
    profile.compiled.length === paths.length &&
    profile.compiled.every(
      (row, i) =>
        row.path === paths[i] &&
        /^[0-9a-f]{64}$/.test(row.sha256) &&
        createHash('sha256').update(readFileSync(row.path)).digest('hex') === row.sha256
    ),
  'compiled_identity'
);
// These class imports do not construct a server. Install the start/listen fences
// before the original index creates the server or admits its first table.
const [gameServer, base, seating, dealing, managerBase, releaseIdentity, tableLease, client, http] =
  await Promise.all([
    import('file:///app/dist/GameServer.js'),
    import('file:///app/dist/engine/ServerTableEngineBase.js'),
    import('file:///app/dist/engine/ServerTableEngineSeating.js'),
    import('file:///app/dist/engine/ServerTableEngineDealing.js'),
    import('file:///app/dist/tournament/TournamentManagerBase.js'),
    import('file:///app/dist/releaseIdentity.js'),
    import('file:///app/dist/services/tableLease.js'),
    import('file:///app/dist/services/supabase/client.js'),
    import('node:http'),
  ]);
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]])
        )
      : item
  );
const receipt = await client.supabase.rpc('fn_ca_get_operator_hold_handoff', {
  p_handoff_id: handoff.handoffId,
});
demand(
  !receipt.error &&
    receipt.data &&
    receipt.data.handoff_id === handoff.handoffId &&
    receipt.data.source_instance === handoff.sourceInstance &&
    receipt.data.source_release_sha === release &&
    Array.isArray(receipt.data.fleet) &&
    receipt.data.fleet.length <= 2000 &&
    receipt.data.fleet.every(
      (row) =>
        row &&
        typeof row.paused === 'boolean' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.table_id) &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.lease_generation)
    ) &&
    (handoff.fleet === null || canonical(receipt.data.fleet) === canonical(handoff.fleet)),
  'original_import_unconfirmed'
);
const result = await installRollbackBootFence(
  {
    handoffId: handoff.handoffId,
    expectedReleaseSha: release,
    expectedInstanceId: tableLease.INSTANCE_ID,
    expectedPid: process.pid,
  },
  { gameServer, base, seating, dealing, managerBase, releaseIdentity, tableLease, client, http }
);
demand(result.ok === true && result.phase === 'boot_fence_installed', 'installation_unknown');
console.log(
  '[operator-hold-bootstrap] latest native holds precede table starts; legacy operator routes temporarily unavailable'
);
