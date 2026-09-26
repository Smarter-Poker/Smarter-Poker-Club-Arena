export interface ClubOpeningEligibility {
  opening_checklist_started_at?: string | null;
  is_union?: boolean | null;
  union_id?: string | null;
}

/**
 * The server's completion latch for the opening checklist, as the lobby holds
 * it (fn_club_opening_checklist_state, 2026-09-23). THREE answers, never two:
 *
 *   undefined  not read yet, or not asked because this viewer is not the
 *              owner of a new standalone club: fail closed
 *   null       read and not latched, or the store could not answer and the
 *              lobby is on its local fallback (today's behaviour)
 *   string     latched at that time: the list is finished for good, whatever
 *              the live data says later (a closed table, a member who left)
 */
export type ClubOpeningChecklistCompletion = string | null | undefined;

/**
 * The half of `hasNewClubOpeningChecklist` the club row alone can answer. The
 * lobby asks the server for the checklist state as soon as this holds, beside
 * the union lookup rather than after it; nothing shows until both are in.
 */
export function mayHaveNewClubOpeningChecklist(
  club: ClubOpeningEligibility | null | undefined
): boolean {
  return Boolean(club?.opening_checklist_started_at && club.is_union !== true && !club.union_id);
}

/**
 * Opening guidance belongs only to standalone clubs created after the
 * checklist feature was installed, and only until the checklist is finished.
 * Legacy clubs have no marker, a club managed by a union completes setup from
 * the union console instead, and a latched checklist never comes back.
 */
export function hasNewClubOpeningChecklist(
  club: ClubOpeningEligibility | null | undefined,
  resolvedUnionId: string | null | undefined,
  completedAt: ClubOpeningChecklistCompletion
): boolean {
  /* `undefined` means the union lookup has not produced an authoritative
     answer yet. Fail closed during that window: a club linked only through
     union_clubs does not necessarily carry clubs.union_id, and painting the
     checklist before that lookup completes makes an established union club
     flash a new-club gate on every visit. `null` is the positive, resolved
     answer that this is a standalone club. The latch follows the same rule:
     only a positive "not latched" (`null`) lets the checklist draw, so a
     finished club never flashes it while its latch is being read. */
  return Boolean(
    completedAt === null &&
    resolvedUnionId !== undefined &&
    mayHaveNewClubOpeningChecklist(club) &&
    !resolvedUnionId
  );
}

/**
 * Whether this club may create its own games from the club lobby.
 *
 * THREE answers, never two. The union lookup is asynchronous and can fail, and
 * a club attached only through `union_clubs` carries neither `clubs.is_union`
 * nor `clubs.union_id`. Reading "not resolved yet" or "the lookup errored" as
 * "standalone" showed staff the create controls of a union-managed club until
 * the lookup landed, and for the whole session when it never did.
 *
 *   'union'       any source names a union
 *   'standalone'  the lookup positively resolved to `null` AND the club row
 *                 names no union
 *   'unresolved'  anything else; callers must fail closed
 */
export type ClubUnionScope = 'standalone' | 'union' | 'unresolved';

export function resolveClubUnionScope(
  club: Pick<ClubOpeningEligibility, 'is_union' | 'union_id'> | null | undefined,
  resolvedUnionId: string | null | undefined
): ClubUnionScope {
  if (!club) return 'unresolved';
  if (club.is_union === true || club.union_id || resolvedUnionId) return 'union';
  return resolvedUnionId === null ? 'standalone' : 'unresolved';
}

/**
 * Club creation always stores a logo: a custom upload, or one of the built-in
 * placeholder crests (`club-logos/preset-NN.webp`, served from the media base
 * or from the app origin). A placeholder is not the owner's own picture, so the
 * "Choose A Club Profile Picture" step stays open, and skippable, until a real
 * image replaces it. Uploaded logos are named by club or owner id plus a
 * timestamp or request id, so they never match the preset file pattern.
 */
const PRESET_CLUB_LOGO_PATH = /(?:^|\/)club-logos\/preset-\d+\.(?:webp|png|jpe?g)$/i;

