import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { timeoutBudgetMinutes } from '../productionJobBudget';
import { describe, expect, it } from 'vitest';
import {
  horseSocialFrames,
  postHandChatDelay,
  sharedPayout,
} from '../e2e/support/horseSocialEvidence';

describe('natural horse social evidence', () => {
  it.each(['failure', 'skipped', 'cancelled', ''])(
    'the actual certificate refuses a requested horse observation with outcome %s',
    (outcome) => {
      const workflow = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
      const liveWorkflow = workflow.slice(workflow.indexOf('\n  live-table-e2e:\n'));
      const section = liveWorkflow.slice(
        liveWorkflow.indexOf('      - name: Classify the release window this certificate covers')
      );
      const script = section
        .split('        run: |\n')[1]
        ?.split('\n      - name:')[0]
        .replace(/^ {10}/gm, '');
      expect(script).toContain('HORSE_SOCIAL_OUTCOME');
      const directory = mkdtempSync(join(tmpdir(), 'horse-social-verdict-'));
      const output = join(directory, 'output');
      const summary = join(directory, 'summary');
      try {
        execFileSync('/bin/bash', ['-c', script!], {
          env: {
            PATH: process.env.PATH,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            HORSE_SOCIAL_REQUESTED: 'true',
            HORSE_SOCIAL_OUTCOME: outcome,
          },
          stdio: 'pipe',
        });
        expect(readFileSync(output, 'utf8')).toBe('certified=false\n');
        expect(readFileSync(summary, 'utf8')).toContain(
          'natural horse social observation did not pass'
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
      expect(workflow).toContain(
        '&& node scripts/ci/assert-e2e-actually-ran.mjs e2e-report/horse-social.json'
      );
    }
  );

  it('the actual admission shell refuses mixed, unpinned and non-boolean observations', () => {
    const workflow = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
    const block = workflow
      .split('          if [ "$EVENT_NAME" = repository_dispatch ]; then\n')[1]
      ?.split('            if node -e')[0];
    expect(block).toContain('Horse social proof requires literal true');
    const admit = (overrides: Record<string, string>) =>
      execFileSync('/bin/bash', ['-c', block!], {
        env: {
          PATH: process.env.PATH,
          HORSE_SOCIAL_JSON: 'true',
          MOBILE_MULTIRUN_JSON: 'null',
          MOBILE_MULTIRUN_TARGET_JSON: 'null',
          CLIENT_NAVIGATION_JSON: 'null',
          ENGINE_TRIGGER_JSON: '"' + 'a'.repeat(40) + '"',
          ...overrides,
        },
        stdio: 'pipe',
      });
    expect(() => admit({})).not.toThrow();
    expect(() => admit({ HORSE_SOCIAL_JSON: '"true"' })).toThrow();
    expect(() => admit({ ENGINE_TRIGGER_JSON: 'null' })).toThrow();
    expect(() => admit({ MOBILE_MULTIRUN_JSON: 'true' })).toThrow();
    expect(() => admit({ CLIENT_NAVIGATION_JSON: 'true' })).toThrow();
  });

  it('preserves the existing opt-in fixture lifetime and refuses unknown budget expressions', () => {
    expect(
      timeoutBudgetMinutes(
        "${{ github.event_name == 'repository_dispatch' && (toJSON(github.event.client_payload.mobile_multirun) == 'true' || toJSON(github.event.client_payload.horse_social) == 'true') && 143 || 121 }}"
      )
    ).toEqual({ ordinary: 121, optIn: 143 });
    expect(() =>
      timeoutBudgetMinutes('${{ github.event.client_payload.unreviewed_budget }}')
    ).toThrow();
  });
  it('extracts nested public CHAT facts without auth or private gameplay payloads', () => {
    expect(
      horseSocialFrames(
        {
          apiKey: 'not-evidence',
          payload: {
            type: 'CHAT',
            sender: 'horse',
            payload: { message: '[THROW:rose:3]', throwId: 'receipt' },
            privateCards: ['not-evidence'],
          },
        },
        100
      )
    ).toEqual([{ at: 100, sender: 'horse', message: '[THROW:rose:3]', throwId: 'receipt' }]);
    expect(horseSocialFrames({ type: 'AUTH', payload: { token: 'not-evidence' } }, 100)).toEqual(
      []
    );
  });
  it('measures the visible chat timestamp, not the earlier claim', () => {
    expect(postHandChatDelay('2026-10-28T09:10:00Z', '2026-10-28T09:10:05Z')).toBe(5000);
    expect(postHandChatDelay('2026-10-28T09:10:00Z', '2026-10-28T09:10:04.999Z')).toBe(4999);
    expect(() => postHandChatDelay('', '')).toThrow();
  });
  it('distinguishes shared payouts from multiple pots paid to one player', () => {
    expect(sharedPayout([{ userId: 'a' }, { userId: 'b' }])).toBe(true);
    expect(sharedPayout([{ userId: 'a' }, { userId: 'a' }])).toBe(false);
    expect(() => sharedPayout(null)).toThrow();
    expect(() => sharedPayout([{}])).toThrow();
  });
});
