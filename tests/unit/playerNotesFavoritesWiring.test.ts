import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const read = (path: string) => readFileSync(path, 'utf8');
it('opponent taps wire Notes, including when reactions are disabled', () => {
  const page = read('src/pages/TablePage.tsx');
  expect(page).toContain('else if (displayPlayer) setShowPlayerNotes(true)');
  expect(page).toMatch(
    /onOpenPlayerNotes=\{\(\) => \{\s*setShowThrowableSelector\(false\);\s*setShowPlayerNotes\(true\)/
  );
  const modals = read('src/components/table/TableModalsLayer.tsx');
  expect(modals).toContain('onOpenNotes={selectedPlayerForNotes ? onOpenPlayerNotes : undefined}');
  expect(modals).toContain('<PlayerNotesDialog');
});
it('the ranking only exposes catalog IDs for the authenticated player and uses committed usage', () => {
  const sql = read('supabase/migrations/20261031003808_player_throwable_favorites_ranking.sql');
  const catalog = [
    ...read('src/services/ThrowableService.ts').matchAll(/T\(\s*'([a-z0-9_]+)'/g),
  ].map((x) => x[1]);
  const ranked = [...sql.matchAll(/\('([a-z0-9_]+)'::text\)/g)].map((x) => x[1]);
  expect(ranked).toEqual(catalog);
  expect(sql).toContain('v_user uuid := auth.uid()');
  expect(sql).toContain('IF v_user IS NULL THEN');
  expect(sql).toContain('FILTER (WHERE tu.user_id = v_user)');
  expect(sql).toContain('coalesce(u.personal_count, 0) DESC');
  expect(sql).toContain('coalesce(u.global_count, 0) DESC, c.id');
  expect(sql).toContain('LIMIT 10');
  expect(sql).toContain('FROM PUBLIC, anon');
  expect(sql).toContain("SET search_path = ''");
});
it('runs the native ranking privacy fixture in the maintained database qualification', () => {
  expect(read('scripts/ci/test-data-console-postgres-contracts.sh')).toContain(
    'scripts/dev/test-player-throwable-favorites-postgres.sh'
  );
});
