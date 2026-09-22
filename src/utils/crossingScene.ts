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
    carZ: 9 - 18 * t,
    hit: t >= 0.5,
    finished: t >= 1,
    fall: Math.max(0, Math.min(1, (t - 0.5) * 2)),
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
 * A longer lens from further back (22 degrees at 26.5, where it was 38 at
 * 13.7) keeps everything from the street signs to the far edge in frame while
 * the outer streets fan far less. A narrow scene backs the camera off until the
 * donkey's street and the next one fit; a wide scene keeps the distance, keeps
 * the donkey at most a street and a half from the left edge, and shows the
 * road ahead of it. The fog is measured from the target, so the haze on the
 * road is what it always was at any distance.
 */
export const CROSSING_CAMERA = {
  /** Vertical field of view, in degrees. */
  fov: 22,
  /** How far below the horizon the camera looks, in degrees. */
  pitch: 37,
  /** Camera to target on any scene wide enough to show `minGroundWidth` from here. */
  distance: 26.5,
  /** The road depth the view is centred on, just beyond the donkey's line (z = 0). */
  targetZ: -1,
  /** Road, in world units across, that every scene shows at the target depth. */
  minGroundWidth: 9.4,
  /** Where across the view the donkey stands: a third in, the road ahead to its right. */
  donkeyAcross: 0.32,
  /** On a wide scene the donkey stays this close to the left edge (a street and a half). */
  maxBehind: 4.2,
  /** The haze starts this far past the target and is complete this far past it. */
  fogFrom: 8.3,
  fogTo: 51.3,
  /** Nothing the scene draws is further than this past the target. */
  depthPastTarget: 70,
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
  const distance = Math.max(c.distance, c.minGroundWidth / (2 * tanHalf * ratio));
  const groundWidth = 2 * distance * tanHalf * ratio;
  const behind = Math.min(c.donkeyAcross * groundWidth, c.maxBehind);
  const x = focus - behind + groundWidth / 2;
  const pitch = (c.pitch * Math.PI) / 180;
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
