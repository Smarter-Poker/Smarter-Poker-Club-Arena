import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

export default function SlugEnforcer() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    // Only intercept paths that match /clubs/<uuid>
    const match = location.pathname.match(
      /^\/clubs\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/
    );
    if (match) {
      const uuid = match[1];
      supabase
        .from('clubs')
        .select('slug')
        .eq('id', uuid)
        .maybeSingle()
        .then(({ data }) => {
          if (data?.slug) {
            const newPath = location.pathname.replace(uuid, data.slug);
            navigate(newPath + location.search + location.hash, { replace: true });
          }
        });
    }
  }, [location.pathname, location.search, location.hash, navigate]);

  return null;
}
