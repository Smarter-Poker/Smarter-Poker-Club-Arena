import { certificationCall, GitHubStaticIdentity } from './certification-callback.mjs';
import { requireCertificate as need, uuid, sameFacts } from './component-certificate.mjs';

export class StaticPublicationCallback {
  constructor({ identity, database, github }) {
    Object.assign(this, { identity, database, github });
  }
  async handle({ authorization, body }) {
    need(
      typeof authorization === 'string' &&
        authorization.startsWith('Bearer ') &&
        uuid.test(body?.build_operation_id) &&
        uuid.test(body.claim_key)
    );
    const client = await this.database();
    try {
      const context = await certificationCall(client, 'static_publication_context', [
        body.build_operation_id,
      ]);
      need(sameFacts(context.binding, this.identity.binding));
      // The original installation binding remains exact. Only the private
      // persisted plan can supply a newer, closure-qualified default SHA.
      const b = { ...context.binding, control_sha: context.request.control_sha };
      const identity = await new GitHubStaticIdentity({
        binding: b,
        fetchImpl: this.identity.fetchImpl,
        now: this.identity.now,
      }).authenticate(authorization.slice(7));
      const run = await this.github(`/repos/${b.repository}/actions/runs/${identity.run_id}`);
      need(
        String(run.id) === identity.run_id &&
          run.run_attempt === 1 &&
          run.workflow_id === Number(b.workflow_id) &&
          run.head_sha === b.control_sha &&
          run.path === b.workflow_path &&
          run.event === 'repository_dispatch' &&
          String(run.repository?.id) === b.repository_id &&
          String(run.head_repository?.id) === b.repository_id &&
          run.display_title === `release:${body.build_operation_id}:STATIC` &&
          run.status === 'in_progress'
      );
      const inventory = await this.github(
        `/repos/${b.repository}/actions/workflows/${b.workflow_id}/runs?event=repository_dispatch&head_sha=${b.control_sha}&created=${encodeURIComponent(`>=${context.created_at}`)}&per_page=100`
      );
      need(Array.isArray(inventory.workflow_runs) && inventory.total_count <= 100);
      const matching = inventory.workflow_runs.filter((x) => x.display_title === run.display_title);
      need(matching.length === 1 && matching[0].id === run.id && matching[0].run_attempt === 1);
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
          String(fresh.repository?.id) === b.repository_id &&
          String(fresh.head_repository?.id) === b.repository_id
      );
      return await certificationCall(client, 'claim_static_publication', [
        body.build_operation_id,
        identity,
        body.claim_key,
      ]);
    } finally {
      await client.end();
    }
  }
}
