import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { rootOwnedFile } from './installed-bundle.mjs';
import { GitHubMergeAdapter, GitHubWorkflowAdapter, githubTransport } from './adapters/github.mjs';
import { GitHubCertificationAdapter } from './adapters/github-certification.mjs';
import { GitHubFrontendQualificationAdapter } from './adapters/github-frontend.mjs';
import { GitHubStaticAdapter } from './adapters/github-static.mjs';
import { AggregateQualificationAdapter } from './aggregate-qualification.mjs';
import { EngineStageAdapter, artifactDownload, stageTransport } from './adapters/engine-stage.mjs';
import { HetznerIntakeAdapter, engineTransport } from './adapters/hetzner.mjs';
import { VercelPromoteAdapter, vercelTransport } from './adapters/vercel.mjs';
import { EngineReadiness, liveCatalogue } from './engine-readiness.mjs';
import { StaticReadiness } from './static-readiness.mjs';
import { componentReadback } from './component-readback.mjs';
import {
  nativeFrontendReader,
  privateComponentDatabase,
  journalEngineReader,
} from './component-native-readers.mjs';
import {
  CertificateCallback,
  GitHubCertificateIdentity,
  GitHubStaticIdentity,
  certificationCall,
} from './certification-callback.mjs';
import { StaticPublicationCallback } from './static-publication-callback.mjs';
import { proveExistingArtifact, requirePriorPublication } from './frontend-artifact-proof.mjs';
import { requireCertificate as need, sameFacts, uuid } from './component-certificate.mjs';

export async function installedCredential(name) {
  need(
    /^[a-z][a-z0-9_-]{0,50}$/.test(name) && process.env.CREDENTIALS_DIRECTORY,
    'RELEASE_INSTALLED_CREDENTIAL_REQUIRED'
  );
  const value = await readFile(path.join(process.env.CREDENTIALS_DIRECTORY, name));
  need(value.length > 0 && value.length <= 65536, 'RELEASE_INSTALLED_CREDENTIAL_REQUIRED');
  return value;
}

function ingressBinding(github, component, purpose) {
  const authority = purpose === 'static' ? github.staticAuthority : github.fixtureAuthority;
  const suffix = purpose === 'static' ? 'static-publication' : 'certification';
  need(
    uuid.test(authority?.installation_receipt) &&
      authority.audience ===
        (purpose === 'static'
          ? 'club-arena-static-publication'
          : 'club-arena-release-certification') &&
      new RegExp(`^https://[a-z0-9.-]+/${suffix}$`).test(authority.url),
    'RELEASE_COMPONENT_INGRESS_INSTALLATION_REQUIRED'
  );
  return {
    repository: github.repo,
    repository_id: String(github.repositoryId),
    workflow_id: String(
      purpose === 'static' ? github.staticWorkflowId : github.certificationWorkflowId
    ),
    workflow_path:
      purpose === 'static'
        ? '.github/workflows/publish-club-arena.yml'
        : '.github/workflows/post-deploy-e2e.yml',
    control_sha: github.controlSha,
    control_ref: purpose === 'static' ? 'refs/heads/main' : `refs/${github.controlRef}`,
    audience: authority.audience,
    url: authority.url,
    principal: component.database_principal,
  };
}

