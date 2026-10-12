import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const source = readFileSync('src/components/club/ClubActivityFeed.tsx', 'utf8');
function loader(context: Record<string, unknown>) {
  const start = source.indexOf('const loadActivities = async');
  const end = source.indexOf('const getActivityIcon', start);
  const js = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(context), `${js}; return loadActivities;`)(
    ...Object.values(context)
  );
}
function context() {
  return {
    loadingRef: { current: false },
    requestVersionRef: { current: 0 },
    activeScopeRef: { current: 'club:5' },
    scopeKey: 'club:5',
    isMounted: { current: true },
    clubId: 'club',
    limit: 5,
    setLoading: vi.fn(),
    setLoadError: vi.fn(),
    setActivities: vi.fn(),
    setVisibleIds: vi.fn(),
    resolveClubUUID: vi.fn().mockResolvedValue('uuid'),
    isUUID: () => true,
    isAuthzError: () => false,
    reportError: vi.fn(),
    supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: '57014' } }) },
  };
}
describe('Club Activity truthful failed reads', () => {
  it('preserves the last loaded rows and marks a refresh failure', async () => {
    const ctx = context();
    await loader(ctx)(false);
    expect(ctx.setActivities).not.toHaveBeenCalled();
    expect(ctx.setLoadError).toHaveBeenCalledWith(true);
    expect(ctx.loadingRef.current).toBe(false);
    expect(source).toContain('Showing The Last Loaded Events.');
    expect(source).toContain('loadError ? null');
  });
  it('a retry accepts successful empty results and clears the failure state', async () => {
    const ctx = context();
    ctx.supabase.rpc.mockResolvedValue({ data: [], error: null });
    await loader(ctx)(false);
    expect(ctx.setActivities).toHaveBeenCalledWith([]);
    expect(ctx.setLoadError).toHaveBeenCalledWith(false);
    expect(source).toContain('onClick={() => void loadActivities(true)}');
  });
  it('ignores a delayed failure after a club switch', async () => {
    const ctx = context();
    let reject!: (error: unknown) => void;
    ctx.resolveClubUUID.mockImplementation(
      () =>
        new Promise((_, failed) => {
          reject = failed;
        })
    );
    const pending = loader(ctx)(true);
    ctx.activeScopeRef.current = 'other:5';
    reject(new Error('Network Failed'));
    await pending;
    expect(ctx.setLoadError).not.toHaveBeenCalled();
    expect(ctx.setActivities).not.toHaveBeenCalled();
  });
});
