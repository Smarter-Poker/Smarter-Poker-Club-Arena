import { createPublicKey, verify } from 'node:crypto';
import { requireCertificate as need, uuid, sameFacts } from './component-certificate.mjs';

const issuer = 'https://token.actions.githubusercontent.com';
const jwksURL = `${issuer}/.well-known/jwks`;
async function publicKeys(fetchImpl) {
  const response = await fetchImpl(jwksURL, {
    redirect: 'error',
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(10000),
  });
  need(response.ok, 'RELEASE_OIDC_JWKS_UNAVAILABLE');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    need(size <= 131072);
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks));
  need(
    Array.isArray(value.keys) &&
      value.keys.length > 0 &&
      value.keys.length <= 16 &&
      new Set(value.keys.map((k) => k.kid)).size === value.keys.length
  );
  return value.keys;
}
export class GitHubActionsIdentity {
  constructor({ binding, purpose, fetchImpl = fetch, now = Date.now }) {
    Object.assign(this, { binding, fetchImpl, now, keys: [], refreshed: 0 });
    need(['certificate', 'static'].includes(purpose));
    this.event = purpose === 'static' ? 'repository_dispatch' : 'workflow_dispatch';
    need(
      binding?.audience ===
        (purpose === 'static'
          ? 'club-arena-static-publication'
          : 'club-arena-release-certification') &&
        binding.workflow_path ===
          (purpose === 'static'
            ? '.github/workflows/publish-club-arena.yml'
            : '.github/workflows/post-deploy-e2e.yml') &&
        binding.repository === 'Smarter-Poker/Smarter-Poker-Club-Arena' &&
        /^[1-9][0-9]*$/.test(String(binding.repository_id)) &&
        /^refs\/heads\/[A-Za-z0-9/_-]+$/.test(binding.control_ref)
    );
  }
  async authenticate(token) {
    need(typeof token === 'string' && token.length <= 16384);
    const parts = token.split('.');
    need(parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p)));
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    need(
      header.alg === 'RS256' &&
        header.typ === 'JWT' &&
        typeof header.kid === 'string' &&
        !header.crit &&
        !header.jku &&
        !header.jwk &&
        !header.x5u
    );
    let key = this.keys.find((k) => k.kid === header.kid);
    if (!key || this.now() - this.refreshed >= 300000) {
      this.keys = await publicKeys(this.fetchImpl);
      this.refreshed = this.now();
      key = this.keys.find((k) => k.kid === header.kid);
    }
    need(key?.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256');
    const publicKey = createPublicKey({ key, format: 'jwk' });
    need(
      publicKey.asymmetricKeyDetails?.modulusLength >= 2048 &&
        verify(
          'RSA-SHA256',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          publicKey,
          Buffer.from(parts[2], 'base64url')
        )
    );
    const now = Math.floor(this.now() / 1000),
      b = this.binding;
    need(
      claims.iss === issuer &&
        claims.aud === b.audience &&
        claims.sub === `repo:${b.repository}:ref:${b.control_ref}` &&
        claims.repository === b.repository &&
        String(claims.repository_id) === String(b.repository_id) &&
        claims.sha === b.control_sha &&
        claims.workflow_sha === b.control_sha &&
        claims.ref === b.control_ref &&
        claims.workflow_ref === `${b.repository}/${b.workflow_path}@${b.control_ref}` &&
        claims.event_name === this.event &&
        claims.run_attempt === '1' &&
        /^[1-9][0-9]*$/.test(claims.run_id) &&
        typeof claims.jti === 'string' &&
        claims.jti.length <= 200 &&
        [claims.iat, claims.nbf, claims.exp].every(Number.isSafeInteger) &&
        claims.iat <= now + 30 &&
        claims.nbf <= now + 30 &&
        claims.exp > now &&
        claims.exp - claims.iat <= 600 &&
        now - claims.iat <= 600
    );
    return {
      repository_id: String(b.repository_id),
      workflow_id: String(b.workflow_id),
      control_sha: b.control_sha,
      run_id: claims.run_id,
      run_attempt: 1,
    };
  }
}

export class GitHubCertificateIdentity extends GitHubActionsIdentity {
  constructor(config) {
    super({ ...config, purpose: 'certificate' });
  }
}
export class GitHubStaticIdentity extends GitHubActionsIdentity {
  constructor(config) {
    super({ ...config, purpose: 'static' });
  }
}

