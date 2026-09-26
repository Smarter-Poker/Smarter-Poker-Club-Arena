import type { PerspectiveCamera } from 'three';

export const STREET_WIDTH = 2.8;
export const DONKEY_SCALE = 0.78;
/** Street zero is the starting refuge. Each successful step is centered in its own street. */
export const streetCenter = (step: number) => step * STREET_WIDTH;
/**
 * Whether a lane shows traffic. The donkey's street and the next one are kept
 * clear so it can walk; after a booked win, the streets the donkey would still
 * have crossed (`clearThrough`, the sealed road end) are kept clear too, so the
 * ghost that walks the rest of the route never passes through a car on a
 * street it would have survived.
 */
export function crossingTrafficVisible(
  lane: number,
  picked: number,
  lost: boolean,
  clearThrough: number | null = null
): boolean {
  const current = Math.max(0, picked - (lost ? 1 : 0));
  if (clearThrough !== null && lane > current && lane <= clearThrough) return false;
  return lane !== current && lane !== current + 1;
}
/** How long the donkey takes to walk one street at normal animation speed. */
export const WALK_MS = 420;
/** When the car leaves on a confirmed loss, and how long the whole strike takes. */
export const COLLISION_DELAY_MS = 220;
/**
 * The collision on the animation-speed setting. The donkey's walk is stretched
 * by the setting, so the strike is stretched by the same factor: at any speed
 * the car reaches the street after the donkey does, never before it.
 */
export function collisionAt(elapsedMs: number, speed: number, reduced = false) {
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  return collisionFrame(Math.max(0, elapsedMs - COLLISION_DELAY_MS * s) / s, reduced);
}
/** A confirmed collision is a one-shot presentation, never a game outcome generator. */
export function collisionFrame(elapsedMs: number, reduced = false) {
  const t = reduced ? 1 : Math.max(0, Math.min(1, elapsedMs / 1050));
  return {
    /** How far through the strike this frame is, 0 to 1. */
    t,
    carZ: 9 - 18 * t,
    hit: t >= 0.5,
    finished: t >= 1,
    fall: Math.max(0, Math.min(1, (t - 0.5) * 2)),
  };
}

/**
 * HOW FAR THE DONKEY LEANS INTO THE ROAD WHILE THE SERVER ANSWERS. The player
 * commits and the donkey steps to the kerb at once, instead of standing still
 * through the network wait. It never reaches the lane it is about to cross:
 * the step is a fifth of a street, and the walk that follows starts from where
 * the donkey actually is, so the two run into one another.
 */
export const ANTICIPATION_STEP = 0.45;
export const ANTICIPATION_MS = 260;
export function anticipationFrame(elapsedMs: number, speed: number, reduced = false) {
  if (reduced) return 0;
  const s = Number.isFinite(speed) && speed > 0 ? speed : 1;
  const t = Math.max(0, Math.min(1, Math.max(0, elapsedMs) / (ANTICIPATION_MS * s)));
  return ANTICIPATION_STEP * t * t * (3 - 2 * t);
}

/**
 * THE CAR THAT COMES TO EVERY STREET, AND EITHER BRAKES OR DOES NOT.
 *
 * A road-crossing game lives in the moment between committing and knowing, and
 * a safe street used to be a hop across an empty lane. The same car now comes
 * on every street. It drives the confirmed collision's own line until it is
 * too late to tell the two apart - one quarter through, at z = 4.5, when it is
 * still a street and a half away - and only then does a safe crossing brake,
 * coming to rest at z = 2.4 just as a hit would have reached the donkey. The
 * first frames of a safe street and of a hit are the same frames, so nothing
 * on screen leaks the answer before the scene means to give it.
 */
export const APPROACH_COMMITTED = 0.25;
export const APPROACH_STOPPED = 0.47;
export const APPROACH_REST_Z = 2.4;
export function approachFrame(
  elapsedMs: number,
  speed: number,
  outcome: 'safe' | 'hit',
  reduced = false
) {
  const run = collisionAt(elapsedMs, speed, reduced);
  if (outcome === 'hit') return { ...run, brake: 0, resting: run.finished };
  const brake = Math.max(
    0,
    Math.min(1, (run.t - APPROACH_COMMITTED) / (APPROACH_STOPPED - APPROACH_COMMITTED))
  );
  const line = 9 - 18 * Math.min(run.t, APPROACH_COMMITTED);
  return {
    ...run,
    // Nothing is ever struck on a safe street, and nothing falls.
    hit: false,
    fall: 0,
    carZ: line - (line - APPROACH_REST_Z) * brake * (2 - brake),
    brake,
    resting: brake >= 1,
  };
}

export type CrossingPhase = 'idle' | 'open' | 'cashed' | 'lost';
export type StreetState = 'crash' | 'crossed' | 'current' | 'next' | 'ahead';
/**
 * One street's state for a round, read by the multiplier strip and by the sign
 * painted on that street alike, so the road and the strip always agree. Street
 * zero is the starting refuge: its sign is the donkey's street until it leaves.
 */
export function streetState(street: number, step: number, phase: CrossingPhase): StreetState {
  const lost = phase === 'lost';
  if (lost && street === step) return 'crash';
  if (street < step || (street === step && phase === 'cashed')) return 'crossed';
  if (street === step) return 'current';
  // Only a round still to be played has a next street; a booked or lost round is over.
  if (street === step + 1 && (phase === 'open' || phase === 'idle')) return 'next';
  return 'ahead';
}

