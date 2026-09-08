import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { setAppNavigate } from '../../lib/routerBridge';

/**
 * Hands the router's navigate() to src/lib/routerBridge so deep links and
 * plugin listeners (which are not components) can route in-SPA. Renders
 * nothing. Mounted once, inside <BrowserRouter>, by App.
 */
export default function RouterBridge() {
  const navigate = useNavigate();
  useEffect(() => {
    setAppNavigate((to, opts) => navigate(to, { replace: opts?.replace }));
    return () => setAppNavigate(null);
  }, [navigate]);
  return null;
}
