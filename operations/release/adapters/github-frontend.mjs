import { GitHubWorkflowAdapter } from './github.mjs';
import { requireCertificate as need, sameFacts } from '../component-certificate.mjs';

export const frontendQualificationChecks = Object.freeze([
  'root-typecheck',
  'root-vitest',
  'frontend-lint',
]);
export class GitHubFrontendQualificationAdapter extends GitHubWorkflowAdapter {
  constructor(config) {
    super({ ...config, workflowPath: '.github/workflows/release-frontend-candidate.yml' });
  }
  validate(r) {
    super.validate(r);
    need(
      r.phase === 'VALIDATION' &&
        r.target === 'club-arena-web' &&
        r.frontend_qualification_version === 1 &&
        r.repository === 'Smarter-Poker/Smarter-Poker-Club-Arena'
    );
  }
  async reconcile(r, operation) {
    const result = await super.reconcile(r, operation);
    if (result.outcome === 'SUCCEEDED')
      need(
        result.proof.frontend_qualification_version === 1 &&
          sameFacts(result.proof.checks, frontendQualificationChecks) &&
          result.proof.source_tree_sha === r.tested_tree_sha
      );
    return result;
  }
}
