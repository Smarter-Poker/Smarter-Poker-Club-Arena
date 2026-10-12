/**
 * WHERE A SCENE SUMMARY IS RECORDED, CHOSEN BY THE APP (2026-10-01).
 *
 * sceneTelemetry.ts runs inside the scenes, and the scenes also run on the
 * standalone Diamond test page, which must never reach accounts or the
 * database (tests/e2e/helpers/diamond-test-fixture.mjs refuses a bundle that
 * includes the Supabase client). So the telemetry calls this dependency-free
 * hook, and the real game pages install the database writer
 * (src/services/DiamondSceneRecorder.ts). On the test page nothing is
 * installed and a summary goes only where analytics.ts sends it.
 */
export type SceneRecord = {
  game: 'crash' | 'plinko' | 'crossing' | 'wheel';
  device: 'app_ios' | 'app_android' | 'ios_web' | 'android_web' | 'desktop';
  software: boolean;
  endTier: number;
  frames: number;
  ms: number;
  slow: number;
  failure: 'renderer' | 'context_lost' | 'stalled' | null;
};

let recorder: ((record: SceneRecord) => void) | null = null;

/** The app's writer. The last one installed wins; `null` removes it. */
export function setSceneRecorder(next: ((record: SceneRecord) => void) | null): void {
  recorder = next;
}

/** Hand one summary or failure to the writer, if there is one. Never throws. */
export function recordScene(record: SceneRecord): void {
  try {
    recorder?.(record);
  } catch {
    /* A lost report is a lost report. It never becomes the player's problem. */
  }
}
