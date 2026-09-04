import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { rememberUnionSlug } from '../../utils/unionIdResolver';

/**
 * Canonical URLs. A club is /clubs/<slug>, a union is /unions/<slug>; any
 * /clubs/<uuid>, /club/<uuid> or /unions/<uuid> that reaches the router is
 * rewritten in place (replace, not push, so Back never lands on the id form).
 *
 * 2026-09-04: unions gained `unions.slug` (Dan: "the Midway Union slug is not
 * present and should be"). Until then this only knew how to move a union's
 * club row from /clubs/ to /unions/ and left the UUID in the address bar.
 */
export default function SlugEnforcer() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    // Intercept paths that match /clubs/<uuid> or /club/<uuid> or /unions/<uuid>
    const match = location.pathname.match(
      /^\/(clubs|club|unions)\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:\/|$)/
    );
    if (!match) return;
    const type = match[1];
    const uuid = match[2];

    Promise.all([
      supabase.from('clubs').select('slug, union_id, is_union').eq('id', uuid).maybeSingle(),
      supabase.from('unions').select('id, slug').eq('id', uuid).maybeSingle(),
    ]).then(([clubRes, unionRes]) => {
      let newPath = location.pathname;
      let redirected = false;
      const onUnionRoute = type === 'unions';
      if (unionRes.data?.slug) rememberUnionSlug(unionRes.data.slug, unionRes.data.id);

      if (onUnionRoute) {
        // /unions/<uuid> -> /unions/<slug>
        if (unionRes.data?.slug) {
          newPath = newPath.replace(uuid, unionRes.data.slug);
          redirected = true;
        }
      } else if (clubRes.data?.is_union) {
        // A union's house club row: the app serves it from the union routes.
        // The union's id usually equals the row's id, but read it, don't assume.
        const unionId = clubRes.data.union_id || uuid;
        const unionSlug = unionRes.data && unionRes.data.id === unionId ? unionRes.data.slug : null;
        newPath = newPath.replace(/^\/clubs?\//, '/unions/');
        newPath = newPath.replace(uuid, unionSlug || unionId);
        newPath = newPath.replace(/\/financials$/, '/settlement');
        redirected = true;
      } else if (clubRes.data?.slug) {
        newPath = newPath.replace(uuid, clubRes.data.slug);
        newPath = newPath.replace(/^\/club\//, '/clubs/');
        redirected = true;
      } else if (unionRes.data?.id) {
        // /clubs/<union uuid> with no club row: it is a union.
        newPath = newPath.replace(/^\/clubs?\//, '/unions/');
        if (unionRes.data.slug) newPath = newPath.replace(uuid, unionRes.data.slug);
        newPath = newPath.replace(/\/financials$/, '/settlement');
        redirected = true;
      }

      if (redirected && newPath !== location.pathname) {
        navigate(newPath + location.search + location.hash, { replace: true });
      }
    });
  }, [location.pathname, location.search, location.hash, navigate]);

  return null;
}
