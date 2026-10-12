import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * 2026-10-07. fn_get_game_management_scale_health counted every
 * game_management_events row of its scope. The busiest union held 4,212,266
 * rows and the count took 38,111 ms, so the Game Management health strip timed
 * out on every load of that scope (47 of 171 statement timeouts in three
 * hours). The daily retention job deleted 5,000 rows a day against 200,000 to
 * 600,000 inserted. Both are pinned here so neither can drift back.
 */
const migration = readFileSync(
  'supabase/migrations/20261007102247_the_game_management_health_counts_what_it_can_read_in_time.sql',
  'utf8'
);

const scaleHealthBody = migration.slice(
  migration.indexOf('CREATE OR REPLACE FUNCTION public.fn_get_game_management_scale_health'),
  migration.indexOf('$function$;')
);

describe('the game management health read is bounded', () => {
  it('never counts an unbounded scope of game_management_events', () => {
    expect(scaleHealthBody).toMatch(/LIMIT 10001\) bounded/);
    expect(scaleHealthBody).not.toMatch(/count\(\*\) FROM public\.game_management_events WHERE/);
    expect(scaleHealthBody).toContain("'event_rows_capped',v_event_rows>10000");
  });

  it('reads the oldest event through the scope index, not min() over the scope', () => {
    expect(scaleHealthBody).toMatch(/ORDER BY e\.created_at ASC LIMIT 1/);
    expect(scaleHealthBody).not.toMatch(/min\(created_at\)/);
  });

  it('keeps the authorization gate that precedes every read', () => {
    expect(scaleHealthBody).toContain('fn_game_creation_access(p_scope_id)');
    expect(scaleHealthBody).toContain('fn_is_union_operator(p_scope_id,auth.uid())');
    expect(scaleHealthBody).toContain("'reason','not_authorized'");
  });

  it('runs the 30-day retention often enough to keep up, outside the break window', () => {
    const schedule = migration.match(/schedule := '([^']+)'/)?.[1];
    expect(schedule).toBe('7,17,27,37,47 * * * *');
    for (const minute of schedule!.split(' ')[0].split(',').map(Number)) {
      expect(minute >= 50 || minute <= 3).toBe(false);
    }
    expect(migration).toContain(
      "fn_prune_game_management_events(now() - interval '30 days', 10000)"
    );
  });

  it('the client marks a capped total as a lower bound', () => {
    const service = readFileSync('src/services/GameManagementService.ts', 'utf8');
    expect(service).toContain('eventRowsCapped: scale.event_rows_capped === true');
  });
});