/**
 * THE CAMERA LOOKS STRAIGHT DOWN THE ROAD (Dan, 2026-09-21: "THE STREET IS
 * CROKED AND LEANS AT THE TOP").
 *
 * The camera used to stand 2.6 to the right of the donkey and look at a point
 * 0.6 to its right. That sideways offset turned it 10.5 degrees off the road,
 * and a turned camera sends every street toward a vanishing point off to one
 * side: the far edge of the road sloped down to the right and every street line
 * leaned right at the top, on the phone and on the desktop alike.
 *
 * The camera now stands directly over the x it looks at, with world up as its
 * up: no yaw and no roll. A line across the road, such as its far edge, prints
 * horizontal, and the streets converge evenly on the middle of the view. The
 * view is centred ahead of the donkey by moving the camera and its target
 * together, which frames the road ahead without ever turning the camera.
 *
 * THE HORIZON IS IN THE FRAME (Dan, 2026-09-25: a sky, a skyline and lamp
 * posts, with the road kept straight). The 22 degree lens pitched 37 degrees
 * down saw ground alone, from about z = +6 to z = -12, with the horizon some
 * 26 degrees above the top edge. Any camera that shows both the horizon and
 * the road at the donkey's feet needs a vertical field at least as wide as
 * the angle between them, so the lens is now 56 degrees pitched 19.5 down and
 * stands 4.5 above the road, 8.6 behind the donkey's line, aimed at a point
 * 4.3 past it. The horizon prints two thirds of the way from the centre to
 * the top edge; the sky and the city beyond the highway take the top quarter,
 * the donkey stands a third of the way down from the centre, and the street
 * signs at z = 2.25 stay above the strip. The donkey is the same size as
 * before because the camera is nearer by the same factor the lens is wider
 * (26.5 x tan 11 = 9.7 x tan 28); the signs keep their height on screen
 * because they are nearer still. The bottom edge now shows z = +4.4, so the
 * car that comes to every street enters from below the frame and is in view
 * before the point where a safe street and a hit part company (z = 4.5).
 * Still no yaw and no roll: a line across the road prints horizontal.
 *
 * A narrow scene backs the camera off until the donkey's street and the next
 * one fit at the donkey's own line (nearer than the target, so that line is
 * where the width is measured); a wide scene keeps the distance, keeps the
 * donkey at most a street and a half from the left edge, and shows the road
 * ahead of it. The haze is measured from the camera along the view: it starts
 * a little past the donkey's street and is complete just short of the city's
 * foot, so the road runs into it and the far asphalt never shows its grain at
 * a grazing angle. The city itself takes no fog; it stands in its own haze
 * strip against the glow at the horizon.
 */
/**
 * The lane traffic's lap along the road: it turns round at `far`, where a car
 * is a few pixels and a sixth hazed. The camera test checks the far end still
 * prints level and in frame.
 */
export const TRAFFIC_Z = { near: 12, far: -40 } as const;
export const CROSSING_CAMERA = {
  /** Vertical field of view, in degrees. */
  fov: 56,
  /** How far below the horizon the camera looks, in degrees. */
  pitch: 19.5,
  /** Camera to target on any scene wide enough to show `minGroundWidth` from here. */
  distance: 13.6,
  /** The road depth the view is centred on, past the donkey's line (z = 0). */
  targetZ: -4.3,
  /** Road, in world units across, that every scene shows at the donkey's line. */
  minGroundWidth: 9.4,
  /** Where across the view the donkey stands: a third in, the road ahead to its right. */
  donkeyAcross: 0.32,
  /** On a wide scene the donkey stays this close to the left edge (a street and a half). */
  maxBehind: 4.2,
  /** The haze starts this far past the target and is complete this far past it. */
  fogFrom: 10,
  fogTo: 120,
  /** Nothing the scene draws is further than this past the target: the sky dome is at 420. */
  depthPastTarget: 600,
} as const;

export interface CrossingCameraPose {
  /** The x the camera stands over and looks at. Camera and target share it. */
  x: number;
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  /** Camera to target. */
  distance: number;
  fogNear: number;
  fogFar: number;
  /** The camera's far plane. */
  far: number;
}

/** Where the camera stands and looks for a focus x and a viewport aspect ratio. Pure. */
export function crossingCameraPose(focus: number, aspect: number): CrossingCameraPose {
  const c = CROSSING_CAMERA;
  const tanHalf = Math.tan((c.fov * Math.PI) / 360);
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const pitch = (c.pitch * Math.PI) / 180;
  // The donkey's line (z = 0) lies this much nearer than the target along the view.
  const nearer = -c.targetZ * Math.cos(pitch);
  const distance = Math.max(c.distance, c.minGroundWidth / (2 * tanHalf * ratio) + nearer);
  const groundWidth = 2 * (distance - nearer) * tanHalf * ratio;
  const behind = Math.min(c.donkeyAcross * groundWidth, c.maxBehind);
  const x = focus - behind + groundWidth / 2;
  return {
    x,
    position: [x, distance * Math.sin(pitch), c.targetZ + distance * Math.cos(pitch)],
    target: [x, 0, c.targetZ],
    distance,
    fogNear: distance + c.fogFrom,
    fogFar: distance + c.fogTo,
    far: distance + c.depthPastTarget,
  };
}

/** Stands the scene camera on its pose for this focus, at the camera's own aspect. */
export function aimCrossingCamera(camera: PerspectiveCamera, focus: number): CrossingCameraPose {
  const pose = crossingCameraPose(focus, camera.aspect);
  if (camera.fov !== CROSSING_CAMERA.fov || camera.far !== pose.far) {
    camera.fov = CROSSING_CAMERA.fov;
    camera.far = pose.far;
    camera.updateProjectionMatrix();
  }
  camera.up.set(0, 1, 0);
  camera.position.set(...pose.position);
  camera.lookAt(...pose.target);
  return pose;
}
