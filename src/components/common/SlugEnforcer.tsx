import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

export default function SlugEnforcer() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    // Intercept paths that match /clubs/<uuid> or /club/<uuid> or /unions/<uuid>
    const match = location.pathname.match(
      /^\/(clubs|club|unions)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/
    );
    if (match) {
      const type = match[1];
      const uuid = match[2];

      Promise.all([
        supabase.from('clubs').select('slug, union_id, is_union').eq('id', uuid).maybeSingle(),
        supabase.from('unions').select('id').eq('id', uuid).maybeSingle(),
      ]).then(([clubRes, unionRes]) => {
        let newPath = location.pathname;
        let redirected = false;

        if (clubRes.data) {
          if (clubRes.data.is_union && !location.pathname.includes('/unions/')) {
            // It's a union club. The app enforces union routes.
            newPath = newPath.replace(/^\/club\//, '/unions/');
            newPath = newPath.replace(/^\/clubs\//, '/unions/');
            newPath = newPath.replace(uuid, clubRes.data.union_id || uuid);
            newPath = newPath.replace(/\/financials$/, '/settlement');
            redirected = true;
          } else if (clubRes.data.slug && !location.pathname.includes('/unions/')) {
            newPath = newPath.replace(uuid, clubRes.data.slug);
            newPath = newPath.replace(/^\/club\//, '/clubs/');
            redirected = true;
          }
        } else if (unionRes.data?.id) {
          if (type === 'club' || type === 'clubs') {
            newPath = newPath.replace(/^\/club\//, '/unions/');
            newPath = newPath.replace(/^\/clubs\//, '/unions/');
            newPath = newPath.replace(/\/financials$/, '/settlement');
            redirected = true;
          }
        }

        if (redirected) {
          navigate(newPath + location.search + location.hash, { replace: true });
        }
      });
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  return null;
}
