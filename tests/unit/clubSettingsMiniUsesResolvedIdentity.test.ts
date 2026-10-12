import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const source = readFileSync('src/pages/ClubSettingsPage.tsx', 'utf8');
const expression = source.match(/const clubUUID =\s*([^;]+);/)![1];
const resolvedForRoute = new Function('resolvedClubIdentity', 'clubId', `return ${expression};`);

describe('Settings Mini Jackpot feed identity', () => {
  it('passes the loaded database UUID to the UUID-only Mini feed on a slug route', () => {
    const uuid = 'a41434bb-8d0c-400a-8f0d-e8b3d65afed4';
    expect(resolvedForRoute({ route: 'shark-club', uuid }, 'shark-club')).toBe(uuid);
    expect(source).toContain('<BBJMiniPanel clubId={clubUUID}');
    expect(source).not.toContain('<BBJMiniPanel clubId={clubId}');
    expect(source).toContain('setResolvedClubIdentity({ route: clubId!, uuid: data.id })');
  });
  it('does not start the previous club feed while another route identity is loading', () => {
    expect(
      resolvedForRoute({ route: 'shark-club', uuid: 'previous-uuid' }, 'another-club')
    ).toBeNull();
    expect(resolvedForRoute(null, 'shark-club')).toBeNull();
    expect(resolvedForRoute(null, undefined)).toBeNull();
  });
});

describe('Settings async route isolation', () => {
  it('does not apply an old club response while the component remains mounted', async () => {
    const start = source.indexOf('const loadClubSettings = async');
    const end = source.indexOf('const saveSettings', start);
    const js = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let settle!: (data: unknown) => void;
    const activeSettingsScopeRef = { current: 'shark-club:operator' };
    const settingsReadVersionRef = { current: 0 };
    const setSettings = vi.fn();
    const setResolvedClubIdentity = vi.fn();
    const setLoading = vi.fn();
    const context = {
      clubId: 'shark-club',
      settingsScope: 'shark-club:operator',
      loadingRef: { current: false },
      activeSettingsScopeRef,
      settingsReadVersionRef,
      resolveClubIdFilter: () => ({ column: 'slug', value: 'shark-club' }),
      retryFetch: () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
      setSettings,
      setResolvedClubIdentity,
      setLoading,
    };
    const load = new Function(...Object.keys(context), `${js}; return loadClubSettings;`)(
      ...Object.values(context)
    );
    const pending = load(() => true, { silent: true });
    activeSettingsScopeRef.current = 'another-club:operator';
    settingsReadVersionRef.current += 1;
    settle({ id: 'previous-club', name: 'Previous Club', owner_id: 'operator' });
    await pending;
    expect(setSettings).not.toHaveBeenCalled();
    expect(setResolvedClubIdentity).not.toHaveBeenCalled();
    expect(setLoading).not.toHaveBeenCalled();
    expect(context.loadingRef.current).toBe(true);
  });
});
