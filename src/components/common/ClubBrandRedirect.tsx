import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Replace retired brand URLs without unmounting the persistent table shell. */
export default function ClubBrandRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const pathname = location.pathname.replace(
      /^\/(clubs|invite)\/shark-club(?=\/|$)/i,
      '/$1/kings-club'
    );
    const query = new URLSearchParams(location.search);
    let queryChanged = false;
    for (const key of ['club', 'clubId', 'club_id']) {
      if (query.get(key)?.toLowerCase() === 'shark-club') {
        query.set(key, 'kings-club');
        queryChanged = true;
      }
    }
    if (pathname !== location.pathname || queryChanged) {
      const search = queryChanged ? `?${query.toString()}` : location.search;
      navigate(`${pathname}${search}${location.hash}`, { replace: true });
    }
  }, [location.pathname, location.search, location.hash, navigate]);
  return null;
}
