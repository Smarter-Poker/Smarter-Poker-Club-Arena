import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const migrationName = readdirSync(join(root, 'supabase/migrations')).find((name) =>
  name.endsWith('_stage_b_current_postimage_contraction.sql')
);
if (!migrationName) throw new Error('tournament move authority contraction is missing');

const contraction = read(`supabase/migrations/${migrationName}`);
const runtime = read('server/src/tournament/tournamentSeatMoveRpc.ts');

describe('tournament seat movement has one mutation authority', () => {
  it('contracts the abandoned writer instead of publishing a second endpoint', () => {
    expect(contraction).not.toContain(
      'CREATE OR REPLACE FUNCTION public.fn_move_tournament_player_atomic'
    );
    expect(contraction).toContain(
      'DROP FUNCTION IF EXISTS public.fn_move_tournament_player_atomic'
    );
    expect(contraction).toContain(
      "'public.fn_move_tournament_player(uuid,uuid,uuid,uuid,integer,uuid,text)'"
    );
    expect(contraction).toContain('v_move_function_count<>1');
    expect(contraction).toContain(
      "p.proname IN ('fn_move_tournament_player',\n                       'fn_move_tournament_player_atomic')"
    );
  });

  it('preserves the canonical immutable receipt and read-only resolver contract', () => {
    expect(contraction).toContain("'request_id:uuid:not-null'");
    expect(contraction).toContain("'source_mode:text:not-null'");
    expect(contraction).toContain(
      String.raw`v_resolver_source ~* '\m(INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\M'`
    );
    expect(contraction).toContain('tournament_seat_move_receipts_append_only');
    expect(contraction).toContain('idx_tournament_players_one_active_destination_pointer');
    expect(contraction).toContain("NOT has_function_privilege(\n       'service_role'");
  });

  it('fences exactly the endpoint the runtime calls', () => {
    expect(runtime).toContain("supabase.rpc('fn_move_tournament_player', request)");
    expect(runtime).not.toContain("rpc('fn_move_tournament_player_atomic'");
    expect(contraction).toContain("'rpc/fn_move_tournament_player'");
    expect(contraction).not.toContain("'rpc/fn_move_tournament_player_atomic'");
  });
});
