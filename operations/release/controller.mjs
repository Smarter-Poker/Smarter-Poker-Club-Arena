#!/usr/bin/env node
import { readFile, open, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { call, connect, configuration, sanitizedError } from './journal.mjs';
import { ProviderRunner, providerCall } from './provider-journal.mjs';
import { admissionServer } from './event-admission.mjs';
import { EngineStageAdapter, artifactDownload, stageTransport } from './adapters/engine-stage.mjs';
import { EngineReadiness, liveCatalogue } from './engine-readiness.mjs';
import { MaintenanceCoordinator } from './maintenance-coordinator.mjs';
import { verifierClient } from './maintenance-verifier.mjs';
import { rootOwnedFile } from './installed-bundle.mjs';
import { SourceCoordinator } from './source-coordinator.mjs';
import { GitHubCertificationAdapter } from './adapters/github-certification.mjs';
import { GitHubMergeAdapter, GitHubWorkflowAdapter, githubTransport } from './adapters/github.mjs';
import { installedConfiguration } from './installed-bundle.mjs';
import { VercelPromoteAdapter, vercelTransport } from './adapters/vercel.mjs';
import { HetznerIntakeAdapter, engineTransport } from './adapters/hetzner.mjs';

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
    await client.query('LISTEN release_journal_events');
    await afterListen?.(client);
    const owner = await call(client, 'acquire_owner', [
      randomUUID(),
      'release-provider-controller',
    ]);
    const runner = new ProviderRunner({ client, owner, installation, adapters });
    const coordinator = new SourceCoordinator({ runner, github, readiness,
      maintenance: maintenance ? new MaintenanceCoordinator({runner,...maintenance}) : undefined });
    bindPublicationReader?.(async (id) => {
      const snapshot = await coordinator.snapshot();
      const result = snapshot.publication_results.find((p) => p.id === id && p.status === 'SUCCEEDED');
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
  const adapters = {};
  let githubRequest, downloadArtifact, readiness, activePublicationReader;
  if (mode !== 'OBSERVE') {
    if (config.vercel) {
      const name = config.vercel.credential_name;
      if (!/^[a-z][a-z0-9_-]{0,50}$/.test(name) || !process.env.CREDENTIALS_DIRECTORY)
        throw new Error('RELEASE_INSTALLED_CREDENTIAL_REQUIRED');
      const token = (
        await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, name), 'utf8')
      ).trim();
      adapters['vercel-promote'] = new VercelPromoteAdapter({
        ...config.vercel,
        request: vercelTransport(token),
      });
    }
    if (config.github) {
      const name = config.github.credential_name;
      if (!/^[a-z][a-z0-9_-]{0,50}$/.test(name) || !process.env.CREDENTIALS_DIRECTORY)
        throw new Error('RELEASE_INSTALLED_CREDENTIAL_REQUIRED');
      const token = (
        await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, name), 'utf8')
      ).trim();
      const request = githubTransport(token);
      githubRequest = request;
      downloadArtifact = artifactDownload(token, config.github.repo);
      adapters['github-merge'] = new GitHubMergeAdapter({ ...config.github, request });
      adapters['github-workflow'] = new GitHubWorkflowAdapter({ ...config.github, request });
    }
    if (config.engine)
      adapters['hetzner-intake'] = new HetznerIntakeAdapter({
        ...config.engine,
        request: engineTransport(config.engine.host_alias, undefined, config.engine.protocol ?? 1),
      });
  }
  if (mode !== 'OBSERVE' && config.engine_staging) {
    if (!config.engine || !githubRequest) throw new Error('RELEASE_STAGE_INSTALLATION_REQUIRED');
    adapters['engine-stage'] = new EngineStageAdapter({ controlSha: config.engine.controlSha,
      repo: config.github.repo, github: githubRequest,
      request: stageTransport(config.engine.host_alias, downloadArtifact) });
  }
  if (mode !== 'OBSERVE' && config.maintenance && config.engine?.protocol !== 2)
    throw new Error('RELEASE_ON_DEMAND_HOST_SUCCESSOR_REQUIRED');
  if (mode !== 'OBSERVE' && config.readiness) {
    const r = config.readiness;
    if (!/^[a-z][a-z0-9_-]{0,50}$/.test(r.database_credential_name) || !process.env.CREDENTIALS_DIRECTORY || !adapters['hetzner-intake'])
      throw new Error('RELEASE_READINESS_IDENTITY_REQUIRED');
    const connectionString = (await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, r.database_credential_name), 'utf8')).trim();
    const ca = await rootOwnedFile(r.database_ca_path);
    readiness = new EngineReadiness({ intake: adapters['hetzner-intake'],
      catalogue: liveCatalogue({ connectionString, ssl: { ca, rejectUnauthorized: true } }, r.database_principal) });
  }
  if (mode !== 'OBSERVE' && config.github?.certificationWorkflowId) {
    if (!adapters['hetzner-intake']) throw new Error('RELEASE_CERTIFICATION_INSTALLATION_REQUIRED');
    adapters['github-certification'] = new GitHubCertificationAdapter({ ...config.github,
      workflowId: config.github.certificationWorkflowId, request: githubRequest,
      publicationReadback: async (r) => {
        // Readback uses the original immutable publication, not a caller-made
        // reconstruction of host authority or a newly generated operation ID.
        if (!activePublicationReader) throw new Error('RELEASE_CERTIFICATION_PUBLICATION_REQUIRED');
        const operation = await activePublicationReader(r.publication_operation_id);
        return adapters['hetzner-intake'].reconcile(operation.intent.provider_request, operation);
      } });
  }
  let closeAdmission;
  if (config.admission && mode !== 'OBSERVE') {
    const credential = config.admission.credential_name;
    const databaseCredential = config.admission.database_credential_name;
    if (
      ![credential, databaseCredential].every((n) => /^[a-z][a-z0-9_-]{0,50}$/.test(n)) ||
      !process.env.CREDENTIALS_DIRECTORY
    )
      throw new Error('RELEASE_INSTALLED_CREDENTIAL_REQUIRED');
    closeAdmission = await admissionServer({
      secret: await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, credential)),
      repositories: config.admission.repositories,
      database: {
        connectionString: (
          await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, databaseCredential), 'utf8')
        ).trim(),
      },
    });
  }
  const abort = new AbortController();
  process.once('SIGTERM', () => abort.abort());
  process.once('SIGINT', () => abort.abort());
  // Existing CLI remains OBSERVE-only. Mode capability lives exclusively in
  // this installed, native-lock guarded process and the database submit gate.
  const dbConfig = configuration({ ...process.env, RELEASE_JOURNAL_MODE: 'OBSERVE' });
  try {
    await controllerSession(dbConfig, {
      mode,
      installation,
      adapters,
      github: config.github,
      readiness,
      maintenance: config.maintenance && mode !== 'OBSERVE' ? {
        verify: verifierClient(config.maintenance.verifier_socket),
        estimatedMilliseconds: config.maintenance.estimated_cutover_ms,
      } : undefined,
      bindPublicationReader: (reader) => { activePublicationReader = reader; },
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
