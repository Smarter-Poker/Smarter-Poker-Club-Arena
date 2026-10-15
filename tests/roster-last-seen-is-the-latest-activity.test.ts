import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Player Management showed "Seen 7mo Ago" for players who had just left a
// table: activity was coalesce(last_login, last_seen, ...), which returns the
// first non-null value (a months-old sign-in), not the latest one.
const sql = readFileSync(
  resolve(
    import.meta.dirname,
    '../supabase/migrations/20261015093645_roster_last_seen_is_the_latest_activity_not_the_oldest_login.sql'
  ),
  'utf8'
);

describe('roster last seen', () => {
  it('reports the latest of login, presence and member activity', () => {
    expect(sql).toContain("v_new := 'greatest(pr.last_login, pr.last_seen, b.m_last_active_at)'");
    expect(sql).toContain("v_new := 'greatest(pr.last_login, pr.last_seen)'");
    expect(sql).toMatch(/@live-proof: .*greatest/);
  });
});
