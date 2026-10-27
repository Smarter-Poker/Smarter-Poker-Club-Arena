import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20261027144913_lightning_retains_the_anchor_until_every_original_hand_is_te.sql',
  'utf8'
);
const workflow = readFileSync(
  '.github/workflows/lightning-hand-counts-every-player-dealt-in.yml',
  'utf8'
);

describe('Lightning original-hand departure ownership', () => {
  it('changes both departure readers while retaining exact source guards', () => {
    expect(migration).toContain(
      'public.fn_lightning_player_live_hand(v_uid, p_cluster_id) IS NOT NULL'
    );
    expect(migration).toContain(
      'public.fn_lightning_player_live_hand(s.player_id, s.cluster_id) IS NOT NULL'
    );
    expect(migration).toContain('md5(definition) IS DISTINCT FROM item.expected_md5');
    expect(migration).not.toMatch(
      /UPDATE public\.(?:table_seats|cash_games|lightning_hand)|CREATE OR REPLACE FUNCTION public\.fn_lightning_settle_hand/
    );
  });

  it('runs the real PostgreSQL regression when its source or migration changes', () => {
    expect(workflow).toContain(
      'supabase/migrations/*_lightning_retains_the_anchor_until_every_original_hand_is_te.sql'
    );
    expect(workflow).toContain('- scripts/ci/test-lightning-unsettled-anchor-exit.py');
    expect(workflow).toContain('run: python3 scripts/ci/test-lightning-unsettled-anchor-exit.py');
    expect(workflow).toContain('path: artifacts/lightning-unsettled-anchor/RESULTS.json');
  });
});
