import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
});
