/**
 * Observer card visibility is one end-to-end privacy contract. The column,
 * both authoritative readers, the engine reveal gate, and the transport
 * projection must move together or a harmless-looking refactor either leaks
 * cards or denies every table connection with a PostgREST unknown-column
 * error.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { sliceMethod } from '../helpers/sourceWindow';

const read = (path: string) => readFileSync(resolve(__dirname, '../../', path), 'utf8');
const MIGRATION = read(
  'supabase/migrations/20260908233950_observer_card_visibility_is_explicit.sql'
);
const TABLE_LOADER = read('server/src/services/supabase/tables.ts');
const VIEWER_ACCESS = read('server/src/services/TableViewerAccess.ts');
const HTTP_STATE = read('server/src/handlers/state.ts');
const ENGINE = read('server/src/engine/ServerTableEngine.ts');
const HUB = read('server/src/transport/TableStateHub.ts');

describe('observer card visibility schema', () => {
  it('creates a two-state boolean whose privacy default is false', () => {
    expect(MIGRATION).toMatch(
      /ALTER TABLE public\.tables\s+ADD COLUMN IF NOT EXISTS observer_show_cards boolean NOT NULL DEFAULT false;/
    );
    expect(MIGRATION).toMatch(
      /UPDATE public\.tables\s+SET observer_show_cards = false\s+WHERE observer_show_cards IS NULL;/
    );
    expect(MIGRATION).toContain('ALTER COLUMN observer_show_cards SET DEFAULT false');
    expect(MIGRATION).toContain('ALTER COLUMN observer_show_cards SET NOT NULL');
  });

  it('asserts its postimage without widening the tables ACL or disabling RLS', () => {
    expect(MIGRATION).toContain("v_type IS DISTINCT FROM 'boolean'::regtype");
    expect(MIGRATION).toContain('a.attnotnull');
    expect(MIGRATION).toContain("v_default IS DISTINCT FROM 'false'");
    expect(MIGRATION.match(/relrowsecurity/g)).toHaveLength(2);
    expect(MIGRATION).not.toMatch(/\b(?:GRANT|REVOKE)\b/);
    expect(MIGRATION).not.toContain('DISABLE ROW LEVEL SECURITY');
  });
});

describe('observer card visibility reader wiring', () => {
  it('is loaded into the engine and the independent viewer authorization read', () => {
    expect(sliceMethod(TABLE_LOADER, 'export async function loadTable(')).toContain(
      'observer_show_cards'
    );
    expect(sliceMethod(VIEWER_ACCESS, 'export async function authorizeTableViewer(')).toContain(
      'observer_show_cards'
    );
  });

  it('treats only a literal true as observer permission', () => {
    expect(sliceMethod(VIEWER_ACCESS, 'export async function authorizeTableViewer(')).toContain(
      'table.observer_show_cards === true'
    );
    expect(sliceMethod(VIEWER_ACCESS, 'export function viewerCanSeeTabledCards(')).toContain(
      'access.observerShowCards === true'
    );
  });

  it('keeps observer visibility bounded to tabled showdown or all-in-runout cards', () => {
    const observerState = sliceMethod(ENGINE, 'public getObserverState()');
    const broadcastState = sliceMethod(ENGINE, 'protected broadcastCurrentState()');
    expect(observerState).toContain("state.stage === 'showdown' || this.runoutRevealActive");
    expect(broadcastState).toContain("state.stage === 'showdown' || this.runoutRevealActive");
    expect(observerState).toContain('!p.is_folded');
    expect(observerState).toContain('!this.isMuckedAtShowdown(p.user_id)');
  });

  it('keeps the HTTP and WebSocket surfaces on one fail-closed projector', () => {
    expect(HUB).toContain('export function projectTableStateForViewer(');
    expect(HUB).toContain("sub.viewerRole === 'observer' && sub.observerShowCards === true");
    expect(HUB).toContain('projectTableStateForViewer(room.lastSnapshot');
    expect(sliceMethod(HTTP_STATE, 'export async function handleGetState(')).toContain(
      'engine.getObserverState!()'
    );
  });
});