export function isPresetClubLogo(url: string | null | undefined): boolean {
  if (!url) return false;
  const path = url.trim().split(/[?#]/)[0];
  return PRESET_CLUB_LOGO_PATH.test(path);
}

export function hasOwnClubPicture(
  club: { logo_url?: string | null; avatar_url?: string | null } | null | undefined
): boolean {
  if (!club) return false;
  return [club.logo_url, club.avatar_url].some(
    (url) => Boolean(url && url.trim()) && !isPresetClubLogo(url)
  );
}

/* ── Opening checklist skips ────────────────────────────────────────────────
   One definition of "skipped", shared by the lobby (which decides whether the
   checklist and its desktop layout exist at all) and the checklist itself.
   Only an OPTIONAL, unfinished step can be skipped: a required step that an
   older build allowed to be skipped is simply open again. */

/** The one REQUIRED step. It is never skipped, here or on the server. */
export const CLUB_LAUNCH_REQUIRED_TASK_ID = 'opening-setup';

/**
 * Every OPTIONAL step, spelled exactly as fn_club_opening_checklist_skip and
 * the club_opening_checklists CHECK spell them. The server refuses any other
 * id, so a skip of anything else stays in this browser.
 */
export const CLUB_LAUNCH_OPTIONAL_TASK_IDS = [
  'identity',
  'tagline',
  'nlh',
  'plo',
  'limit',
  'mtt',
  'spin',
  'heads-up',
  'first-player',
  'first-agent',
] as const;

export type ClubLaunchOptionalTaskId = (typeof CLUB_LAUNCH_OPTIONAL_TASK_IDS)[number];

export function isOptionalClubLaunchTaskId(id: unknown): id is ClubLaunchOptionalTaskId {
  return (
    typeof id === 'string' && (CLUB_LAUNCH_OPTIONAL_TASK_IDS as readonly string[]).includes(id)
  );
}

/** One answer of fn_club_opening_checklist_state, _skip or _complete. */
export interface ClubOpeningChecklistServerState {
  clubId: string;
  completedAt: string | null;
  skippedTaskIds: ClubLaunchOptionalTaskId[];
}

/**
 * Reads a checklist RPC answer, or returns null when it is not one for this
 * club. A shape that cannot be read is a failure the caller reports and falls
 * back from, never an empty checklist (CLAUDE.md 10.86): answering "nothing
 * skipped, not finished" to a question nobody could read would redraw a
 * finished checklist.
 */
export function parseClubOpeningChecklistState(
  data: unknown,
  expectedClubId: string
): ClubOpeningChecklistServerState | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const row = data as { clubId?: unknown; completedAt?: unknown; skippedTaskIds?: unknown };
  if (typeof row.clubId !== 'string' || row.clubId !== expectedClubId) return null;
  const { completedAt, skippedTaskIds } = row;
  if (completedAt !== null && (typeof completedAt !== 'string' || !completedAt.trim())) return null;
  if (!Array.isArray(skippedTaskIds) || !skippedTaskIds.every((id) => typeof id === 'string')) {
    return null;
  }
  return {
    clubId: row.clubId,
    completedAt,
    skippedTaskIds: skippedTaskIds.filter(isOptionalClubLaunchTaskId),
  };
}
export interface ClubLaunchSkipCandidate {
  id: string;
  complete: boolean;
  optional?: boolean;
}

export function resolveClubLaunchTasks<T extends ClubLaunchSkipCandidate>(
  tasks: readonly T[],
  skippedIds: readonly string[]
): Array<T & { skipped: boolean }> {
  return tasks.map((task) => ({
    ...task,
    skipped: task.optional === true && !task.complete && skippedIds.includes(task.id),
  }));
}

export function clubLaunchSkipStorageKey(clubId: string, viewerId: string): string {
  /* IDs, never display names: two clubs may share a name, a club may be
     renamed, and two operators can use the same browser. Since 2026-09-23 the
     owner's skips live on the server; this browser copy is the fallback when
     the server cannot answer, and the one-time source of skips made before. */
  return `club-launch-skips:${clubId}:${viewerId}`;
}

export type ClubLaunchSkipReporter = (error: unknown, context: string) => void;

export function readClubLaunchSkips(storageKey: string, report: ClubLaunchSkipReporter): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch (error) {
    /* Storage can be disabled and a stored value can be corrupt. Neither may
       crash the lobby, and neither is silent: an owner whose skips never
       persist is otherwise unexplainable. */
    report(error, 'ClubLaunchSkips.read_failed');
    return [];
  }
}

export function writeClubLaunchSkips(
  storageKey: string,
  skippedIds: readonly string[],
  report: ClubLaunchSkipReporter
): boolean {
  try {
    if (skippedIds.length === 0) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify(skippedIds));
    return true;
  } catch (error) {
    /* Disabled or full storage. The step still resolves for this session. */
    report(error, 'ClubLaunchSkips.write_failed');
    return false;
  }
}
