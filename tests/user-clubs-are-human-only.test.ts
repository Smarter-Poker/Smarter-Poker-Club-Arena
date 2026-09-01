import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const sql = readFileSync(
  resolve(__dirname, '../supabase/migrations/20260902050000_user_clubs_are_human_only.sql'),
  'utf8'
);

describe('User-Created Clubs Are Human-Only', () => {
  it('allows automation only on the three platform house boards', () => {
    const houseFunction = sql.slice(
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_house_board_allows_automation'),
      sql.indexOf('CREATE OR REPLACE FUNCTION public.fn_ca_reject_automated_user_club_row')
    );
    expect(sql).toContain("'a41434bb-8d0c-400a-8f0d-e8b3d65afed4'::uuid");
    expect(sql).toContain("'a0000000-0000-0000-0000-000000000001'::uuid");
    expect(sql).toContain("'fade0000-0000-0000-0000-000000000001'::uuid");
    expect(houseFunction).not.toContain('2a1132b9-5ba2');
  });

  it('guards every automated-player database entry point', () => {
    expect(sql).toContain('trg_club_members_human_user_club_only');
    expect(sql).toContain('trg_agents_human_user_club_only');
    expect(sql).toContain('trg_table_seats_human_user_club_only');
    expect(sql).toContain('trg_tournament_players_human_user_club_only');
    expect(sql).toContain('AUTOMATED_PLAYER_HOUSE_BOARD_ONLY');
  });

  it('quarantines evidence and retires every contaminated balance', () => {
    expect(sql).toContain('club_members_automated_recurrence');
    expect(sql).toContain('agents_automated_recurrence');
    expect(sql).toContain('table_seats_automated_recurrence');
    expect(sql).toContain("'chip_retirement'");
    expect(sql).toContain('deep-stack-automated-recurrence:felt');
    expect(sql).toContain('SET chip_treasury = 98500');
  });

  it('keeps Drift Incidents inside Midway at the table boundary', () => {
    expect(sql).toContain('trg_ca_incidents_stay_in_midway');
    expect(sql).toContain('public.fn_ca_is_midway_scope(');
    expect(sql).toContain('SELECT public.fn_ca_supply_snapshot()');
  });
});
