import { supabase } from './supabase';
import {
  awaitPreferenceSave,
  beginTableSettingIntent,
  confirmTableSettingIntent,
  orderTableSettingWrite,
  readTableSettingIntent,
} from './tableSettingIntents';
import { reportError } from '../utils/errorReporter';
import { rosterSearchKey } from './rosterCache';
import type { RosterFilter, RosterSort } from '../services/ClubRosterService';

export type RosterColumn = 'downlines' | 'wallets' | 'fees' | 'activity';
export interface RosterWorkspace {
  search: string;
  filter: RosterFilter;
  sort: RosterSort;
  columns: RosterColumn[];
}
export interface RosterReturnPosition {
  version: 1;
  entryKey: string;
  workspace: RosterWorkspace;
  viewportTop: number;
  windowTop: number;
}
const workspaceRevisions = new Map<string, number>();
const FILTERS = [
  'all',
  'mine',
  'seated',
  'online',
  'agents',
  'admins',
  'inactive_30',
  'inactive_60',
  'inactive_90',
  'high_fees',
];
const SORTS = ['newest', 'oldest', 'hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees'];
export const ROSTER_COLUMNS: RosterColumn[] = ['downlines', 'wallets', 'fees', 'activity'];
export const ROSTER_ROW_HEIGHT = 123;
export const MAX_ROSTER_RETURN_TOP = ROSTER_ROW_HEIGHT * 10_000;
/* Fees lead, wallets are opt-in: Player Management always shows fees
   generated, never a wallet balance by default (Dan, 2026-10-14). */
