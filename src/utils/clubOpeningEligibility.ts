export interface ClubOpeningEligibility {
  opening_checklist_started_at?: string | null;
  is_union?: boolean | null;
  union_id?: string | null;
}

/**
 * Opening guidance belongs only to standalone clubs created after the
 * checklist feature was installed. Legacy clubs have no marker, and a club
 * managed by a union completes setup from the union console instead.
 */
export function hasNewClubOpeningChecklist(
  club: ClubOpeningEligibility | null | undefined
): boolean {
  return Boolean(club?.opening_checklist_started_at && club.is_union !== true && !club.union_id);
}
