/** The accepted-hand migration must not publish its internal writers as RPCs. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = join(process.cwd(), '..', 'supabase', 'migrations');
const migrationName = readdirSync(migrations).find((name) =>
  name.includes('an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path')
);
if (!migrationName) throw new Error('accepted-hand migration is missing');
const SQL = readFileSync(join(migrations, migrationName), 'utf8');

const ownerOrTriggerOnly = [
  'fn_process_hand_position_stats(jsonb,jsonb,jsonb)',
  'fn_process_hand_position_stats(uuid)',
  'sp_prune_hand_history(integer)',
  'fn_enqueue_hand_daily_missions()',
  'fn_fold_hand_winnings()',
  'trg_hand_history_position_stats()',
  'trg_ca_stats_live_from_hand()',
  'trg_hand_history_club_member_stats()',
];

describe('internal hand projection routines are least privilege', () => {
  it('makes projectors, maintenance wrappers and trigger bodies unreachable by every API role', () => {
    for (const signature of ownerOrTriggerOnly) {
      expect(SQL).toContain(
        `REVOKE ALL ON FUNCTION public.${signature}\n  FROM PUBLIC,anon,authenticated,service_role;`
      );
      expect(SQL).toContain(`'public.${signature}'`);
      expect(SQL).not.toContain(`GRANT EXECUTE ON FUNCTION public.${signature}`);
    }
    expect(SQL).toContain("FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role']");
    expect(SQL).toContain("has_function_privilege(v_role,v_signature,'EXECUTE')");
  });
});
