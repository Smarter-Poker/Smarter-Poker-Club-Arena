import type { ClubNavigationCapabilities } from './clubArenaNavigation';

export type ClubIntegrityPageId = 'reports' | 'disputes' | 'blacklist';

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
