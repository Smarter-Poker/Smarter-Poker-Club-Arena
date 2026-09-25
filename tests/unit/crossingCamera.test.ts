/**
 * THE ROAD IS STRAIGHT (Dan, 2026-09-21: "THE STREET IS CROKED AND LEANS AT
 * THE TOP").
 *
 * The camera used to stand 2.6 to the right of the donkey and look back at a
 * point 0.6 to its right, which turned it about ten degrees off the road: the
 * far edge sloped down to the right and every street leaned right at the top.
 * These tests project the real road through the real camera, at phone and
 * desktop shapes and at every point along the road, so no future framing
 * change can turn it again.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CROSSING_CAMERA,
  COLLISION_DELAY_MS,
  STREET_WIDTH,
  WALK_MS,
  aimCrossingCamera,
  collisionAt,
  collisionFrame,
  crossingCameraPose,
  crossingTrafficVisible,
  streetCenter,
  streetState,
} from '../../src/utils/crossingScene';

/** Phone portrait, phone landscape-ish, square, laptop and wide desktop scenes. */
const ASPECTS = [393 / 520, 0.6, 1, 16 / 9, 1500 / 760, 2.4];
const FOCI = [0, streetCenter(1), streetCenter(5), streetCenter(12)];
/** The asphalt slabs are 19 deep, centred on the donkey's line (z = 0). */
const FAR_EDGE_Z = -9.5;
/** The painted street signs lie on the road at this depth. */
const SIGN_Z = 2.25;
const aimed = (aspect: number, focus: number) => {
  const camera = new THREE.PerspectiveCamera(CROSSING_CAMERA.fov, aspect, 0.1, 100);
  const pose = aimCrossingCamera(camera, focus);
  camera.updateMatrixWorld(true);
  return { camera, pose };
};
const onScreen = (camera: THREE.PerspectiveCamera, x: number, z: number) =>
  new THREE.Vector3(x, 0, z).project(camera);

describe('the camera looks straight down the road', () => {
  it.each(ASPECTS)('has no yaw and no roll at aspect %s', (aspect) => {
    for (const focus of FOCI) {
      const { camera, pose } = aimed(aspect, focus);
      expect(pose.position[0]).toBe(pose.target[0]);
      expect(Math.abs(camera.getWorldDirection(new THREE.Vector3()).x)).toBeLessThan(1e-12);
      const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      expect(Math.abs(cameraRight.y)).toBeLessThan(1e-12);
    }
  });

  it.each(ASPECTS)('prints the far edge of the road level at aspect %s', (aspect) => {
    for (const focus of FOCI) {
      const { camera, pose } = aimed(aspect, focus);
      const left = onScreen(camera, pose.x - 20, FAR_EDGE_Z);
      const right = onScreen(camera, pose.x + 20, FAR_EDGE_Z);
      expect(Math.abs(left.y - right.y)).toBeLessThan(1e-9);
    }
  });

  it.each(ASPECTS)('leans no street to one side at aspect %s', (aspect) => {
    for (const focus of FOCI) {
      const { camera, pose } = aimed(aspect, focus);
      // Street lines either side of the view converge by the same amount,
      // mirror images of each other, from the signs to the far edge.
      for (const d of [STREET_WIDTH / 2, STREET_WIDTH * 1.5, STREET_WIDTH * 2.5])
        for (const z of [FAR_EDGE_Z, -3, SIGN_Z]) {
          const a = onScreen(camera, pose.x - d, z);
          const b = onScreen(camera, pose.x + d, z);
          expect(a.x + b.x).toBeCloseTo(0, 9);
          expect(a.y).toBeCloseTo(b.y, 9);
        }
    }
  });

  it.each(ASPECTS)(
    'keeps the donkey, the next street and its sign in view at aspect %s',
    (aspect) => {
      for (const focus of FOCI) {
        const { camera } = aimed(aspect, focus);
        const donkey = onScreen(camera, focus, 0);
        const next = onScreen(camera, focus + STREET_WIDTH, 0);
        const nextSign = onScreen(camera, focus + STREET_WIDTH, SIGN_Z);
        for (const point of [donkey, next, nextSign]) {
          expect(point.x).toBeGreaterThan(-1);
          expect(point.x).toBeLessThan(1);
          expect(point.y).toBeGreaterThan(-1);
          expect(point.y).toBeLessThan(1);
        }
        // The far edge of the road stays inside the top of the frame.
        expect(onScreen(camera, focus, FAR_EDGE_Z).y).toBeLessThan(1);
      }
    }
  );

  it('is a pure function of the focus and the aspect', () => {
    expect(crossingCameraPose(streetCenter(3), 1.5)).toEqual(
      crossingCameraPose(streetCenter(3), 1.5)
    );
    const bad = crossingCameraPose(0, Number.NaN);
    expect(bad).toEqual(crossingCameraPose(0, 1));
  });
});

describe('only a round still to be played has a next street', () => {
  it('lights the next street while the round can go on, and none once it is over', () => {
    expect(streetState(1, 0, 'idle')).toBe('next');
    expect(streetState(2, 2, 'open')).toBe('current');
    expect(streetState(3, 2, 'open')).toBe('next');
    expect(streetState(1, 2, 'open')).toBe('crossed');
    expect(streetState(2, 2, 'cashed')).toBe('crossed');
    expect(streetState(3, 2, 'cashed')).toBe('ahead');
    expect(streetState(2, 2, 'lost')).toBe('crash');
    expect(streetState(3, 2, 'lost')).toBe('ahead');
  });
});

describe('the ghost of a booked win never walks through traffic', () => {
  it('clears every street the donkey would still have crossed, and only those', () => {
    // Booked on street 2; the sealed road would have reached street 8.
    for (let lane = 3; lane <= 8; lane++)
      expect(crossingTrafficVisible(lane, 2, false, 8)).toBe(false);
    expect(crossingTrafficVisible(9, 2, false, 8)).toBe(true);
    expect(crossingTrafficVisible(1, 2, false, 8)).toBe(true);
    // Without a route only the donkey's street and the next are clear, as before.
    expect(crossingTrafficVisible(4, 2, false)).toBe(true);
    expect(crossingTrafficVisible(3, 2, false)).toBe(false);
  });
});

describe('the car never reaches the street before the donkey', () => {
  it.each([0.5, 1, 2, 3])('strikes after the walk is over at animation speed %s', (speed) => {
    let t = 0;
    while (!collisionAt(t, speed).hit) t += 1;
    expect(t).toBeGreaterThanOrEqual(WALK_MS * speed);
    expect(collisionAt((COLLISION_DELAY_MS + 1050) * speed, speed).finished).toBe(true);
  });
  it('keeps the normal-speed strike exactly as it was', () => {
    for (const t of [0, 300, 745, 1270, 2000])
      expect(collisionAt(t, 1)).toEqual(collisionFrame(Math.max(0, t - COLLISION_DELAY_MS)));
    expect(collisionAt(0, 3, true).finished).toBe(true);
  });
});
