import { createHash, randomUUID } from 'node:crypto';
import { connect } from './journal.mjs';
import { operationPolicyDigest } from './operation-policy.mjs';
import { validateMixedCompatibility } from './mixed-readiness.mjs';
import { artifactIdentity, uuid } from './component-certificate.mjs';

const need = (v) => {
  if (!v) throw new Error('RELEASE_ENGINE_READINESS_UNPROVEN');
};
export const catalogueDigest = (rows) =>
  createHash('sha256').update(JSON.stringify(rows)).digest('hex');
export async function readDoorCatalogue(client, names) {
  need(
    Array.isArray(names) &&
      names.length > 0 &&
      names.length <= 2048 &&
      names.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  );
  await client.query('BEGIN READ ONLY');
  try {
    const result = await client.query(
      `SELECT p.proname AS name,
      pg_get_function_identity_arguments(p.oid) AS arguments, pg_get_function_result(p.oid) AS result,
      p.prosecdef AS security_definer, p.provolatile AS volatility, md5(p.prosrc) AS body_digest
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[])
      ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
      [names]
    );
    return result.rows;
  } finally {
    await client.query('ROLLBACK');
  }
}
export function liveCatalogue(config, principal) {
  need(typeof principal === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(principal));
  return async (names) => {
    const client = await connect(config);
    try {
      need(
        client.connection.stream.encrypted === true && client.connection.stream.authorized === true
      );
      const role = (
        await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication
        FROM pg_roles WHERE rolname=session_user`)
      ).rows[0];
      need(
        role?.rolname === principal &&
          role.rolcanlogin &&
          !role.rolsuper &&
          !role.rolbypassrls &&
          !role.rolcreaterole &&
          !role.rolcreatedb &&
          !role.rolreplication
      );
      return await readDoorCatalogue(client, names);
    } finally {
      await client.end();
    }
  };
}

export async function publicReleaseJSON(url, fetcher = fetch) {
  need(
    [
      'https://engine.smarter.poker/health',
      'https://ca-static.smarter.poker/build-info.json',
      'https://smarter.poker/hub/club-arena/build-info.json',
    ].includes(url)
  );
  const response = await fetcher(`${url}?release_probe=${randomUUID()}`, {
    redirect: 'error',
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(15000),
  });
  need(response.ok);
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    need(size <= 65536);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
const sourceSHA = (info) => info?.ca_sha;
export class EngineReadiness {
  constructor({ catalogue, intake, publicJSON = publicReleaseJSON, retainedFrontendEvidence }) {
    Object.assign(this, { catalogue, intake, publicJSON, retainedFrontendEvidence });
  }
  async verify(snapshot, request, operation, options = {}) {
    const { queue: q, receipts } = snapshot;
    const component = q.resolution_manifest.components.find(
      (c) => c.target === 'club-arena-engine'
    );
    const mixed = q.resolution_manifest.components.some((c) => c.target === 'club-arena-web');
    const semantic = mixed ? validateMixedCompatibility(snapshot, options.compatibility) : null;
    const compatibility = mixed
      ? {
          unchanged_frontend_sha: semantic.before_components['club-arena-web'].source_sha,
          database_contract_digest: semantic.semantic.request.schema.database_contract_digest,
        }
      : component?.compatibility;
    need(
      mixed ||
        (compatibility?.mode === 'backward-compatible-engine' &&
          /^[0-9a-f]{40}$/.test(compatibility.unchanged_frontend_sha) &&
          /^[0-9a-f]{64}$/.test(compatibility.database_contract_digest) &&
          compatibility.operation_policy_digest === operationPolicyDigest &&
          Array.isArray(compatibility.receipt_refs) &&
          compatibility.receipt_refs.length > 0)
    );
    if (mixed)
      need(
        request.expected_current.source_sha ===
          semantic.before_components['club-arena-engine'].source_sha &&
          request.expected_current.image_id ===
            semantic.before_components['club-arena-engine'].identity
      );
    const doors = receipts.BUILD.data.database_doors;
    need(
      doors &&
        Array.isArray(doors.names) &&
        doors.exceptions &&
        doors.digest === catalogueDigest({ names: doors.names, exceptions: doors.exceptions })
    );
    const rows = await this.catalogue(doors.names);
    need(catalogueDigest(rows) === compatibility.database_contract_digest);
    const present = new Set(rows.map((r) => r.name));
    need(
      doors.names.every(
        (name) =>
          present.has(name) ||
          (typeof doors.exceptions[name] === 'string' && doors.exceptions[name].length > 0)
      )
    );
    const origin = sourceSHA(
      await this.publicJSON('https://ca-static.smarter.poker/build-info.json')
    );
    const publicWeb = sourceSHA(
      await this.publicJSON('https://smarter.poker/hub/club-arena/build-info.json')
    );
    need(origin === compatibility.unchanged_frontend_sha && publicWeb === origin);
    const host = await this.intake.preflight(request, operation);
    const health = await this.publicJSON('https://engine.smarter.poker/health');
    need(
      health.maintenance?.policyVersion === 2 &&
        health.maintenance.policyDigest === operationPolicyDigest &&
        typeof health.maintenance.activationReceipt === 'string' &&
        health.maintenance.activationReceipt.length > 0
    );
    need(
      health.running === true &&
        health.releaseSha === request.expected_current.source_sha &&
        typeof health.instanceId === 'string' &&
        health.instanceId.length > 0
    );
    let retained = { 'club-arena-web': { source_sha: origin } };
    if (mixed) retained = {};
    else if (this.retainedFrontendEvidence) {
      const web = await this.retainedFrontendEvidence(snapshot, origin);
      need(
        web?.mode === 'retained' &&
          web.source_sha === origin &&
          artifactIdentity.test(web.identity) &&
          web.identity === `sha256:${web.manifest_digest}` &&
          uuid.test(web.verified_receipt_id)
      );
      retained = { 'club-arena-web': web };
    }
    return {
      compatibility_verified: true,
      technical_gates_passed: true,
      database_contract_digest: compatibility.database_contract_digest,
      operation_policy_digest: operationPolicyDigest,
      expected_current: request.expected_current,
      retained_components: retained,
      maintenance_activation_receipt: health.maintenance.activationReceipt,
      prior_engine_instance: health.instanceId,
      provider_requests: { 'hetzner-intake': request },
      host,
    };
  }
}
