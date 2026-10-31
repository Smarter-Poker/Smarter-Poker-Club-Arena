import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const ordinaryAuditJobs = [
  'client_release',
  'engine',
  'live_drift',
  'engine_deploy_starvation',
  'chip_conservation',
  'main_is_green',
  'ddl_reload_storms',
  'open_prs_are_green',
  'migrations_are_live',
];

function evaluateWorkflowExpression(
  expression: string,
  eventName: string,
  payload: Record<string, unknown>,
  runId = 101
) {
  // These maintained expressions use the shared JS/GitHub boolean subset.
  // Execute the actual workflow text, rather than a duplicate routing function.
  return runInNewContext(
    expression.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, ''),
    {
      github: {
        event_name: eventName,
        event: { action: 'audit-production-integrity', client_payload: payload },
        run_id: runId,
      },
      format: (template: string, value: number) => template.replace('{0}', String(value)),
    },
    { timeout: 1000 }
  );
}

describe('explicit bounded original runtime error observation', () => {
  it('executes the maintained parser, native process bounds and actual remote entry framing', () => {
    expect(() =>
      execFileSync('python3', ['tests/fixtures/scoped-runtime-errors/native-fixture.py'], {
        timeout: 15_000,
        encoding: 'utf8',
      })
    ).not.toThrow();
  });

  it('keeps host reads manual, pinned and separate from the public diagnostic reader', () => {
    const workflow = readFileSync('.github/workflows/production-integrity-audit.yml', 'utf8');
    const job = workflow.slice(
      workflow.indexOf('  scoped_runtime_errors:'),
      workflow.indexOf('  scoped_tournament_diagnostic:')
    );
    expect(job).toContain("github.event_name == 'repository_dispatch'");
    expect(job).toContain('github.event.client_payload.tournament_log_observation != null');
    expect(job).toContain('contents: read');
    expect(job).not.toMatch(/actions: write|deploy-club|workflow_dispatch|schedule:/);
    const source = readFileSync('scripts/ci/read-scoped-runtime-errors.py', 'utf8');
    expect(source).toContain('StrictHostKeyChecking=yes');
    expect(source).toContain('job="engine_game_server"');
    for (const config of [
      'infra/monitoring/prometheus.yml',
      'infra/monitoring/engine-01/prometheus.yml',
    ]) {
      expect(readFileSync(config, 'utf8')).toContain('- job_name: engine_game_server');
    }
    expect(source).toContain('GlobalKnownHostsFile=/dev/null');
    expect(source).toContain(
      "'docker', 'logs', '--since', '15m', '--tail', '20000', '--timestamps', 'club-arena-engine'"
    );
    expect(source).toContain('if before != after:');
    expect(source).toContain("health('http://127.0.0.1:8080')");
    expect(source).toContain("result.get('hostEngineBefore') != before");
    expect(source).toContain("result.get('hostEngineAfter') != after");
    expect(source).toContain("'perRecordEngineIdentity': 'unproven;");
    expect(source).toContain('shutil.rmtree(directory)');
    expect(source).not.toMatch(/docker.*(?:restart|exec|stop)|systemctl|\.env(?:\b|\.)|shell=True/);
  });

  it('keeps a finite incident read out of the single pending ordinary-audit slot', () => {
    const workflow = readFileSync('.github/workflows/production-integrity-audit.yml', 'utf8');
    expect(workflow).toContain("format('production-runtime-observation-{0}', github.run_id)");
    expect(workflow).toContain("|| 'production-integrity-audit'");
    expect(workflow).toContain('cancel-in-progress: false');
    for (const name of [
      'client_release',
      'engine',
      'live_drift',
      'engine_deploy_starvation',
      'chip_conservation',
      'main_is_green',
      'ddl_reload_storms',
      'open_prs_are_green',
      'migrations_are_live',
    ]) {
      expect(workflow).toContain(
        `  ${name}:\n    if: github.event.client_payload.tournament_log_observation == null`
      );
    }
  });

  it('gives each explicit release read its own pending slot without changing ordinary audits', () => {
    const workflow = readFileSync('.github/workflows/production-integrity-audit.yml', 'utf8');
    const group = workflow.match(/^ {2}group: (.+)$/m)?.[1];
    expect(group).toBeDefined();
    const release = { release_recovery_observation: { mode: 'pending_transaction' } };
    const first = evaluateWorkflowExpression(group!, 'repository_dispatch', release, 101);
    const second = evaluateWorkflowExpression(group!, 'repository_dispatch', release, 102);
    expect(first).toBe('production-release-observation-101');
    expect(second).toBe('production-release-observation-102');
    expect(first).not.toBe(second);
    expect(evaluateWorkflowExpression(group!, 'schedule', {})).toBe('production-integrity-audit');
    expect(evaluateWorkflowExpression(group!, 'repository_dispatch', {})).toBe(
      'production-integrity-audit'
    );
    expect(
      evaluateWorkflowExpression(group!, 'repository_dispatch', { tournament_log_observation: [] })
    ).toBe('production-runtime-observation-101');
    expect(workflow).toContain('cancel-in-progress: false');
  });

  it('runs only the qualified release reader for an explicit release observation', () => {
    const workflow = readFileSync('.github/workflows/production-integrity-audit.yml', 'utf8');
    const release = { release_recovery_observation: { mode: 'pending_transaction' } };
    for (const name of ordinaryAuditJobs) {
      const condition = workflow.match(new RegExp(`^  ${name}:\\n    if: ([^\\n]+)$`, 'm'))?.[1];
      expect(condition, name).toBeDefined();
      expect(evaluateWorkflowExpression(condition!, 'repository_dispatch', release), name).toBe(
        false
      );
      expect(evaluateWorkflowExpression(condition!, 'schedule', {}), name).toBe(true);
      expect(evaluateWorkflowExpression(condition!, 'repository_dispatch', {}), name).toBe(true);
    }
    const reader = workflow.slice(
      workflow.indexOf('  scoped_release_recovery:'),
      workflow.indexOf('  scoped_operator_hold_image:')
    );
    const condition = reader.match(/^ {4}if: (.+)$/m)?.[1];
    expect(condition).toBeDefined();
    expect(evaluateWorkflowExpression(condition!, 'repository_dispatch', release)).toBe(true);
    expect(evaluateWorkflowExpression(condition!, 'schedule', {})).toBe(false);
    expect(reader).toContain('python3 -B tests/operations/release-recovery-read.test.py');
    expect(reader).toContain('python3 -B scripts/ci/read-scoped-release-recovery.py');
    expect(reader).not.toMatch(/actions: write|deploy-club|workflow_dispatch/);
  });
});