// This is the entrypoint's concrete dependency graph. It performs no provider
// submission, opens no listener and never changes the persisted activation mode.
// Test overrides replace transports and file readers, not authorization logic.
export async function controllerRuntime(
  config,
  {
    credential = installedCredential,
    installedFile = rootOwnedFile,
    githubFetch,
    frontendInvoke,
    openDatabase,
  } = {}
) {
  const mode = config.mode ?? 'OBSERVE';
  need(['OBSERVE', 'RECONCILE', 'EXECUTE'].includes(mode), 'RELEASE_PROVIDER_MODE_INVALID');
  const runtime = { adapters: {}, github: config.github };
  if (mode === 'OBSERVE') return runtime;
  const adapters = runtime.adapters;
  let githubRequest, downloadArtifact, publicationReader;
  runtime.bindPublicationReader = (reader) => {
    publicationReader = reader;
  };
  if (config.vercel) {
    const token = (await credential(config.vercel.credential_name)).toString().trim();
    adapters['vercel-promote'] = new VercelPromoteAdapter({
      ...config.vercel,
      request: vercelTransport(token),
    });
  }
  if (config.github) {
    const token = (await credential(config.github.credential_name)).toString().trim();
    githubRequest = githubTransport(token, githubFetch);
    downloadArtifact = artifactDownload(token, config.github.repo, githubFetch);
    adapters['github-merge'] = new GitHubMergeAdapter({ ...config.github, request: githubRequest });
    adapters['github-workflow'] = new GitHubWorkflowAdapter({
      ...config.github,
      request: githubRequest,
    });
  }
  if (config.engine)
    adapters['hetzner-intake'] = new HetznerIntakeAdapter({
      ...config.engine,
      request: engineTransport(config.engine.host_alias, undefined, config.engine.protocol ?? 1),
    });
  if (config.engine_staging) {
    need(config.engine && githubRequest, 'RELEASE_STAGE_INSTALLATION_REQUIRED');
    adapters['engine-stage'] = new EngineStageAdapter({
      controlSha: config.engine.controlSha,
      repo: config.github.repo,
      github: githubRequest,
      request: stageTransport(config.engine.host_alias, downloadArtifact),
    });
  }
  if (config.maintenance)
    need(config.engine?.protocol === 2, 'RELEASE_ON_DEMAND_HOST_SUCCESSOR_REQUIRED');
  if (config.readiness) {
    const r = config.readiness;
    need(adapters['hetzner-intake'], 'RELEASE_READINESS_IDENTITY_REQUIRED');
    const connectionString = (await credential(r.database_credential_name)).toString().trim();
    const ca = await installedFile(r.database_ca_path);
    runtime.readiness = new EngineReadiness({
      intake: adapters['hetzner-intake'],
      catalogue: liveCatalogue(
        { connectionString, ssl: { ca, rejectUnauthorized: true } },
        r.database_principal
      ),
    });
  }
  let readback;
  if (config.github?.certificationVersion === 2) {
    const c = config.components;
    need(
      c &&
        githubRequest &&
        adapters['hetzner-intake'] &&
        config.admission &&
        Number.isSafeInteger(config.github.certificationWorkflowId),
      'RELEASE_COMPONENT_INSTALLATION_REQUIRED'
    );
    const connectionString = (await credential(c.database_credential_name)).toString().trim();
    const ca = await installedFile(c.database_ca_path);
    const database = privateComponentDatabase(
      { connectionString, ssl: { ca, rejectUnauthorized: true } },
      c.database_principal,
      openDatabase
    );
    const readNativeFrontend = nativeFrontendReader({
      hostAlias: c.static_host_alias,
      invoke: frontendInvoke,
    });
    const readNativeEngine = journalEngineReader({ database, intake: adapters['hetzner-intake'] });
    readback = componentReadback({ readNativeFrontend, readNativeEngine, github: githubRequest });
    const retainedEvidence = async (release, target, source, identity) => {
      const client = await database();
      try {
        return await certificationCall(client, 'component_retained_evidence', [
          release,
          target,
          source,
          identity,
        ]);
      } finally {
        await client.end();
      }
    };
    const readFrontend = () =>
      proveExistingArtifact({
        readNative: readNativeFrontend,
        priorPublication: async (proof) =>
          requirePriorPublication(
            await githubRequest(
              `/repos/${config.github.repo}/actions/runs/${proof.build_info.run_id}`
            ),
            await githubRequest(
              `/repos/${config.github.repo}/actions/runs/${proof.build_info.run_id}/jobs?filter=latest&per_page=100`
            ),
            proof
          ),
      });
    runtime.retainedFrontendEvidence = async (snapshot) => {
      const proof = await readFrontend();
      return retainedEvidence(
        snapshot.queue.release_id,
        'club-arena-web',
        proof.native.source_sha,
        `sha256:${proof.native.manifest_sha256}`
      );
    };
    if (runtime.readiness)
      runtime.readiness.retainedFrontendEvidence = runtime.retainedFrontendEvidence;
    runtime.certificateCallback = new CertificateCallback({
      identity: new GitHubCertificateIdentity({
        binding: ingressBinding(config.github, c, 'certificate'),
      }),
      database,
      github: githubRequest,
      componentReadback: readback,
    });
    if (config.github.staticWorkflowId || config.github.frontendWorkflowId) {
      need(
        Number.isSafeInteger(config.github.staticWorkflowId) &&
          Number.isSafeInteger(config.github.frontendWorkflowId),
        'RELEASE_FRONTEND_INSTALLATION_REQUIRED'
      );
      const installedControlReceipt = JSON.parse(
        await installedFile(c.static_control_receipt_path)
      );
      adapters['github-static'] = new GitHubStaticAdapter({
        ...config.github,
        workflowId: config.github.staticWorkflowId,
        request: githubRequest,
        readNative: readNativeFrontend,
        installedControlReceipt,
      });
      adapters['github-frontend'] = new GitHubFrontendQualificationAdapter({
        ...config.github,
        workflowId: config.github.frontendWorkflowId,
        runtimeImage: config.github.frontendRuntimeImage,
        request: githubRequest,
      });
      adapters['component-aggregate'] = new AggregateQualificationAdapter({ adapters });
      runtime.staticPublicationCallback = new StaticPublicationCallback({
        identity: new GitHubStaticIdentity({ binding: ingressBinding(config.github, c, 'static') }),
        database,
        github: githubRequest,
      });
      if (c.compatibility) {
        const { GitHubComponentCompatibility } = await import('./component-compatibility.mjs');
        const { ComponentCompatibilityReadiness, MixedReadiness } =
          await import('./mixed-readiness.mjs');
        const qualifier = new GitHubComponentCompatibility({
          repositoryId: config.github.repositoryId,
          workflowId: config.github.componentQualificationWorkflowId,
          workflowPath: '.github/workflows/release-component-qualification.yml',
          controlSha: config.github.controlSha,
          controlRef: config.github.controlRef,
          runtimeImage: config.github.componentRuntimeImage,
          request: githubRequest,
        });
        adapters['github-compatibility'] = qualifier;
        const readBefore = async (snapshot) => {
          const before = c.compatibility.contract?.before_components;
          need(
            before && before['club-arena-engine'] && before['club-arena-web'],
            'RELEASE_COMPONENT_PREHISTORY_REQUIRED'
          );
          const e = before['club-arena-engine'];
          let engine;
          if (
            snapshot.queue.resolution_manifest.components.some(
              (part) => part.target === 'club-arena-engine'
            )
          ) {
            // Mixed releases already have an immutable, completed native stage
            // operation. Read its current host directly; do not manufacture a
            // historical VERIFIED certificate just to bootstrap readback.
            const stagePlan = snapshot.stage_plan ?? snapshot.plan;
            const stageOperation = snapshot.stage_operation ?? snapshot.operation;
            need(
              stagePlan?.phase === 'STAGE' &&
                stageOperation?.status === 'SUCCEEDED' &&
                adapters['engine-stage'],
              'RELEASE_ORIGINAL_ENGINE_STAGE_REQUIRED'
            );
            engine = await adapters['engine-stage'].current(stagePlan.request, stageOperation);
          } else {
            const previous = await retainedEvidence(
              snapshot.queue.release_id,
              'club-arena-engine',
              e.source_sha,
              e.identity
            );
            engine = await readNativeEngine({
              release_id: snapshot.queue.release_id,
              component_tuple: { 'club-arena-engine': previous },
            });
          }
          need(engine.source_sha === e.source_sha && engine.image_id === e.identity);
          const web = (await readFrontend()).native;
          need(
            sameFacts(before['club-arena-web'], {
              source_sha: web.source_sha,
              identity: `sha256:${web.manifest_sha256}`,
              manifest_digest: web.manifest_sha256,
            })
          );
          return structuredClone(before);
        };
        const compatibility = new ComponentCompatibilityReadiness({
          contract: c.compatibility.contract,
          readBefore,
          qualifier,
          retainedEvidence,
        });
        runtime.staticReadiness = new StaticReadiness({
          adapter: adapters['github-static'],
          readNative: readNativeFrontend,
          github: githubRequest,
          compatibilityReadiness: compatibility,
        });
        if (runtime.readiness)
          runtime.mixedReadiness = new MixedReadiness({
            engineReadiness: runtime.readiness,
            staticReadiness: runtime.staticReadiness,
            compatibilityReadiness: compatibility,
          });
      }
    }
  } else need(!config.components, 'RELEASE_COMPONENT_CERTIFICATION_VERSION_REQUIRED');
  if (config.github?.certificationWorkflowId) {
    need(adapters['hetzner-intake'], 'RELEASE_CERTIFICATION_INSTALLATION_REQUIRED');
    adapters['github-certification'] = new GitHubCertificationAdapter({
      ...config.github,
      workflowId: config.github.certificationWorkflowId,
      request: githubRequest,
      componentReadback: readback,
      publicationReadback: async (r) => {
        need(publicationReader, 'RELEASE_CERTIFICATION_PUBLICATION_REQUIRED');
        const operation = await publicationReader(r.publication_operation_id);
        return adapters['hetzner-intake'].reconcile(operation.intent.provider_request, operation);
      },
    });
  }
  if (config.admission) {
    need(
      /^[a-z_][a-z0-9_]{0,62}$/.test(config.admission.database_principal),
      'RELEASE_ADMISSION_IDENTITY_REQUIRED'
    );
    runtime.admissionPrincipal = config.admission.database_principal;
    runtime.admissionDatabase = {
      connectionString: (await credential(config.admission.database_credential_name))
        .toString()
        .trim(),
      ssl: { ca: await installedFile(config.admission.database_ca_path), rejectUnauthorized: true },
    };
  }
  return runtime;
}
