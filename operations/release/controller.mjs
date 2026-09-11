#!/usr/bin/env node
import { open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { call, connect, sanitizedError } from './journal.mjs';
import { controllerDatabase, verifyControllerPrincipal } from './controller-owner.mjs';
import { ProviderRunner, providerCall } from './provider-journal.mjs';
import { admissionServer } from './event-admission.mjs';
import { MaintenanceCoordinator } from './maintenance-coordinator.mjs';
import { verifierClient } from './maintenance-verifier.mjs';
import { SourceCoordinator } from './source-coordinator.mjs';
import { installedConfiguration } from './installed-bundle.mjs';
import { controllerRuntime, installedCredential } from './controller-runtime.mjs';

async function startupReceipt(filename, value) {
  const temporary = `${filename}.${process.pid}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, filename);
  const directory = await open(path.dirname(filename), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function controllerSession(
  dbConfig,
  {
    mode = 'OBSERVE',
    installation,
    adapters = {},
    github,
    readiness,
    staticReadiness,
    mixedReadiness,
    maintenance,
    signal,
    emit = console.log,
    ready,
    afterListen,
    bindPublicationReader,
  } = {}
) {
  const client = await connect(dbConfig);
  let stopped = signal?.aborted ?? false;
  let wake;
  let dirty = false;
  let connectionError;
  let timer;
  const notify = () => {
    dirty = true;
    wake?.();
  };
  const abort = () => {
    stopped = true;
    notify();
  };
  client.on('notification', notify);
  client.on('error', (error) => {
    connectionError = error;
    notify();
  });
  client.on('end', () => {
    if (!stopped) {
      connectionError = new Error('RELEASE_CONNECTION_LOST');
      notify();
    }
  });
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (dbConfig.ownerPrincipal) await verifyControllerPrincipal(client, dbConfig.ownerPrincipal);
    await client.query('LISTEN release_journal_events');
    await afterListen?.(client);
    const owner = await call(client, 'acquire_owner', [
      randomUUID(),
      'release-provider-controller',
    ]);
    const runner = new ProviderRunner({ client, owner, installation, adapters });
    const coordinator = new SourceCoordinator({
      runner,
      github,
      readiness,
      staticReadiness,
      mixedReadiness,
      maintenance: maintenance ? new MaintenanceCoordinator({ runner, ...maintenance }) : undefined,
    });
    bindPublicationReader?.(async (id) => {
      const snapshot = await coordinator.snapshot();
      const result = snapshot.publication_results.find(
        (p) => p.id === id && p.status === 'SUCCEEDED'
      );
      if (!result) throw new Error('RELEASE_CERTIFICATION_PUBLICATION_REQUIRED');
      return result;
    });
    if (mode !== 'OBSERVE')
      await providerCall(client, 'provider_installation', [
        ...runner.args(),
        ...runner.installArgs(),
        false,
      ]);
    await ready?.({
      pid: process.pid,
      owner_id: owner.owner_id,
      epoch: owner.epoch,
      instance_id: owner.instance_id,
      bundle_digest: installation.bundle_digest,
      reconciliation_required: true,
      mode,
    });
    let signature;
    while (!stopped) {
      if (connectionError) throw connectionError;
      dirty = false;
      const result = await coordinator.tick({ mode });
      const snapshot = await runner.snapshot();
      const next =
        snapshot.observation?.next_check_at ??
        result.next_retry_at ??
        (await coordinator.snapshot()).queue?.next_retry_at;
      const summary = {
        mode,
        epoch: owner.epoch,
        event_no: snapshot.controller.last_event,
        active_release: snapshot.controller.active_release,
        external_id: snapshot.external?.id ?? null,
        state: result.state ?? result.status,
        reconciliation_required: snapshot.controller.reconciliation_required,
        mergeBuildOrchestrationAvailable: Boolean(github),
        stagingAndCertificationRequireInstalledProof: true,
      };
      const current = JSON.stringify(summary);
      if (current !== signature) {
        emit(summary);
        signature = current;
      }
      clearTimeout(timer);
      if (mode !== 'OBSERVE' && Date.parse(next) > Date.now())
        timer = setTimeout(notify, Date.parse(next) - Date.now() + 1);
      if (!dirty && !stopped && !connectionError)
        await new Promise((resolve) => {
          wake = resolve;
        });
      wake = undefined;
    }
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await client.end().catch(() => {});
  }
}

async function main() {
  if (process.argv.length !== 3) throw new Error('RELEASE_INSTALLED_CONFIGURATION_REQUIRED');
  const { config, installation } = await installedConfiguration(process.argv[2]);
  const mode = config.mode ?? 'OBSERVE';
  const dbConfig = await controllerDatabase(config);
  const runtime = await controllerRuntime(config);
  let closeAdmission;
  if (config.admission && mode !== 'OBSERVE') {
    closeAdmission = await admissionServer({
      secret: await installedCredential(config.admission.credential_name),
      repositories: config.admission.repositories,
      certificateCallback: runtime.certificateCallback,
      staticPublicationCallback: runtime.staticPublicationCallback,
      database: runtime.admissionDatabase,
      principal: runtime.admissionPrincipal,
    });
  }
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  // Existing CLI remains OBSERVE-only. Mode capability lives exclusively in
  // this installed, native-lock guarded process and the database submit gate.
  try {
    await controllerSession(dbConfig, {
      mode,
      installation,
      ...runtime,
      maintenance:
        config.maintenance && mode !== 'OBSERVE'
          ? {
              verify: verifierClient(config.maintenance.verifier_socket),
              estimatedMilliseconds: config.maintenance.estimated_cutover_ms,
            }
          : undefined,
      signal: abort.signal,
      emit: (value) => process.stdout.write(`${JSON.stringify(value)}\n`),
      ready: (value) =>
        startupReceipt('/var/lib/club-arena-release-controller/startup.json', value),
    });
  } finally {
    await closeAdmission?.();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify(sanitizedError(error))}\n`);
    process.exitCode = 1;
  });
}