export const DEFAULT_ROSTER_COLUMNS: RosterColumn[] = ['fees', 'downlines', 'activity'];
export function defaultRosterWorkspace(): RosterWorkspace {
  return { search: '', filter: 'all', sort: 'newest', columns: [...DEFAULT_ROSTER_COLUMNS] };
}
export function rosterWorkspaceKey(viewer: string, club: string): string {
  return `roster_workspace_v1_${encodeURIComponent(viewer)}_${encodeURIComponent(club)}`;
}
export function rosterPositionKey(viewer: string, club: string): string {
  return `roster_position_v1_${encodeURIComponent(viewer)}_${encodeURIComponent(club)}`;
}
function decodeWorkspace(value: unknown): RosterWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.search !== 'string' ||
    v.search.length > 120 ||
    typeof v.filter !== 'string' ||
    !FILTERS.includes(v.filter) ||
    typeof v.sort !== 'string' ||
    !SORTS.includes(v.sort) ||
    !Array.isArray(v.columns) ||
    v.columns.length > ROSTER_COLUMNS.length ||
    !v.columns.every((c) => ROSTER_COLUMNS.includes(c)) ||
    new Set(v.columns).size !== v.columns.length
  )
    return null;
  return {
    search: v.search,
    filter: v.filter as RosterFilter,
    sort: v.sort as RosterSort,
    columns: [...v.columns] as RosterColumn[],
  };
}
export function readRosterWorkspace(viewer: string, club: string): RosterWorkspace | null {
  const pending = readTableSettingIntent(viewer, `page:roster:workspace:${club}`);
  const pendingWorkspace = pending && decodeWorkspace(pending.value);
  if (pendingWorkspace) return pendingWorkspace;
  try {
    const raw = sessionStorage.getItem(rosterWorkspaceKey(viewer, club));
    if (!raw) {
      const legacy = sessionStorage.getItem(rosterSearchKey(viewer, club));
      if (!legacy || legacy.length > 1024) return null;
      const search = JSON.parse(legacy);
      return typeof search === 'string' && search.length <= 120
        ? { ...defaultRosterWorkspace(), search }
        : null;
    }
    if (raw.length > 2048) return null;
    const value = JSON.parse(raw);
    if (value?.version !== 1 && value?.version !== 2) return null;
    const workspace = decodeWorkspace(value);
    // Apply the new join-order default once when upgrading the old workspace.
    // Keep the operator's search, filter and columns; subsequent choices persist.
    return workspace && value.version === 1 ? { ...workspace, sort: 'newest' } : workspace;
  } catch {
    return null;
  }
}
function cacheWorkspace(viewer: string, club: string, workspace: RosterWorkspace): void {
  try {
    sessionStorage.setItem(
      rosterWorkspaceKey(viewer, club),
      JSON.stringify({ version: 2, ...workspace })
    );
  } catch {
    /* The account row remains authoritative if browser storage is unavailable. */
  }
}
async function saveWorkspace(
  viewer: string,
  club: string,
  workspace: RosterWorkspace,
  id: string
): Promise<void> {
  const key = `roster:workspace:${club}`;
  await orderTableSettingWrite(viewer, `page:${key}`, async () => {
    try {
      const { error } = await awaitPreferenceSave(
        supabase
          .from('user_page_preferences')
          .upsert(
            { user_id: viewer, preference_key: key, value: workspace },
            { onConflict: 'user_id,preference_key' }
          )
      );
      if (error) throw error;
      confirmTableSettingIntent(viewer, `page:${key}`, id);
    } catch (error) {
      reportError(error, 'RosterWorkspace.save');
    }
  });
}
/** Resolve the same workspace before publishing its account/club scope. */
export async function loadRosterWorkspace(viewer: string, club: string): Promise<RosterWorkspace> {
  const key = `page:roster:workspace:${club}`;
  const revision = workspaceRevisions.get(rosterWorkspaceKey(viewer, club)) ?? 0;
  const pending = readTableSettingIntent(viewer, key);
  const held = pending && decodeWorkspace(pending.value);
  if (held) {
    void saveWorkspace(viewer, club, held, pending.id);
    return held;
  }
  let workspace = readRosterWorkspace(viewer, club) ?? defaultRosterWorkspace();
  try {
    const { data, error } = (await awaitPreferenceSave(
      supabase
        .from('user_page_preferences')
        .select('value')
        .eq('user_id', viewer)
        .eq('preference_key', `roster:workspace:${club}`)
        .maybeSingle()
    )) as { data?: { value: unknown } | null; error: unknown };
    if (error) throw error;
    if ((workspaceRevisions.get(rosterWorkspaceKey(viewer, club)) ?? 0) !== revision)
      return readRosterWorkspace(viewer, club) ?? workspace;
    workspace = decodeWorkspace(data?.value) ?? workspace;
  } catch (error) {
    reportError(error, 'RosterWorkspace.load');
  }
  cacheWorkspace(viewer, club, workspace);
  return workspace;
}
export function writeRosterWorkspace(
  viewer: string,
  club: string,
  workspace: RosterWorkspace
): void {
  const safe = decodeWorkspace(workspace);
  if (!safe) return;
  const previous = readRosterWorkspace(viewer, club);
  if (previous && JSON.stringify(previous) === JSON.stringify(safe)) return;
  const revisionKey = rosterWorkspaceKey(viewer, club);
  workspaceRevisions.set(revisionKey, (workspaceRevisions.get(revisionKey) ?? 0) + 1);
  cacheWorkspace(viewer, club, safe);
  const id = beginTableSettingIntent(viewer, `page:roster:workspace:${club}`, safe);
  void saveWorkspace(viewer, club, safe, id);
}
export function writeRosterReturnPosition(
  viewer: string,
  club: string,
  position: RosterReturnPosition
): void {
  const workspace = decodeWorkspace(position.workspace);
  if (!workspace) return;
  try {
    sessionStorage.setItem(
      rosterPositionKey(viewer, club),
      JSON.stringify({
        version: 1,
        entryKey: position.entryKey,
        workspace,
        viewportTop: Math.min(MAX_ROSTER_RETURN_TOP, Math.max(0, position.viewportTop)),
        windowTop: Math.min(MAX_ROSTER_RETURN_TOP, Math.max(0, position.windowTop)),
      })
    );
  } catch {
    /* Optional browser continuity. */
  }
}
export function takeRosterReturnPosition(
  viewer: string,
  club: string,
  entryKey: string
): RosterReturnPosition | null {
  try {
    const key = rosterPositionKey(viewer, club);
    const raw = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
    if (!raw || raw.length > 4096) return null;
    const v = JSON.parse(raw);
    const workspace = decodeWorkspace(v?.workspace);
    const validOffset = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= MAX_ROSTER_RETURN_TOP;
    if (
      v?.version !== 1 ||
      v.entryKey !== entryKey ||
      !workspace ||
      !validOffset(v.viewportTop) ||
      !validOffset(v.windowTop)
    )
      return null;
    return { version: 1, entryKey, workspace, viewportTop: v.viewportTop, windowTop: v.windowTop };
  } catch {
    return null;
  }
}
export function sameRosterQuery(a: RosterWorkspace, b: RosterWorkspace): boolean {
  return a.search === b.search && a.filter === b.filter && a.sort === b.sort;
}
