import { beforeEach, expect, it, vi } from 'vitest';
const remote = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  writes: [] as any[],
  fail: false,
  read: null as Promise<any> | null,
}));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => {
        const terms: Record<string, string> = {};
        const query = {
          eq: (key: string, value: string) => {
            terms[key] = value;
            return query;
          },
          maybeSingle: () =>
            remote.read ??
            Promise.resolve({
              data: remote.rows.has(`${terms.user_id}/${terms.preference_key}`)
                ? { value: remote.rows.get(`${terms.user_id}/${terms.preference_key}`) }
                : null,
              error: null,
            }),
        };
        return query;
      },
      upsert: async (row: any) => {
        remote.writes.push(row);
        if (remote.fail) return { error: new Error('offline') };
        remote.rows.set(`${row.user_id}/${row.preference_key}`, row.value);
        return { error: null };
      },
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import {
  defaultRosterWorkspace,
  loadRosterWorkspace,
  readRosterWorkspace,
  writeRosterWorkspace,
} from '../../src/lib/rosterWorkspace';
import { readTableSettingIntent } from '../../src/lib/tableSettingIntents';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  remote.rows.clear();
  remote.writes = [];
  remote.fail = false;
  remote.read = null;
});
it('restores the complete account workspace on an empty second device without writing defaults or exposing another account', async () => {
  const workspace = {
    ...defaultRosterWorkspace(),
    search: 'Ada',
    filter: 'online' as const,
    sort: 'fees' as const,
    columns: ['fees'] as const,
  };
  const chosen = { ...workspace, columns: [...workspace.columns] };
  expect(await loadRosterWorkspace('roster-a', 'club-x')).toEqual(defaultRosterWorkspace());
  writeRosterWorkspace('roster-a', 'club-x', defaultRosterWorkspace());
  expect(remote.writes).toHaveLength(0);
  writeRosterWorkspace('roster-a', 'club-x', chosen);
  await vi.waitFor(() =>
    expect(remote.rows.get('roster-a/roster:workspace:club-x')).toEqual(chosen)
  );
  sessionStorage.clear();
  localStorage.clear();
  expect(await loadRosterWorkspace('roster-a', 'club-x')).toEqual(chosen);
  expect(await loadRosterWorkspace('roster-b', 'club-x')).toEqual(defaultRosterWorkspace());
  expect(await loadRosterWorkspace('roster-a', 'club-y')).toEqual(defaultRosterWorkspace());
  expect(remote.writes).toHaveLength(1);
});
it('retains the original failed account write through logout and restores it on that account only', async () => {
  const chosen = { ...defaultRosterWorkspace(), search: 'Pending', sort: 'wallet' as const };
  await loadRosterWorkspace('roster-c', 'club-x');
  remote.fail = true;
  writeRosterWorkspace('roster-c', 'club-x', chosen);
  await vi.waitFor(() => expect(remote.writes).toHaveLength(1));
  expect(readTableSettingIntent('roster-c', 'page:roster:workspace:club-x')?.value).toEqual(chosen);
  expect(await loadRosterWorkspace('roster-d', 'club-x')).toEqual(defaultRosterWorkspace());
  remote.fail = false;
  expect(await loadRosterWorkspace('roster-c', 'club-x')).toEqual(chosen);
  await vi.waitFor(() =>
    expect(remote.rows.get('roster-c/roster:workspace:club-x')).toEqual(chosen)
  );
  await vi.waitFor(() =>
    expect(readTableSettingIntent('roster-c', 'page:roster:workspace:club-x')).toBeNull()
  );
});
it('an older server workspace cannot replace a newer gesture while loading', async () => {
  let resolve!: (value: any) => void;
  remote.read = new Promise((done) => {
    resolve = done;
  });
  const load = loadRosterWorkspace('roster-e', 'club-x');
  const chosen = { ...defaultRosterWorkspace(), search: 'Newest' };
  writeRosterWorkspace('roster-e', 'club-x', chosen);
  resolve({ data: { value: { ...defaultRosterWorkspace(), search: 'Old' } }, error: null });
  expect(await load).toEqual(chosen);
  expect(readRosterWorkspace('roster-e', 'club-x')).toEqual(chosen);
});
