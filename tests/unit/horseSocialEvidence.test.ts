import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { timeoutBudgetMinutes } from '../productionJobBudget';
import { describe, expect, it } from 'vitest';
import {
  horseSocialFrames,
  rankHorseSocialCohorts,
  horseSocialTableEligible,
  postHandChatDelay,
  sharedPayout,
} from '../e2e/support/horseSocialEvidence';

describe('natural horse social evidence', () => {
  it('does not let a crowded dry NLH table starve a naturally active PLO cohort', () => {
    const cohorts = [
      { candidate: { id: 'dry-nlh' }, horseCount: 9 },
      { candidate: { id: 'active-plo' }, horseCount: 6 },
    ];
    const since = '2026-10-28T17:46:00Z';
    const rows = [
      { table_id: 'active-plo', ended_at: '2026-10-28T17:47:00Z' },
      { table_id: 'active-plo', ended_at: '2026-10-28T17:48:00Z' },
      { table_id: 'dry-nlh', ended_at: '2026-10-28T17:45:59Z' },
      { table_id: 'unselected', ended_at: '2026-10-28T17:48:00Z' },
    ];
    const ranked = rankHorseSocialCohorts(cohorts, rows, since);
    expect(ranked.map((entry) => entry.candidate.id)).toEqual(['active-plo', 'dry-nlh']);
    expect(ranked.map((entry) => entry.showdownCount)).toEqual([2, 0]);
    expect(cohorts.map((entry) => entry.candidate.id)).toEqual(['dry-nlh', 'active-plo']);
  });

  it('retains stable horse-count ties and excludes unreadable activity timestamps', () => {
    const cohorts = [
      { candidate: { id: 'six' }, horseCount: 6 },
      { candidate: { id: 'nine' }, horseCount: 9 },
    ];
    expect(
      rankHorseSocialCohorts(
        cohorts,
        [{ table_id: 'six', ended_at: 'unreadable' }],
        '2026-10-28T17:46:00Z'
      ).map((entry) => entry.candidate.id)
    ).toEqual(['nine', 'six']);
  });

  it('bounds diverse discovery and reads activity metadata without mutating games', () => {
    const spec = readFileSync('tests/e2e/production-live-table-realtime.spec.ts', 'utf8');
    const social = spec.split("test('natural horse social behavior")[1];
    expect(social).toContain(
      'selectOccupiedRunningCashTables(page, request, { perVariantLimit: 3 })'
    );
    expect(spec).toContain('variantCount < options.perVariantLimit');
    expect(spec).toContain('variantCount >= options.perVariantLimit');
    const activity = social
      .split('const showdowns = await db')[1]
      .split('expect(showdowns.error)')[0];
    expect(activity).toContain(".select('table_id,ended_at')");
    // The production table index starts with (table_id, created_at). A limit
    // after filtering/sorting only ended_at still scans the table's retained
    // history and timed out before any natural observation in run40762123113.
    expect(activity).toContain(".gte('created_at', activitySince)");
    expect(activity).toContain(".gte('ended_at', activitySince)");
    expect(activity).toContain(".order('created_at', { ascending: false })");
    expect(activity).not.toContain(".order('ended_at'");
    expect(activity).toContain(".not('showdown', 'is', null)");
    expect(activity).toContain(".neq('showdown', '[]')");
    expect(activity).toContain('.limit(180)');
    expect(activity).not.toMatch(/cards|winners|actions/);
    expect(social).not.toMatch(/\.(?:insert|upsert|update|delete|rpc)\(/);
  });

  it('observes only the ordinary chips cash cohort that can actually emit chat', () => {
    const cash = { max_players: 6, ban_chat: false, tournament_id: null, game_type: 'cash' };
    expect(horseSocialTableEligible(cash, 'chips')).toBe(true);
    expect(horseSocialTableEligible(cash, 'diamonds')).toBe(false);
    expect(horseSocialTableEligible(cash, undefined)).toBe(false);
    expect(horseSocialTableEligible({ ...cash, max_players: 2 }, 'chips')).toBe(false);
    expect(horseSocialTableEligible({ ...cash, ban_chat: true }, 'chips')).toBe(false);
    expect(horseSocialTableEligible({ ...cash, tournament_id: 'natural-mtt' }, 'chips')).toBe(
      false
    );
    const workflow = readFileSync('.github/workflows/post-deploy-e2e.yml', 'utf8');
    const lane = workflow
      .split('      - name: Observe natural horse chat, reactions and throwables')[1]
      ?.split('      - name: Retain natural horse social evidence')[0];
    expect(lane).toContain('E2E_CLUB_ID: a41434bb-8d0c-400a-8f0d-e8b3d65afed4');
    expect(lane).not.toContain('E2E_CLUB_ID: 002c2d27-9584-4e52-835a-bb2be148fc81');
  });

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
