import { describe, expect, it } from 'vitest';
import { getClubNavigationCapabilities } from '../../src/config/clubArenaNavigation';
import { getClubOperationItems } from '../../src/config/clubOperationsNavigation';
import { ADMIN_CLUB_OPERATION_ROUTES } from '../e2e/support/clubOperationRoutes';

describe('production E2E covers the complete Club Operations registry', () => {
  it('keeps every admin-visible id, label, and suffix in the browser sweep', () => {
    const clubId = 'certification-club';
    const registered = getClubOperationItems(clubId, getClubNavigationCapabilities('admin')).map(
      ({ id, label, path }) => ({
        id,
        label,
        suffix: path.replace(`/clubs/${clubId}/`, ''),
      })
    );

    expect(
      ADMIN_CLUB_OPERATION_ROUTES.map(({ id, label, suffix }) => ({ id, label, suffix }))
    ).toEqual(registered);
  });
});
