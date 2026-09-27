/**
 * fn_search_players has been replaced from stale branch-local bodies before.
 * Read migrations in the order Supabase applies them and inspect the final
 * complete definition, rather than blessing an earlier migration that a later
 * file silently overwrites.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from '../helpers/migrationCorpus';

const DIRECT_DEFINITION = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_search_players\s*\(/i;
const EFFECTIVE_TOUCH =
  /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_search_players|proname\s*=\s*'fn_search_players'/i;

function finalDefinition(): { name: string; body: string; lastTouch: string } {
  const migrations = migrationCorpus();
  const definitions = migrations.filter(({ sql }) => DIRECT_DEFINITION.test(sql));
  const final = definitions.at(-1);
  expect(final, 'no migration directly defines public.fn_search_players').toBeDefined();
  const lastTouch = migrations.filter(({ sql }) => EFFECTIVE_TOUCH.test(sql)).at(-1);
  expect(lastTouch, 'no migration creates or rewrites public.fn_search_players').toBeDefined();

  const body = final!.sql.match(
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_search_players\s*\([\s\S]*?AS\s+\$fn\$([\s\S]*?)\$fn\$;/i
  )?.[1];
  expect(body, `${final!.name} does not contain a complete $fn$ definition`).toBeTruthy();
  return { name: final!.name, body: body!, lastTouch: lastTouch!.name };
}

describe('fn_search_players final migration-order contract', () => {
  const final = finalDefinition();

  it('is restored by a forward migration after every older replacement', () => {
    expect(final.name).toMatch(
      /^20260927\d{6}_restore_final_player_search_fuzzy_affiliations_contract\.sql$/
    );
    expect(final.lastTouch).toBe(final.name);
  });

  it('keeps indexed trigram matching and tells the client when fuzzy matching ran', () => {
    expect(final.body).toContain('v_fuzzy := length(v_query) >= 3');
    expect(final.body).toContain('lower(p.username) % v_query');
    expect(final.body).toContain('similarity(lower(p.username), v_query)');
    expect(final.body).toMatch(/'match_score',\s*round\(/);
    expect(final.body).toContain("'fuzzy', v_fuzzy");
  });

  it('returns the affiliation object consumed by PlayerSearchService', () => {
    expect(final.body).toMatch(/'affiliations',\s*affiliations/);
    expect(final.body).toMatch(/'clubs',\s*coalesce\(af\.clubs/);
    expect(final.body).toMatch(/'unions',\s*coalesce\(af\.unions/);
    expect(final.body).toMatch(/'has_hidden',\s*coalesce\(af\.has_hidden/);
    expect(final.body).not.toMatch(/'role',\s*cr\.role/);
  });

  it('keeps discovery global while enforcing the independent privacy controls', () => {
    expect(final.body).not.toContain('pref_discoverable');
    expect(final.body).toContain('pref_show_display_name');
    expect(final.body).toMatch(/'display_name',\s*CASE/);
    expect(final.body).toContain("relationship IN ('self', 'friend')");
  });

  it('only returns live, correctly-owned tournament tables in stable page order', () => {
    expect(final.body).toContain('t.id = tp.table_id AND t.tournament_id = tr.id');
    expect(final.body).toContain("lower(coalesce(t.status::text, '')) IN");
    expect(final.body).toContain('coalesce(t.is_deleted, false) = false');
    expect(final.body).toMatch(/jsonb_agg\([\s\S]*ORDER BY page_ordinal\)/);
  });

  it('does not shed the safeguards added after the original fuzzy migration', () => {
    expect(final.body).toContain('public.fn_arena_name(');
    expect(final.body).toContain('player_search_preferences');
    expect(final.body).toContain('viewer_seated');
    expect(final.body).toContain('v_like');
    expect(final.body).not.toContain('hidden_count');
    expect(final.body).not.toContain('c.is_private');
  });
});
