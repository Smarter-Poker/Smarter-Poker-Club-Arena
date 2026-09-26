import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(__dirname, `../../${path}`), 'utf8');
const migration = read(
  'supabase/migrations/20260902170000_game_management_realtime_and_observability.sql'
);
const globalSync = read('src/services/PostgresSyncHooks.ts');
const page = read('src/pages/GameManagementPage.tsx');
const ticker = read('src/components/club/TickerManagementPanel.tsx');
const messages = read('src/components/club/ClubMessageManagementPanel.tsx');

describe('Table Management realtime and observability architecture', () => {
  it('uses one compact append-only feed with scoped and recipient indexes', () => {
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS public.game_management_events');
    expect(migration).toContain('trg_game_management_events_append_only');
    expect(migration).toContain('idx_game_management_events_scope');
    expect(migration).toContain('idx_game_management_events_recipient');
    expect(migration).toContain('ALTER PUBLICATION supabase_realtime ADD TABLE');
    expect(migration).toMatch(/BEGIN;[\s\S]*COMMIT;/);
  });

  it('fails cleanly instead of pre-locking busy gameplay tables into a deadlock cycle', () => {
    expect(migration).toContain("SET LOCAL lock_timeout = '30s'");
    expect(migration).not.toContain('LOCK TABLE public.tables');
    expect(migration).not.toContain('LOCK TABLE public.tournaments');
  });

  it('authorizes current operators and still delivers targeted revocations', () => {
    expect(migration).toContain('recipient_id = auth.uid()');
    expect(migration).toContain('public.fn_can_create_games(scope_id, auth.uid())');
    expect(migration).toContain('public.fn_is_union_operator(scope_id, auth.uid())');
    expect(migration).toContain('trg_club_members_emit_management_access');
    expect(migration).toContain('trg_union_admins_emit_management_access');
    expect(migration).toContain('trg_union_clubs_emit_management_access');
    expect(migration).toContain('trg_club_union_emit_management_access');
    expect(migration).toContain('trg_union_owner_emit_management_access');
    expect(globalSync).toContain('filter: `recipient_id=eq.${userId}`');
    expect(globalSync).toContain("masterBus.emit('GAME_MANAGEMENT_ACCESS_CHANGED'");
  });

  it('refreshes every management surface through named events from the visible feed', () => {
    expect(page).toContain('useGameManagementRealtime');
    expect(page).toContain("['GAME_MANAGEMENT_ACCESS_CHANGED']");
    expect(ticker).toContain("'TICKER_SETTINGS_CHANGED'");
    expect(messages).toContain("['CLUB_UPDATED', 'ANNOUNCEMENT_CHANGED']");
    expect(page).not.toMatch(/setInterval/);
  });

  it('records command outcomes and exposes bounded operator health', () => {
    expect(migration).toContain('INSERT INTO public.audit_trail');
    expect(migration).toContain('managed_game_');
    expect(migration).toContain('public.fn_get_game_management_health');
    expect(migration).toContain("v_access->>'union_id' IS NULL");
    expect(migration).toContain("interval '5 minutes'");
    expect(page).toContain('Integrity Alerts');
    expect(page).toContain('Commands / 24h');
  });
});
