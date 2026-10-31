import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

// The natural two-run/three-run observation is a separate opted-in
// certificate from the four continuity cases before it. On 2026-10-17 run
// 39034908810 lost the whole natural observation because one MTT subject
// table closed before its level changed: the default success() gate skipped
// the natural step. The continuity failure still fails the job; it just no
// longer erases the other certificate's evidence.
const root = resolve(__dirname, '../..');
const workflow = parse(readFileSync(join(root, '.github/workflows/post-deploy-e2e.yml'), 'utf8'));
const steps: Array<{ id?: string; name?: string; if?: string }> =
  workflow.jobs['live-table-e2e'].steps;
const multirun = steps.find((step) => step.id === 'multirun');
const retain = steps.find((step) => step.name === 'Retain natural mobile multirun evidence');
const continuityIndex = steps.findIndex(
  (step) => step.name === 'Certify live-table continuity against the exact serving engine'
);

describe('the natural multirun observation survives a failed continuity case', () => {
  it('runs after the continuity certificate', () => {
    expect(continuityIndex).toBeGreaterThanOrEqual(0);
    expect(steps.indexOf(multirun!)).toBeGreaterThan(continuityIndex);
  });

  it('is gated by !cancelled(), never by the implicit success() or by always()', () => {
    const condition = multirun?.if ?? '';
    expect(condition.startsWith('!cancelled() && ')).toBe(true);
    expect(condition).not.toContain('always()');
    expect(condition).not.toContain('success()');
  });

  it('keeps every opt-in and fixture guard it had', () => {
    const condition = multirun?.if ?? '';
    for (const guard of [
      "github.event_name == 'repository_dispatch'",
      "toJSON(github.event.client_payload.mobile_multirun) == 'true'",
      "steps.gameplay.outputs.resumed == 'true'",
      "steps.account.outcome == 'success'",
      "steps.spectator.outcome == 'success'",
    ]) {
      expect(condition).toContain(guard);
    }
  });

  it('still retains its evidence whenever it ran', () => {
    expect(retain?.if).toContain('always()');
    expect(retain?.if).toContain("steps.multirun.outcome != 'skipped'");
  });
});

const origin = workflow.jobs['publication-gate'].steps.find((step: any) => step.id === 'origin');
function admitTarget(
  target: string,
  mobile = 'true',
  pin = 'null',
  extra: Record<string, string> = {}
) {
  return spawnSync('bash', ['-c', origin.run], {
    env: {
      ...process.env,
      EVENT_NAME: 'repository_dispatch',
      MOBILE_MULTIRUN_TARGET_JSON: target,
      MOBILE_MULTIRUN_JSON: mobile,
      ENGINE_TRIGGER_JSON: pin,
      ENGINE_TRIGGER_SHA: pin === 'null' ? '' : pin.slice(1, -1),
      GITHUB_OUTPUT: '/dev/null',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 2_000,
  });
}
it('passes the raw target and authority JSON into publication admission and the actual spec', () => {
  const actual = steps.find((step: any) => step.id === 'multirun') as any;
  for (const step of [origin, actual]) {
    expect(step.env.MOBILE_MULTIRUN_TARGET_JSON).toBe(
      '${{ toJSON(github.event.client_payload.mobile_multirun_target) }}'
    );
    expect(step.env.MOBILE_MULTIRUN_JSON).toBe(
      '${{ toJSON(github.event.client_payload.mobile_multirun) }}'
    );
    expect(step.env.ENGINE_TRIGGER_JSON).toBe(
      '${{ toJSON(github.event.client_payload.engine_sha) }}'
    );
  }
});
it('admits default null and typed three before production fixtures', () => {
  expect(admitTarget('null').status).toBe(0);
  expect(admitTarget('3').status).toBe(0);
  expect(admitTarget('1').status).toBe(0);
});
it.each(['"1"', '"3"', '2', 'true', '[]', '{}', '[3]', 'false'])(
  'refuses raw target %s before fixtures',
  (target) => {
    expect(admitTarget(target).status).not.toBe(0);
  }
);
it('refuses a targeted engine certificate or nonliteral mobile request', () => {
  expect(admitTarget('3', 'true', '"' + 'a'.repeat(40) + '"').status).not.toBe(0);
  expect(admitTarget('3', '"true"').status).not.toBe(0);
});
it('names a targeted three-run step honestly and leaves default BOTH coverage intact', () => {
  expect(multirun?.name).toContain('mobile_multirun_target');
  expect(multirun?.name).toContain('three-run only');
  expect(multirun?.name).toContain('two-run and three-run');
});

it('refuses mixed once requests before any production fixture', () => {
  expect(admitTarget('1', 'true', 'null', { HORSE_SOCIAL_JSON: 'true' }).status).not.toBe(0);
  expect(admitTarget('1', 'true', 'null', { CLIENT_NAVIGATION_JSON: 'true' }).status).not.toBe(0);
  expect(admitTarget('1', 'true', '"' + 'a'.repeat(40) + '"').status).not.toBe(0);
  expect(admitTarget('1', '"true"').status).not.toBe(0);
});
it('retains the actual once trace even when the natural observation passes', () => {
  expect((retain as any).with.path).toContain('test-results/live-table-multirun/**/trace.zip');
});
