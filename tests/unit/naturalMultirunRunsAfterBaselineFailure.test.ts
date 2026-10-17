import { readFileSync } from 'node:fs';
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