const callbackFunctions = new Set([
  'certification_callback_context',
  'certification_fixture_callback',
  'certification_cleanup_context',
  'static_publication_context',
  'claim_static_publication',
  'component_engine_publication',
  'component_retained_evidence',
]);
export async function certificationCall(client, name, args) {
  need(callbackFunctions.has(name));
  const version = (await client.query('SELECT release_ops.certification_schema_version() AS v'))
    .rows[0];
  need(version.v === 2);
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL synchronous_commit=on');
    const value = (
      await client.query(
        `SELECT release_ops.${name}(${args.map((_, i) => `$${i + 1}`).join(',')}) AS v`,
        args
      )
    ).rows[0].v;
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

// The installed HTTPS ingress forwards this route into the existing admission
// socket. This object has only the callback principal; never an owner session.
export class CertificateCallback {
  constructor({ identity, database, github, componentReadback }) {
    Object.assign(this, { identity, database, github, componentReadback });
  }
  async handle({ authorization, body }) {
    need(typeof authorization === 'string' && authorization.startsWith('Bearer '));
    const identity = await this.identity.authenticate(authorization.slice(7));
    need(
      uuid.test(body?.operation_id) &&
        ['snapshot', 'consume', 'creation-result', 'begin-cleanup', 'cleanup-complete'].includes(
          body.action
        )
    );
    const client = await this.database();
    try {
      const recovering = body.recovery_id !== undefined;
      need(!recovering || uuid.test(body.recovery_id));
      need(
        !recovering ||
          ['creation-result', 'begin-cleanup', 'cleanup-complete'].includes(body.action)
      );
      const context = await certificationCall(
        client,
        recovering ? 'certification_cleanup_context' : 'certification_callback_context',
        recovering ? [body.operation_id, body.recovery_id] : [body.operation_id]
      );
      need(sameFacts(context.binding, this.identity.binding));
      const b = context.binding,
        r = context.request;
      const run = await this.github(`/repos/${b.repository}/actions/runs/${identity.run_id}`);
      need(
        String(run.id) === identity.run_id &&
          run.run_attempt === 1 &&
          run.workflow_id === Number(b.workflow_id) &&
          run.head_sha === b.control_sha &&
          run.path === b.workflow_path &&
          run.event === 'workflow_dispatch' &&
          run.repository?.id === Number(b.repository_id) &&
          run.head_repository?.id === Number(b.repository_id) &&
          run.display_title ===
            (recovering
              ? `release:${body.recovery_id}:CLEANUP`
              : `release:${body.operation_id}:CERTIFY`) &&
          run.status === 'in_progress'
      );
      const inventory = await this.github(
        `/repos/${b.repository}/actions/workflows/${b.workflow_id}/runs?event=workflow_dispatch&head_sha=${b.control_sha}&created=${encodeURIComponent(`>=${recovering ? context.cleanup_recovery.created_at : context.created_at}`)}&per_page=100`
      );
      need(Array.isArray(inventory.workflow_runs) && inventory.total_count <= 100);
      const matching = inventory.workflow_runs.filter((x) => x.display_title === run.display_title);
      need(matching.length === 1 && matching[0].id === run.id && matching[0].run_attempt === 1);
      if (['snapshot', 'consume'].includes(body.action)) {
        need(
          typeof this.componentReadback === 'function',
          'RELEASE_COMPONENT_READBACK_NOT_INSTALLED'
        );
        const observed = await this.componentReadback(r, { id: body.operation_id }, client);
        need(sameFacts(observed.served_components, r.component_tuple));
        if (body.action === 'snapshot')
          return {
            ...observed,
            operation_id: body.operation_id,
            run_id: identity.run_id,
            run_attempt: 1,
          };
      }
      // Fresh run identity immediately before the transactional one-use gate.
      const fresh = await this.github(`/repos/${b.repository}/actions/runs/${identity.run_id}`);
      need(
        [
          'id',
          'run_attempt',
          'workflow_id',
          'head_sha',
          'path',
          'event',
          'display_title',
          'status',
        ].every((key) => fresh[key] === run[key]) &&
          fresh.repository?.id === Number(b.repository_id) &&
          fresh.head_repository?.id === Number(b.repository_id)
      );
      return await certificationCall(client, 'certification_fixture_callback', [
        body.operation_id,
        identity,
        body.action,
        body.slot ?? null,
        body.claim_key ?? null,
        body.proof ?? null,
        body.recovery_id ?? null,
      ]);
    } finally {
      await client.end();
    }
  }
}
