import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20260901030000_daily_missions_server_authority.sql'),
  'utf8'
);
const ledgers = readFileSync(
  resolve(root, 'supabase/migrations/20260901025000_daily_mission_authority_ledgers.sql'),
  'utf8'
);
const freeze = readFileSync(
  resolve(root, 'supabase/migrations/20260901030100_streak_freeze_receipt_replay.sql'),
  'utf8'
);
const settlement = readFileSync(
  resolve(root, 'server/src/engine/ServerTableEngineSettlement.ts'),
  'utf8'
);
const handHistory = readFileSync(
  resolve(root, 'server/src/services/supabase/handHistory.ts'),
  'utf8'
);

describe('Daily Missions server authority laws', () => {
  it('removes every authenticated raw assignment and progress writer', () => {
    for (const signature of [
      'assign_user_challenges(text, text[])',
      'increment_challenge_progress(uuid, uuid, integer, integer)',
      'bump_challenge_progress(uuid, jsonb, jsonb, text, text, text)',
    ]) {
      expect(migration).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature.replace(/[()[\]]/g, '\\$&')}`)
      );
    }
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.assign_user_challenges');
    expect(migration).toContain('TO service_role;');
  });

  it('uses one stable receipt, immutable snapshots, and a longer dedupe horizon', () => {
    expect(ledgers).toContain('PRIMARY KEY (user_id, event_key)');
    expect(migration).toContain('threshold_snapshot');
    expect(migration).toContain('requirement_snapshot');
    expect(migration).toContain('GREATEST(p_keep_days, 45)');
    expect(migration).toContain("p_occurred_at < now() - interval '35 days'");
  });

  it('projects retryable hand facts through the outbox without settlement RPC fanout', () => {
    const enqueue = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION public.enqueue_daily_challenge_event'),
      migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_drain_daily_challenge_event_outbox')
    );
    expect(enqueue).toContain('PERFORM public.record_daily_challenge_event(');
    expect(enqueue).not.toContain('PERFORM public.enqueue_daily_challenge_event(');
    expect(migration).toContain("'daily-missions-outbox-minute'");
    expect(migration).toContain('dead_lettered_at');
    expect(handHistory).toContain('daily_mission_events: params.dailyMissionEvents');
    expect(settlement).not.toContain("runStep('daily_missions'");
  });

  it('requires recipient acceptance while preserving caller-safe mutual discovery', () => {
    expect(migration).toContain("status = 'pending'");
    expect(migration).toContain('Only the recipient can accept this friend request');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.get_mutual_friends');
    expect(migration).toContain('REVOKE ALL ON TABLE public.friendships FROM anon');
  });

  it('pays streak milestones once and replays a 2-to-3 freeze receipt before the cap', () => {
    expect(ledgers).toContain('PRIMARY KEY (user_id, streak_started_on, milestone_days)');
    expect(migration).toContain('generate_series(');
    expect(migration).toContain("'daily_mission_milestones:'");
    expect(freeze.indexOf('reference_id = v_reference_id')).toBeLessThan(
      freeze.indexOf('v_state.freezes_available >= MAX_FREEZES')
    );
  });
});
