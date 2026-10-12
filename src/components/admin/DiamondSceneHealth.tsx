import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { useIsMounted } from '../../hooks/useIsMounted';
import { fmt } from '../../utils/format';

/**
 * DIAMOND SCENE HEALTH - how real phones draw the Diamond games (2026-10-01).
 *
 * Every Crash, Plinko, Donkey Cross and wheel visit records how the device
 * drew it (src/components/games/sceneTelemetry.ts) into a daily rollup with no
 * user in it. This reads it back per game and kind of device: frames a second
 * while moving, the share of slow frames, how often the scene had to drop to a
 * lighter tier, how often the CPU drew it, and how many scenes could not draw.
 *
 * PLATFORM ADMINS ONLY, like Card Slide above: fn_diamond_scene_health returns
 * an empty set to anyone else, and this panel then says nothing.
 */
type SceneHealthRow = {
  game: string;
  device: string;
  sessions: number;
  fps: number | null;
  slow_share: number | null;
  lite_share: number | null;
  software_share: number | null;
  failures: number;
};

const SCENE_GAME_NAMES: Record<string, string> = {
  crash: 'Crash',
  plinko: 'Plinko',
  crossing: 'Donkey Cross',
  wheel: 'Wheel',
};
const SCENE_DEVICE_NAMES: Record<string, string> = {
  app_ios: 'iPhone App',
  app_android: 'Android App',
  ios_web: 'iPhone Browser',
  android_web: 'Android Browser',
  desktop: 'Computer',
};

export function DiamondSceneHealth() {
  const [rows, setRows] = useState<SceneHealthRow[] | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'not-entitled'>('loading');
  const isMounted = useIsMounted();

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_diamond_scene_health', { p_days: 7 });
        if (!isMounted.current) return;
        if (error) throw error;
        const list = (Array.isArray(data) ? data : []) as SceneHealthRow[];
        // Empty is "not yours" or "nothing yet"; neither is an error to show.
        if (!list.length) {
          setState('not-entitled');
          return;
        }
        setRows(list);
        setState('ready');
      } catch {
        if (isMounted.current) setState('error');
      }
    })();
  }, [isMounted]);

  if (state === 'loading' || state === 'not-entitled') return null;
  if (state === 'error' || !rows) {
    return (
      <>
        <h4 className="admin-card-title" style={{ marginTop: '24px' }}>
          Diamond Scene Health
        </h4>
        <div className="admin-stat-label">Scene Health Could Not Be Read.</div>
      </>
    );
  }

  const pct = (n: number | null) => (n == null ? '-' : `${Number(n)}%`);
  return (
    <>
      <h4 className="admin-card-title" style={{ marginTop: '24px' }}>
        Diamond Scene Health - Last 7 Days
      </h4>
      <div className="admin-stats-grid">
        {rows.map((r) => {
          const fps = r.fps == null ? null : Number(r.fps);
          return (
            <div className="admin-stat-card" key={`${r.game}-${r.device}`}>
              <div className="admin-stat-label">
                {SCENE_GAME_NAMES[r.game] ?? r.game}, {SCENE_DEVICE_NAMES[r.device] ?? r.device}
              </div>
              {/* Under 45 a second while moving is visibly rough on a phone. */}
              <div
                className="admin-stat-value"
                style={{ color: fps == null ? undefined : fps >= 45 ? '#31A24C' : '#F7C52A' }}
              >
                {fps == null ? '-' : `${Math.round(fps)} FPS`}
              </div>
              <div className="admin-stat-label">
                {fmt(Number(r.sessions) || 0)} Visits, {pct(r.slow_share)} Slow Frames
              </div>
              <div className="admin-stat-label">
                {pct(r.lite_share)} Lighter Tier, {pct(r.software_share)} CPU Drawn
                {Number(r.failures) ? `, ${fmt(Number(r.failures))} Could Not Draw` : ''}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
