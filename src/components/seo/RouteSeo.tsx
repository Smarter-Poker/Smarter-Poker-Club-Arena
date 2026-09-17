/**
 * Applies per-route SEO (title, description, canonical, robots, JSON-LD) as
 * the router moves. Renders nothing. Mounted once beside <Routes> in App.tsx.
 * The table of public routes lives in src/lib/seo.ts.
 */
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { applySeo, resolveSeo } from '../../lib/seo';

export default function RouteSeo() {
  const { pathname } = useLocation();
  useEffect(() => {
    applySeo(resolveSeo(pathname));
  }, [pathname]);
  return null;
}
