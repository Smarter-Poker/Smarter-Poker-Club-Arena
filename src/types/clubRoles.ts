/**
 * CLUB ROLES
 * ============================================================================
 * The one definition. Before this there were three `MemberRole` types -
 * types/club.types.ts, types/database.types.ts and components/club/MemberList
 * - and no two of them agreed, nor did any of them match the database:
 *
 *   club.types.ts     owner | super_agent | agent | manager | member | guest
 *   database.types.ts owner | admin | agent | member
 *   MemberList.tsx    owner | admin | agent | member
 *   the database      owner | admin | super_agent | agent | sub_agent | player
 *
 * Dan, 2026-08-21: "ALL USERS IN CLUBS AND UNIONS NEED ROLES ASSIGNED TO THEM:
 * OWNER, ADMIN, SUPER AGENT, AGENT, SUB AGENT AND PLAYER... OWNERS CAN UPGRADE
 * A PLAYER TO ANY ROLE STATUS, INCLUDING CO OWNER."
 *
 * A ROLE IS A JOB, NOT A GATE ON PLAYING. Everyone in a club is a player;
 * owner, admin and agent are things some players also are. Nothing in seating
 * or buy-in reads a role, and nothing should start.
 *
 * THE MATRIX BELOW IS A MIRROR, NOT THE RULE. The rule lives in
 * fn_club_grantable_roles in Postgres, which the write path enforces and a
 * trigger makes unbypassable. This copy exists so a screen can grey out a
 * button without a round trip. When the two disagree, the database wins and
 * the request is refused - so treat a disagreement as a bug here, not there.
 */

export const CLUB_ROLES = [
  'owner',
  'co_owner',
  'admin',
  'super_agent',
  'agent',
  'sub_agent',
  'player',
] as const;

export type ClubRole = (typeof CLUB_ROLES)[number];

/** Mirrors fn_club_role_rank. Gaps leave room for a tier without renumbering. */
export const ROLE_RANK: Record<ClubRole, number> = {
  owner: 100,
  co_owner: 90,
  admin: 80,
  super_agent: 60,
  agent: 40,
  sub_agent: 20,
  player: 0,
};

export const ROLE_LABEL: Record<ClubRole, string> = {
  owner: 'Owner',
  co_owner: 'Co Owner',
  admin: 'Admin',
  super_agent: 'Super Agent',
  agent: 'Agent',
  sub_agent: 'Sub Agent',
  player: 'Player',
};

/** What each role is actually for, shown next to the choice. */
export const ROLE_DESCRIPTION: Record<ClubRole, string> = {
  owner: 'Runs the club. One per club, and not assignable here.',
  co_owner: 'Everything an owner can do except appoint another co owner.',
  admin: 'Runs the club day to day and can promote up to admin.',
  super_agent: 'Carries agents beneath them and can promote their own players to agent.',
  agent: 'Carries players and can promote their own players to sub agent.',
  sub_agent: 'Carries players under an agent.',
  player: 'Plays. Every member is one of these, whatever else they are.',
};

export const AGENT_ROLES: ClubRole[] = ['super_agent', 'agent', 'sub_agent'];
export const STAFF_ROLES: ClubRole[] = ['owner', 'co_owner', 'admin'];

export function isClubRole(value: unknown): value is ClubRole {
  return typeof value === 'string' && (CLUB_ROLES as readonly string[]).includes(value);
}

/** Anything the database or an older screen hands us, mapped onto the seven. */
export function normaliseRole(value: unknown): ClubRole {
  if (isClubRole(value)) return value;
  // 'member', 'manager' and 'guest' were all ways of saying "not staff".
  return 'player';
}

export function roleLabel(value: unknown): string {
  return ROLE_LABEL[normaliseRole(value)];
}

export function roleRank(value: unknown): number {
  return ROLE_RANK[normaliseRole(value)];
}

/**
 * Mirror of fn_club_grantable_roles, for greying out buttons only.
 *
 * `inDownline` answers "is the target somewhere beneath the actor" and must be
 * supplied by the caller, because the client does not hold the whole tree. When
 * it is unknown, pass false: the screen then offers nothing and the user finds
 * out from the server, which is the safe direction to be wrong in.
 */
export function grantableRoles(
  actorRole: unknown,
  targetRole: unknown,
  opts: { isSelf?: boolean; inDownline?: boolean; isPlatformAdmin?: boolean } = {}
): ClubRole[] {
  const actor = normaliseRole(actorRole);
  const target = normaliseRole(targetRole);

  // Nobody edits their own title.
  if (opts.isSelf) return [];
  // The club owner is not demotable from a members list.
  if (target === 'owner') return [];

  if (opts.isPlatformAdmin || actor === 'owner') {
    return ['co_owner', 'admin', 'super_agent', 'agent', 'sub_agent', 'player'];
  }

  if (actor === 'co_owner' || actor === 'admin') {
    // "as high as admin", and never at or above your own rank
    if (ROLE_RANK[target] >= ROLE_RANK[actor]) return [];
    return ['admin', 'super_agent', 'agent', 'sub_agent', 'player'];
  }

  if (actor === 'super_agent') {
    if (!opts.inDownline) return [];
    return target === 'player' || target === 'agent' ? ['agent', 'player'] : [];
  }

  if (actor === 'agent') {
    if (!opts.inDownline) return [];
    return target === 'player' || target === 'sub_agent' ? ['sub_agent', 'player'] : [];
  }

  return [];
}

/**
 * "Can this person run the club?" - owner, co-owner or admin.
 *
 * Fifteen call sites spelled this out by hand as two equality checks against
 * 'owner' and 'admin', which is how co_owner would have arrived as a role that
 * unlocked nothing. Ask here instead, so the next role is one edit rather
 * than fifteen.
 */
export function isClubStaff(role: unknown): boolean {
  const r = normaliseRole(role);
  return r === 'owner' || r === 'co_owner' || r === 'admin';
}

/** Owner or co-owner: the two who can hand out roles the admins cannot. */
export function isClubPrincipal(role: unknown): boolean {
  const r = normaliseRole(role);
  return r === 'owner' || r === 'co_owner';
}

/** Carries a downline: super agent, agent or sub agent. */
export function isAgentRole(role: unknown): boolean {
  return AGENT_ROLES.includes(normaliseRole(role));
}
