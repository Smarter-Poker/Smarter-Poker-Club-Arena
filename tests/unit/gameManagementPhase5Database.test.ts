import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(
    __dirname,
    '../../supabase/migrations/20260902200000_game_management_content_commands_are_safe.sql'
  ),
  'utf8'
);

describe('Table Management Phase 5 database contract', () => {
  it('ships the complete DDL as one schema-cache-coalescing transaction', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;[\s\S]*\nCOMMIT;\s*$/);
  });

  it('adds positive revisions to ticker, identity, and announcement authority', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1');
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS message_revision bigint NOT NULL DEFAULT 1'
    );
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS management_revision bigint NOT NULL DEFAULT 1'
    );
    expect(migration).toContain("'reason', 'version_conflict'");
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain("'ticker:club:' || p_scope_id::text");
    expect(migration).toContain("'ticker:union:' || p_scope_id::text");
  });

  it('makes unversioned browser writes impossible', () => {
    for (const signature of [
      'fn_save_game_ticker_settings(text, uuid, jsonb)',
      'fn_save_club_identity_messages(uuid, text, text, text)',
      'fn_manage_club_announcement(text, uuid, uuid, text, text, boolean, boolean)',
    ]) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${signature}`);
    }
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('TO service_role');
  });

  it('guards hostile ticker JSON before every cast', () => {
    expect(migration).toContain("jsonb_typeof(p_settings) <> 'object'");
    expect(migration).toContain("jsonb_typeof(p_settings->'enabled') <> 'boolean'");
    expect(migration).toContain("jsonb_typeof(p_settings->'sources') <> 'object'");
    expect(migration).toContain("jsonb_typeof(p_settings->'custom_messages') <> 'array'");
    expect(migration).toContain('jsonb_array_length');
    expect(migration).toContain("jsonb_array_elements_text(p_settings->'custom_messages')");
    expect(migration).not.toContain("trim(both '\"' from item::text)");
    expect(migration).toContain('invalid_messages');
  });

  it('enforces text and accent contrast at the command boundary', () => {
    expect(migration).toContain('fn_game_management_contrast_ratio');
    expect(migration).toContain('< 4.5');
    expect(migration).toContain('< 3.0');
    expect(migration).toContain('inaccessible_colors');
  });

  it('keeps every new definer behind a fixed search path and explicit grants', () => {
    const definers = migration.match(/SECURITY DEFINER/g) || [];
    const paths = migration.match(/SECURITY DEFINER\nSET search_path TO 'public'/g) || [];
    expect(definers.length).toBeGreaterThanOrEqual(5);
    expect(paths).toHaveLength(definers.length);
    expect(migration).toContain('TO authenticated, service_role');
  });
});
