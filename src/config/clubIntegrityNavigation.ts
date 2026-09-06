import type { ClubNavigationCapabilities } from './clubArenaNavigation';

export type ClubIntegrityPageId = 'reports' | 'disputes' | 'hand-review' | 'blacklist';

export interface ClubIntegrityNavItem {
  id: ClubIntegrityPageId;
  label: string;
  description: string;
  path: string;
  access: 'staff' | 'control';
}

const DEFINITIONS: Array<Omit<ClubIntegrityNavItem, 'path'>> = [
  {
    id: 'reports',
    label: 'Reports',
    description: 'Player Conduct And Moderation Intake',
    access: 'staff',
  },
  {
    id: 'disputes',
    label: 'Disputes',
    description: 'Financial Investigations And Resolutions',
    access: 'staff',
  },
  {
    /* PHASE 6 (2026-09-06). Triage is STAFF, like Reports and Disputes above:
       seeing that a player flagged a hand is moderation intake. The hole-card
       lookup lives on the same page and is control-only, enforced by
       `fn_ca_operator_read_hand` rather than by this list. */
    id: 'hand-review',
    label: 'Hand Review',
    description: 'Flagged Hands And The Audited Hand Lookup',
    access: 'staff',
  },
  {
    id: 'blacklist',
    label: 'Blacklist',
    description: 'Club Access Exclusions And Expiry Controls',
    access: 'control',
  },
];

/**
 * Permission-aware navigation for the club integrity workflow. Database/RLS
 * remains authoritative; this prevents the interface from advertising club
 * controls to roles that cannot use them.
 */
export function getClubIntegrityNavigation(
  clubId: string,
  capabilities: ClubNavigationCapabilities
): ClubIntegrityNavItem[] {
  return DEFINITIONS.filter(
    (item) => capabilities.isClubStaff && (item.access === 'staff' || capabilities.canControlClub)
  ).map((item) => ({ ...item, path: `/clubs/${clubId}/${item.id}` }));
}
