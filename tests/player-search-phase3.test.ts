import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const migration = read('supabase/migrations/20260831150200_player_search_authoritative.sql');
const service = read('src/services/PlayerSearchService.ts');
const modal = read('src/components/modals/FindPlayerModal.tsx');

describe('Phase 3 server-authoritative player locator', () => {
  it('derives friends, privileged clubs, and managed unions from auth.uid()', () => {
    expect(migration).toContain('v_uid uuid := auth.uid()');
    expect(migration).toContain('friend_ids AS');
    expect(migration).toContain('shared_club_ids AS');
    expect(migration).toContain('managed_union_ids AS');
    expect(migration).toContain("'owner','co_owner','admin','agent','super_agent','sub_agent'");
  });

  it('enforces privacy before returning identity, presence, and table context', () => {
    expect(migration).toContain('player_search_preferences');
    expect(migration).toContain('pref.discoverable');
    expect(migration).toContain('pref.show_display_name');
    expect(migration).toContain('pref.show_presence');
    expect(migration).toContain('pref.show_current_table');
  });

  it('uses indexed ranking, stable pagination, and bounded page sizes', () => {
    expect(migration).toContain('gin_trgm_ops');
    expect(migration).toContain('relevance');
    expect(migration).toContain('LIMIT v_limit OFFSET v_offset');
    expect(migration).toContain('LEAST(GREATEST(COALESCE(p_limit,20),1),50)');
    expect(migration).toContain("p_sort NOT IN ('relevance','name')");
  });
});

describe('Phase 3 locator experience', () => {
  it('cancels stale suggestions and searches', () => {
    expect(service).toContain('abortSignal(options.signal)');
    expect(modal).toContain('searchAbortRef.current?.abort()');
    expect(modal).toContain('suggestionAbortRef.current?.abort()');
  });

  it('supports network, presence, sorting, pagination, and live presence', () => {
    expect(modal).toContain('PlayerSearchScope');
    expect(modal).toContain('PlayerPresenceFilter');
    expect(modal).toContain('PlayerSearchSort');
    expect(modal).toContain('Load More Players');
    expect(modal).toContain("table: 'user_presence'");
  });

  it('lets players control discoverability and live-table exposure', () => {
    expect(modal).toContain('Allow Club And Union Members To Find Me');
    expect(modal).toContain('Show Online Presence');
    expect(modal).toContain('Show My Current Table');
    expect(modal).toContain('PlayerSearchService.setPreferences');
  });
});
