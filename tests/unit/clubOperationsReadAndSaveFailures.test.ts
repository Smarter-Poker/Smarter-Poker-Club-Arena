import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

// Execute the maintained handler itself so error receipts are exercised rather
// than merely checking that its source contains an error branch.
function handler(file: string, name: string, next: string, context: Record<string, unknown>) {
  const source = readFileSync(`src/pages/${file}`, 'utf8');
  const start = source.indexOf(`const ${name} = async`);
  const end = source.indexOf(next, start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(...Object.keys(context), `${js}; return ${name};`)(...Object.values(context));
}

describe('Club Operations failure receipts', () => {
  it('releases the Rules save controls when the database returns no stored row', async () => {
    const setSaving = vi.fn();
    const toast = { error: vi.fn(), success: vi.fn() };
    const save = handler('ClubRulesPage.tsx', 'handleSave', '/* THE CONSOLE', {
      clubId: 'club-a',
      setSaving,
      toast,
      resolveClubUUIDStrict: vi.fn().mockResolvedValue('uuid-a'),
      sanitizeInput: (text: string) => text,
      editValue: 'Rules',
      supabase: {
        rpc: vi.fn(() => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }) })),
      },
      reportError: vi.fn(),
    });
    await save();
    expect(setSaving.mock.calls).toEqual([[true], [false]]);
    expect(toast.error).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows announcement read failure instead of claiming an empty live feed', async () => {
    const failure = { code: '42501', message: 'permission denied' };
    const request: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'order']) request[method] = () => request;
    request.maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    request.limit = vi.fn().mockResolvedValue({ data: null, error: failure });
    const setLoadError = vi.fn();
    const setLoading = vi.fn();
    const reportError = vi.fn();
    const toast = { error: vi.fn() };
    const load = handler('ClubAnnouncementsPage.tsx', 'loadAnnouncements', 'const handlePost', {
      clubId: 'club-a',
      user: null,
      loadingRef: { current: false },
      setLoadError,
      setLoading,
      resolveClubUUID: vi.fn().mockResolvedValue('uuid-a'),
      sessionStorage: { getItem: () => null },
      supabase: { from: () => request },
      reportError,
      toast,
    });
    await load();
    expect(setLoadError.mock.calls).toEqual([[false], [true]]);
    expect(reportError).toHaveBeenCalledWith(
      failure,
      'ClubAnnouncementsPage.Failed_to_load_announcements'
    );
    expect(toast.error).toHaveBeenCalledOnce();
    expect(setLoading).toHaveBeenLastCalledWith(false);
  });
});

describe('Blacklist scope isolation', () => {
  it('ignores a club read that settles after navigation to another club', async () => {
    const source = readFileSync('src/pages/BlacklistManagerPage.tsx', 'utf8');
    const start = source.indexOf('const loadEntries = useCallback(');
    const end = source.indexOf('  useEffect(() => {\n    void loadEntries()', start);
    const maintained = source
      .slice(start, end)
      .replace('useCallback(', '(')
      .replace('}, [clubId, scopeKey]);', '});');
    const js = ts.transpileModule(maintained, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let settle!: (value: unknown) => void;
    const response = new Promise((resolve) => {
      settle = resolve;
    });
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq']) query[method] = () => query;
    query.order = () => response;
    const activeScopeRef = { current: 'club-a:operator' };
    const setEntries = vi.fn();
    const context = {
      clubId: 'club-a',
      scopeKey: 'club-a:operator',
      activeScopeRef,
      readVersionRef: { current: 0 },
      setEntries,
      setLoading: vi.fn(),
      setError: vi.fn(),
      setLoadFailed: vi.fn(),
      resolveClubUUID: vi.fn().mockResolvedValue('uuid-a'),
      supabase: { from: () => query },
      safeErrorMessage: () => 'Failed',
    };
    const load = new Function(...Object.keys(context), `${js}; return loadEntries;`)(
      ...Object.values(context)
    );
    const pending = load();
    await Promise.resolve();
    activeScopeRef.current = 'club-b:operator';
    settle({ data: [{ id: 'a-exclusion' }], error: null });
    await pending;
    expect(setEntries).not.toHaveBeenCalled();
  });
  it('does not submit an exclusion after the club changes while resolving its identifier', async () => {
    let resolve!: (id: string) => void;
    const activeScopeRef = { current: 'club-a:operator' };
    const insert = vi.fn();
    const context = {
      clubId: 'club-a',
      user: { id: 'operator' },
      scopeKey: 'club-a:operator',
      activeScopeRef,
      newUserId: 'selected-a',
      newReason: 'Reviewed',
      newExpiry: '',
      setAdding: vi.fn(),
      setError: vi.fn(),
      setLoadFailed: vi.fn(),
      resolveClubUUID: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
      supabase: { from: () => ({ insert }) },
      safeErrorMessage: () => 'Failed',
    };
    const add = handler('BlacklistManagerPage.tsx', 'handleAdd', 'const handleRemove', context);
    const pending = add({ preventDefault: vi.fn() });
    activeScopeRef.current = 'club-b:operator';
    resolve('uuid-a');
    await pending;
    expect(insert).not.toHaveBeenCalled();
    expect(context.setAdding.mock.calls).toEqual([[true]]);
  });
});
