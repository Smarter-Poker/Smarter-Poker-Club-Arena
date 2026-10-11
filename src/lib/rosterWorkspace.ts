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
const SORTS = ['hierarchy', 'activity', 'name', 'downlines', 'wallet', 'fees'];
export const ROSTER_COLUMNS: RosterColumn[] = ['downlines', 'wallets', 'fees', 'activity'];
export const ROSTER_ROW_HEIGHT = 123;
export const MAX_ROSTER_RETURN_TOP = ROSTER_ROW_HEIGHT * 10_000;
export function defaultRosterWorkspace(): RosterWorkspace {
  return { search: '', filter: 'all', sort: 'hierarchy', columns: [...ROSTER_COLUMNS] };
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
    return value?.version === 1 ? decodeWorkspace(value) : null;
  } catch {
    return null;
  }
}
export function writeRosterWorkspace(
  viewer: string,
  club: string,
  workspace: RosterWorkspace
): void {
  const safe = decodeWorkspace(workspace);
  if (!safe) return;
  try {
    sessionStorage.setItem(
      rosterWorkspaceKey(viewer, club),
      JSON.stringify({ version: 1, ...safe })
    );
  } catch {
    /* Optional browser continuity. */
  }
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
