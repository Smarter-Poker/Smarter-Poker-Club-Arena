const id = /^(?:prj|dpl|team)_[a-zA-Z0-9]+$/;
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/;
const need = (value) => {
  if (!value) throw new Error('RELEASE_VERCEL_BOUNDARY_REFUSED');
};
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// Production construction always uses api.vercel.com. Tests inject a transport,
// never a process-env endpoint override that could exfiltrate the token.
export function vercelTransport(token, fetcher = fetch) {
  need(typeof token === 'string' && token.length > 0);
  return async (path, { method = 'GET', body } = {}) => {
    need(path.startsWith('/') && !path.startsWith('//'));
    const response = await fetcher(`https://api.vercel.com${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Never return provider error bodies: projects can include secret env values.
    if (!response.ok) throw new Error('RELEASE_VERCEL_HTTP_FAILED');
    if (method === 'POST') return { status: response.status };
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        need(size <= 2 * 1024 * 1024);
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally {
      await reader.cancel().catch(() => {});
    }
  };
}

export class VercelPromoteAdapter {
  constructor({ projectId, teamId, domains, request }) {
    need(
      id.test(projectId) &&
        projectId.startsWith('prj_') &&
        id.test(teamId) &&
        teamId.startsWith('team_')
    );
    need(
      Array.isArray(domains) &&
        domains.length > 0 &&
        domains.length <= 25 &&
        domains.every((d) => domain.test(d))
    );
    Object.assign(this, { projectId, teamId, domains, request });
  }
  validate(r) {
    need(
      r?.target === 'world-hub-web' && r.project_id === this.projectId && r.team_id === this.teamId
    );
    need(
      id.test(r.deployment_id) &&
        r.deployment_id.startsWith('dpl_') &&
        sha.test(r.source_sha) &&
        digest.test(r.manifest_digest)
    );
    need(
      id.test(r.expected_current?.deployment_id) &&
        r.expected_current.deployment_id.startsWith('dpl_')
    );
    need(
      r.deployment_id !== r.expected_current.deployment_id && same(r.domains ?? [], this.domains)
    );
    need(
      Number.isSafeInteger(r.expected_current.last_alias_requested_at) &&
        r.expected_current.last_alias_requested_at >= 0
    );
  }
  url(path) {
    return `${path}${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(this.teamId)}`;
  }
  async inventory() {
    const inventory = await this.request(
      this.url(`/v9/projects/${this.projectId}/domains?production=true&limit=100`)
    );
    need(Array.isArray(inventory.domains) && !inventory.pagination?.next);
    need(
      inventory.domains.every(
        (d) =>
          d.projectId === this.projectId &&
          d.verified === true &&
          !d.gitBranch &&
          !d.customEnvironmentId
      )
    );
    need(
      same(
        inventory.domains.map((d) => d.name),
        this.domains
      )
    );
  }
  async read(r) {
    this.validate(r);
    const project = await this.request(this.url(`/v9/projects/${this.projectId}`));
    const deployment = await this.request(this.url(`/v13/deployments/${r.deployment_id}`));
    need(project.id === this.projectId && project.accountId === this.teamId);
    need(
      deployment.id === r.deployment_id &&
        deployment.projectId === this.projectId &&
        deployment.ownerId === this.teamId
    );
    need(
      deployment.target === 'production' &&
        deployment.readyState === 'READY' &&
        deployment.meta?.githubCommitSha === r.source_sha
    );
    need(project.autoAssignCustomDomains === false && !project.rollingRelease);
    await this.inventory();
    const aliases = [];
    for (const name of this.domains) {
      const a = await this.request(this.url(`/v4/aliases/${encodeURIComponent(name)}`));
      need(
        a.alias === name && a.projectId === this.projectId && a.deployment?.id === a.deploymentId
      );
      aliases.push({ domain: name, deployment_id: a.deploymentId });
    }
    // Only these explicit fields can enter the private evidence ledger.
    const last = project.lastAliasRequest;
    return {
      current: project.targets?.production?.id,
      substate: deployment.readySubstate,
      last: last
        ? {
            type: last.type,
            from: last.fromDeploymentId,
            to: last.toDeploymentId,
            requested_at: last.requestedAt,
            status: last.jobStatus,
          }
        : null,
      aliases,
    };
  }
  async preflight(r) {
    const state = await this.read(r);
    need(state.substate === 'STAGED' && state.current === r.expected_current.deployment_id);
    need(state.aliases.every((a) => a.deployment_id === state.current));
    need((state.last?.requested_at ?? 0) === r.expected_current.last_alias_requested_at);
    need(!['pending', 'in-progress'].includes(state.last?.status));
    return {
      provider: 'vercel',
      deployment_id: r.deployment_id,
      project_id: this.projectId,
      ...state,
    };
  }
  async submit(r) {
    this.validate(r);
    // Exactly one request, no client retry. 201/202 is acceptance, not success.
    const response = await this.request(
      this.url(`/v10/projects/${this.projectId}/promote/${r.deployment_id}`),
      { method: 'POST', body: {} }
    );
    return {
      terminal: false,
      provider: 'vercel',
      project_id: this.projectId,
      deployment_id: r.deployment_id,
      accepted_http_status: response.status,
      reason: 'PROMOTION_REQUIRES_EXACT_READBACK',
    };
  }
  async reconcile(r) {
    const state = await this.read(r);
    const last = state.last;
    const result = {
      terminal: false,
      provider: 'vercel',
      project_id: this.projectId,
      deployment_id: r.deployment_id,
      ...state,
    };
    // Missing, old, foreign or skipped requests are NEVER proof of no acceptance.
    if (
      last?.type !== 'promote' ||
      last.to !== r.deployment_id ||
      last.from !== r.expected_current.deployment_id ||
      !(last.requested_at > r.expected_current.last_alias_requested_at)
    )
      return { ...result, reason: 'PROMOTION_IDENTITY_UNRESOLVED' };
    result.provider_operation_key = `${this.projectId}:${last.type}:${last.from}:${last.to}:${last.requested_at}`;
    if (last.status === 'failed') return { ...result, terminal: true, outcome: 'FAILED' };
    if (
      last.status !== 'succeeded' ||
      state.current !== r.deployment_id ||
      state.substate !== 'PROMOTED' ||
      state.aliases.some((a) => a.deployment_id !== r.deployment_id)
    )
      return { ...result, reason: 'PROMOTION_NOT_TERMINALLY_CONVERGED' };
    // Bracket the domain reads with exact project request/current readback.
    const final = await this.request(this.url(`/v9/projects/${this.projectId}`));
    const check = final.lastAliasRequest;
    need(
      final.id === this.projectId &&
        final.accountId === this.teamId &&
        final.targets?.production?.id === r.deployment_id
    );
    need(
      check?.requestedAt === last.requested_at &&
        check.type === 'promote' &&
        check.toDeploymentId === r.deployment_id &&
        check.fromDeploymentId === last.from &&
        check.jobStatus === 'succeeded'
    );
    await this.inventory();
    return { ...result, terminal: true, outcome: 'SUCCEEDED' };
  }
}
