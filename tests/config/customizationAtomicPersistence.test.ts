import { readFileSync } from 'node:fs';

const migration = readFileSync(
  'supabase/migrations/20260830070000_customization_atomic_persistence.sql',
  'utf8'
);
const interfaceWriter = readFileSync('src/lib/persistInterfaceTheme.ts', 'utf8');
const collections = readFileSync('src/hooks/useTableStudioCollections.ts', 'utf8');

describe('customization persistence remains correct across devices', () => {
  it('patches only profiles.settings.theme inside the database transaction', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.fn_set_interface_theme');
    expect(migration).toMatch(/SET settings = jsonb_set\([\s\S]{0,220}'\{theme\}'/);
    expect(migration).toContain("p_theme IN ('light', 'dark')");
    expect(interfaceWriter).toContain("supabase.rpc('fn_set_interface_theme'");
    expect(interfaceWriter).not.toContain(".select('settings')");
  });

  it('mutates favorites and loadout slots atomically instead of replacing another device snapshot', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_mutate_table_studio_preferences'
    );
    expect(migration).toContain('array_remove');
    expect(migration).toContain('jsonb_set');
    expect(migration).toContain('revision = p.revision + 1');
    expect(collections).toMatch(/supabase\.rpc\([\s\S]{0,80}'fn_mutate_table_studio_preferences'/);
  });

  it('seeds a first cloud row without overwriting a row concurrently created elsewhere', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_seed_table_studio_preferences'
    );
    expect(migration).toContain('ON CONFLICT (user_id) DO NOTHING');
    expect(collections).toContain("supabase.rpc('fn_seed_table_studio_preferences'");
  });
});
