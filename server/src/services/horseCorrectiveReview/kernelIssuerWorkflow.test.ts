import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
const workflow = readFileSync(
  new URL('../../../../.github/workflows/horse-phase14-qualification.yml', import.meta.url),
  'utf8'
);
describe('qualification service isolation and provider wiring', () => {
  it('has only explicit dispatch, protected main, and read-only provider permissions', () => {
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(
      /^\s+(schedule|push|pull_request|workflow_run|repository_dispatch):/m
    );
    expect(workflow).not.toMatch(/^\s+[a-z-]+:\s*write\s*$/m);
    expect(workflow.match(/if: github\.ref == 'refs\/heads\/main'/g)).toHaveLength(6);
    const inputs = workflow.slice(
      workflow.indexOf('    inputs:'),
      workflow.indexOf('permissions:')
    );
    expect(inputs).not.toContain('source_sha:');
    expect(inputs).toContain('plan_commit:');
  });
  it('derives exact source and Node runtime from authenticated context and separates producer from key service', () => {
    const producer = workflow.slice(workflow.indexOf('  producer:'), workflow.indexOf('  issuer:'));
    expect(producer).not.toContain('HORSE_PHASE14_QUALIFICATION_SIGNING_KEY');
    expect(producer).not.toContain('HorseCorrectiveQualification');
    expect(producer).toContain('src/scripts/horseCorrectiveKernelIssue.ts produce');
    const issuer = workflow.slice(workflow.indexOf('  issuer:'));
    expect(issuer).toContain('environment: HorseCorrectiveQualification');
    expect(issuer).toContain('src/scripts/horseCorrectiveKernelIssue.ts issue');
    expect(issuer).toContain(
      'HORSE_PHASE14_QUALIFICATION_SIGNING_KEY: ${{ secrets.HORSE_PHASE14_QUALIFICATION_SIGNING_KEY }}'
    );
    expect(issuer).toContain('ref: ${{ needs.context.outputs.source_sha }}');
    expect(issuer).toContain('node-version: ${{ needs.context.outputs.node_version }}');
  });
  it('keeps the fixed-domain identity probe independent of plan/database/journal inputs and activation', () => {
    const identity = workflow.slice(workflow.indexOf('  signer-identity:'));
    expect(identity).toContain("inputs.operation == 'signer-identity'");
    expect(identity).toContain('src/scripts/horseCorrectiveKernelIssue.ts identity');
    expect(identity).not.toContain('DATABASE_URL');
    expect(identity).not.toContain('HETZNER');
    expect(identity).not.toContain('PLAN_COMMIT');
  });
  it('uploads only bounded public receipts/qualification and never source bundles or key files', () => {
    const paths = [...workflow.matchAll(/^\s+path:\s*(.+)$/gm)].map((match) => match[1]);
    expect(paths).toEqual([
      '${{ env.P14_PRIVATE }}/producer.json',
      '${{ env.P14_PRIVATE }}/qualification.json',
      '${{ env.P14_PRIVATE }}/sanitized.json',
      '${{ env.P14_PRIVATE }}/identity.json',
    ]);
    expect(workflow).not.toContain(
      'upload-artifact@v4\n        with:\n          path: ${{ env.P14_PRIVATE }}\n'
    );
    expect(workflow).not.toContain('workflow run');
    expect(workflow).not.toContain('deploy-club-arena-engine');
  });
});

describe('private V56 existing-workflow mode', () => {
  it('separates replay from every signing credential and source raw artifact', () => {
    const jobs = workflow.slice(
      workflow.indexOf('  v56-context:'),
      workflow.indexOf('  signer-identity:')
    );
    expect(jobs).not.toContain('HORSE_PHASE14_QUALIFICATION_SIGNING_KEY');
    expect(jobs).not.toContain('HorseCorrectiveQualification');
    expect(jobs).not.toContain('DATABASE_URL');
    expect(jobs).not.toContain('horseCorrectiveKernelIssue.ts');
    expect(jobs).toContain('architecture: x64');
    expect(jobs).toContain('needs.v56-context.outputs.source_sha');
    expect(jobs).toContain('test ! -e "$P14_PRIVATE/identity"');
    expect(jobs).toContain('horseV56PrivateReplay.ts finalize');
    expect(jobs).not.toMatch(/path:.*(pending|request|input|records|identity)/);
  });
});
