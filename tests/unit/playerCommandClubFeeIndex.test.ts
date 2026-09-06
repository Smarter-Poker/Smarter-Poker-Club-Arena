import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATION = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260906110500_player_command_fees_seek_by_club.sql'
  ),
  'utf8'
);
const CLUB_SCOPING = readFileSync(
  resolve(__dirname, '../../supabase/migrations/20260901090000_club_card_human_realtime_stats.sql'),
  'utf8'
);

describe('Player Command current-club fee performance law', () => {
  it('keeps the authoritative roster fee source scoped to the selected club', () => {
    expect(CLUB_SCOPING).toContain('FROM public.ca_hand_facts r');
    expect(CLUB_SCOPING).toContain('WHERE r.club_id = p_club_id');
    expect(CLUB_SCOPING).toContain(
      "RAISE EXCEPTION 'Player Command still exposes an unscoped financial source'"
    );
  });

  it('provides a non-blocking club-first covering seek for that aggregate', () => {
    expect(MIGRATION).toContain(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS ca_hand_facts_club_user_roster_idx'
    );
    expect(MIGRATION).toContain('ON public.ca_hand_facts (club_id, user_id)');
    expect(MIGRATION).toContain('INCLUDE (hand_id, rake_paid)');
    expect(MIGRATION).toContain('WHERE club_id IS NOT NULL');
  });

  it('fails deployment closed if the index is not ready and valid', () => {
    expect(MIGRATION).toContain("c.relname = 'ca_hand_facts_club_user_roster_idx'");
    expect(MIGRATION).toContain('i.indisvalid');
    expect(MIGRATION).toContain('i.indisready');
    expect(MIGRATION).toContain(
      "RAISE EXCEPTION 'ca_hand_facts_club_user_roster_idx is missing or invalid'"
    );
  });
});
