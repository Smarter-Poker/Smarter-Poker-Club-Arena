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
  club: ClubOpeningEligibility | null | undefined,
  resolvedUnionId: string | null | undefined
): boolean {
  /* `undefined` means the union lookup has not produced an authoritative
     answer yet. Fail closed during that window: a club linked only through
     union_clubs does not necessarily carry clubs.union_id, and painting the
     checklist before that lookup completes makes an established union club
     flash a new-club gate on every visit. `null` is the positive, resolved
     answer that this is a standalone club. */
  return Boolean(
    resolvedUnionId !== undefined &&
    club?.opening_checklist_started_at &&
    club.is_union !== true &&
    !club.union_id &&
    !resolvedUnionId
  );
}
