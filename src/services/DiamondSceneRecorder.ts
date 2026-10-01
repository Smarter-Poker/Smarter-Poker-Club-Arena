import { supabase } from '../lib/supabase';
import { setSceneRecorder } from '../components/games/sceneRecorder';

/**
 * The database writer for Diamond scene summaries (2026-10-01): each one is
 * added to diamond_scene_daily through fn_record_diamond_scene, a daily
 * rollup with no user in it that platform admins read as Diamond Scene Health.
 * Installed by importing this module, which the real game pages do; the
 * standalone test page never does (see src/components/games/sceneRecorder.ts).
 * Fire and forget: a refused or lost write never reaches the game.
 */
setSceneRecorder((r) => {
  void Promise.resolve(
    supabase.rpc('fn_record_diamond_scene', {
      p_game: r.game,
      p_device: r.device,
      p_software: r.software,
      p_end_tier: r.endTier,
      p_frames: Math.round(r.frames),
      p_ms: Math.round(r.ms),
      p_slow: Math.round(r.slow),
      p_failure: r.failure,
    })
  ).catch(() => undefined);
});

/** Present so an import of this module reads as what it is. */
export const DIAMOND_SCENE_RECORDER_INSTALLED = true;
