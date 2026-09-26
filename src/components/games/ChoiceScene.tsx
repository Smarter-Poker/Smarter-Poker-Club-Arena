/** Lit geometry is presentation only. Every reveal comes from a confirmed RPC. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gpuFrameRenderer } from './gpuFrameRenderer';
import { isSoftwareRenderer } from './rendererTier';
import { createQualityGovernor, FLOOR_TIER } from './qualityGovernor';
import { applyQualityTier } from './sceneKit';
import MinesGrid from './MinesGrid';
import {
  STREET_WIDTH,
  DONKEY_SCALE,
  CROSSING_CAMERA,
  aimCrossingCamera,
  streetCenter,
  streetState,
  crossingTrafficVisible,
  anticipationFrame,
  approachFrame,
  APPROACH_REST_Z,
  APPROACH_COMMITTED,
  WALK_MS,
  TRAFFIC_Z,
  type StreetState,
} from '../../utils/crossingScene';
import { CHOICE_MODE, ROAD_LADDERS_V4, type ChoiceGame } from '../../utils/diamondChoiceMath';
import { gameChips } from '../../utils/bonusGameBudget';
import { prefersReducedMotion, getAnimationSpeed } from '../../utils/animationSpeed';
import { reportError } from '../../utils/errorReporter';
import { soundService } from '../../services/SoundService';
import styles from './ChoiceScene.module.css';

/**
 * A beat of the crossing: the donkey landed on a street, the car reached it,
 * or the win was booked. The scene decides when each one happens, because the
 * scene is the only thing that knows where the donkey is.
 */
export type CrossingMoment = 'landed' | 'hit' | 'booked';

interface Props {
  game: ChoiceGame;
  picked: number[];
  mines: number[] | null;
  phase: 'idle' | 'open' | 'cashed' | 'lost';
  roadEnd: number | null;
  busy: boolean;
  onPick: (cell: number) => void;
  roundId?: string;
  onSettled?: () => void;
  /** Multiplier cents per street: the prize for reaching it. Defaults to the one road. */
  ladder?: readonly number[];
  /** Chip prizes per step for this round or its quote, in step order. */
  prizes?: readonly number[];
  /** The stake in chips. */
  betChips?: number;
  /** The settled chips of a finished round. */
  payoutChips?: number;
  /**
   * What a hit pays: the round's own sealed floor while one is open, else the
   * quote the award carries. This game is one decision - take this amount or
   * risk it for that one - and the amount a hit still pays belongs beside the
   * amount at risk, not in a bay above the road.
   */
  floorChips?: number | null;
  /** That floor is a Super award's, which is worth saying by name. */
  superFloor?: boolean;
  /**
   * The first eight characters of the hash this round was sealed with, shown
   * on the idle caption. Proving a round should not need a collapsed panel.
   */
  sealed?: string;
  /**
   * Nothing on screen is looking at the scene: an offer over an idle road, or
   * a receipt on top of it. The clock, the beats and completion carry on; only
   * the draw call is skipped.
   */
  paused?: boolean;
  /**
   * The player has committed to the next street and the server has not
   * answered yet. The donkey steps to the kerb and holds there, instead of
   * standing still through the wait.
   */
  moving?: boolean;
  /** Fired once per beat, on the first frame that shows it, and never before. */
  onMoment?: (moment: CrossingMoment, street: number) => void;
}

/** "1.10x" and "20.00x": a street's multiplier always reads with two decimals. */
export const streetMultiplier = (cents: number) => `${(cents / 100).toFixed(2)}x`;
/** How dangerous a street reads, 0 at the first street to 1 at the last. */
export const streetHazard = (index: number, count: number) =>
  count <= 1 ? 0 : Math.max(0, Math.min(1, index / (count - 1)));
/** Four hazard bands: the tint, the traffic and the strip all read from the same one. */
export const hazardBand = (hazard: number) => Math.min(3, Math.floor(hazard * 4));

/**
 * ONE SCENE'S GEOMETRY AND MATERIALS, ALLOCATED ONCE. Every box of the same
 * shape is one BufferGeometry and every sphere is the same unit sphere, so
 * hundreds of parts no longer mean hundreds of allocations; every paint, and
 * the one glass, rubber, steel, headlamp and taillight, is shared by every car
 * that wears it. The kit owns what it made, and the scene disposes the kit.
 */
function sceneParts() {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const boxes = new Map<string, THREE.BufferGeometry>();
  const paints = new Map<number, THREE.MeshPhysicalMaterial>();
  const own = <T extends THREE.BufferGeometry>(geometry: T) => {
    geometries.add(geometry);
    return geometry;
  };
  const kit = {
    geometries,
    materials,
    textures,
    /** The unit sphere every sculpted part is scaled from. */
    ball: own(new THREE.SphereGeometry(1, 24, 16)),
    /** A coarse unit sphere for the dots: cat's eyes and rooftop beacons, never more than a few pixels. */
    pebble: own(new THREE.SphereGeometry(1, 8, 6)),
    material(color: number, metalness = 0.7, roughness = 0.24) {
      return kit.keep(
        new THREE.MeshPhysicalMaterial({
          color,
          metalness,
          roughness,
          clearcoat: 0.85,
          clearcoatRoughness: 0.2,
        })
      );
    },
    keep<T extends THREE.Material>(material: T) {
      materials.add(material);
      return material;
    },
    texture<T extends THREE.Texture>(texture: T) {
      textures.add(texture);
      return texture;
    },
    /**
     * The paint a car wears: one material per colour on the whole road. A
     * deep lacquer over metallic flake: the clearcoat is what the lamps and
     * the headlights of the next car slide across.
     */
    paint(color: number) {
      const made =
        paints.get(color) ??
        kit.keep(
          new THREE.MeshPhysicalMaterial({
            color,
            metalness: 0.55,
            roughness: 0.3,
            clearcoat: 1,
            clearcoatRoughness: 0.08,
            envMapIntensity: 1.3,
          })
        );
      paints.set(color, made);
      return made;
    },
    boxGeometry(w: number, h: number, d: number, radius: number) {
      const key = `${w}:${h}:${d}:${radius}`;
      const made = boxes.get(key) ?? own(new RoundedBoxGeometry(w, h, d, 3, radius));
      boxes.set(key, made);
      return made;
    },
    own,
    dispose() {
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      textures.forEach((texture) => texture.dispose());
    },
  };
  return kit;
}
/** A seeded stream, so the grain of the road is the same on every mount. */
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** A hash of two integers to 0..1, and tiling value noise built on it. */
const hash2 = (x: number, y: number) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
function tiledNoise(u: number, v: number, cells: number) {
  const x = u * cells,
    y = v * cells;
  const xi = Math.floor(x),
    yi = Math.floor(y);
  const fx = x - xi,
    fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx),
    sy = fy * fy * (3 - 2 * fy);
  const at = (i: number, j: number) =>
    hash2((((xi + i) % cells) + cells) % cells, (((yi + j) % cells) + cells) % cells);
  const top = at(0, 0) + (at(1, 0) - at(0, 0)) * sx;
  const bottom = at(0, 1) + (at(1, 1) - at(0, 1)) * sx;
  return top + (bottom - top) * sy;
}
/**
 * A soft disc: white, solid at the centre and clear at the rim. The one alpha
 * every headlight pool, under-car glow, lamp pool, impact burst and contact
 * shadow here is cut from. Pure arithmetic, so it needs no canvas.
 */
function softDisc(kit: SceneParts, size = 128, power = 1.6) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5,
        dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(1 - d * d * (3 - 2 * d), power);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  const texture = new THREE.DataTexture(data, size, size);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return kit.texture(texture);
}
/**
 * A headlight beam on the road: brightest at the lamps (v = 0), narrow there
 * and opening out as it fades down the lane. Pure arithmetic, no canvas.
 */
function beamTexture(kit: SceneParts, size = 128) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size,
        v = 1 - (y + 0.5) / size;
      const spread = 0.1 + 0.42 * v;
      const across = Math.exp(-(((u - 0.5) / spread) ** 2));
      const along = Math.pow(1 - v, 1.4) * Math.min(1, v * 12);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(clamp01(across * along) * 255);
    }
  const texture = new THREE.DataTexture(data, size, size);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return kit.texture(texture);
}
/**
 * THE ASPHALT, GENERATED ONCE. One lane's width of road (u runs 0 to 1 across
 * a street, v along it), tiled: a charcoal base with fine grain, a broad low
 * frequency mottle, two tyre-worn tracks that are darker and, in the
 * roughness map, smoother, so the lamps and the headlights reflect as soft
 * wet streaks along the wheel lines and not as a mirror. The centre of the
 * lane between the tracks sits a touch lighter. Pure arithmetic, no canvas.
 */
function asphaltTextures(kit: SceneParts, anisotropy: number) {
  const size = 512;
  const color = new Uint8Array(size * size * 4),
    rough = new Uint8Array(size * size * 4);
  const rand = seeded(1877);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size,
        v = (y + 0.5) / size;
      const grain = rand();
      // Two octaves of tiling noise: patches of older and newer surface.
      const mottle =
        tiledNoise(u, v, 5) * 0.55 + tiledNoise(u, v, 19) * 0.3 + tiledNoise(u, v, 61) * 0.15 - 0.5;
      // A barely-there wander in the tracks. It was 0.018 when the camera
      // looked down at 37 degrees; at the horizon pose the far road is seen at
      // a grazing angle, where a larger wander prints as ripples across it.
      const wobble = 0.004 * Math.sin(v * Math.PI * 6 + u * 9);
      const track = Math.min(
        1,
        Math.exp(-(((u - 0.26 + wobble) / 0.075) ** 2)) +
          Math.exp(-(((u - 0.74 - wobble) / 0.075) ** 2))
      );
      const centre = Math.exp(-(((u - 0.5) / 0.14) ** 2));
      // Faint lengthwise streaks inside the tracks: rubber laid down over years.
      const streak = track * 0.03 * Math.sin(v * 190 + u * 40) * (0.5 + 0.5 * Math.sin(u * 300));
      const g = clamp01(
        0.37 + 0.09 * mottle - 0.1 * track + 0.03 * centre + (grain - 0.5) * 0.11 + streak
      );
      const i = (y * size + x) * 4;
      color[i] = Math.round(clamp01(g * 0.93) * 255);
      color[i + 1] = Math.round(g * 255);
      color[i + 2] = Math.round(clamp01(g * 1.1) * 255);
      color[i + 3] = 255;
      const r = clamp01(0.94 - 0.36 * track - 0.06 * grain + 0.06 * mottle);
      rough[i] = rough[i + 2] = 0;
      rough[i + 1] = Math.round(r * 255);
      rough[i + 3] = 255;
    }
  const tiled = (data: Uint8Array, srgb: boolean) => {
    const texture = new THREE.DataTexture(data, size, size);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = anisotropy;
    if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return kit.texture(texture);
  };
  return { map: tiled(color, true), roughnessMap: tiled(rough, false) };
}
/**
 * The road runs this far either side of the donkey's line, and past both
 * shoulders. With the horizon in frame (2026-09-25) the asphalt runs into the
 * haze: it ends 150 past the donkey's line, where the fog is already complete,
 * at the foot of the city; the dark land carries the haze on from there. The
 * dashes and the cat's eyes stop sooner, where they are already under a pixel
 * wide; the lane traffic turns round at TRAFFIC_Z.far, where a car is a few
 * pixels and a sixth hazed, and a car within five units of that end is scaled
 * toward nothing so it recedes rather than pops.
 */
const ROAD_Z = { near: 14, far: -150 } as const;
const ROAD_X = { left: -18, right: 60 } as const;
const MARKINGS_FAR = -120;
const EYES_FAR = -62;
const TRAFFIC_LAP = TRAFFIC_Z.near - TRAFFIC_Z.far;
/** The x where each column of the road starts: the left pavement, sixteen streets, the right pavement. */
/** The streets the scene builds: the starting shoulder and fifteen lanes. */
const SIGN_SLOTS = 16;
const ROAD_EDGES = [
  ROAD_X.left,
  ...Array.from({ length: SIGN_SLOTS }, (_, i) => streetCenter(i) - STREET_WIDTH / 2),
  streetCenter(SIGN_SLOTS - 1) + STREET_WIDTH / 2,
  ROAD_X.right,
];
/**
 * ONE ROAD, ONE MESH. Eighteen columns of one plane, each with its own four
 * vertices so a street's tint stops dead at its line, and one colour per
 * column that the ladder repaints (paintRoad). The asphalt tiles once per
 * street across and once per street along, so the worn tracks sit in every
 * lane where the wheels run.
 */
function roadGeometry(kit: SceneParts) {
  const columns = ROAD_EDGES.length - 1;
  const position = new Float32Array(columns * 12),
    normal = new Float32Array(columns * 12),
    uv = new Float32Array(columns * 8),
    color = new Float32Array(columns * 12);
  const index: number[] = [];
  for (let c = 0; c < columns; c++) {
    const x0 = ROAD_EDGES[c],
      x1 = ROAD_EDGES[c + 1];
    const corners = [
      [x0, ROAD_Z.near],
      [x1, ROAD_Z.near],
      [x0, ROAD_Z.far],
      [x1, ROAD_Z.far],
    ];
    corners.forEach(([x, z], k) => {
      const v = c * 4 + k;
      position.set([x, 0, z], v * 3);
      normal.set([0, 1, 0], v * 3);
      uv.set([(x + STREET_WIDTH / 2) / STREET_WIDTH, z / STREET_WIDTH], v * 2);
      color.set([1, 1, 1], v * 3);
    });
    const a = c * 4;
    index.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setIndex(index);
  return kit.own(geometry);
}
/** A strip of road paint lying flat, x across, z0 to z1 along. */
function flatStrip(x: number, z0: number, z1: number, w: number, y = 0) {
  const g = new THREE.PlaneGeometry(w, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return g;
}
/** Every geometry merged into one, and the parts let go. */
function mergedFlat(kit: SceneParts, parts: THREE.BufferGeometry[]) {
  const merged = mergeGeometries(parts, false)!;
  parts.forEach((part) => part.dispose());
  return kit.own(merged);
}
/**
 * THE LANE MARKINGS, ONE MESH. Solid edge lines either side of the starting
 * shoulder and at the far side of the last street, and a dashed divider
 * between every pair of streets: 170 strips in one draw, crisp at any
 * distance because they are geometry and not texels.
 */
function markingsGeometry(kit: SceneParts) {
  const parts: THREE.BufferGeometry[] = [];
  const last = ROAD_EDGES[ROAD_EDGES.length - 2];
  for (const x of [-STREET_WIDTH / 2, STREET_WIDTH / 2, last])
    parts.push(flatStrip(x, ROAD_Z.far, ROAD_Z.near, 0.14, 0.012));
  for (let i = 1; i < SIGN_SLOTS - 1; i++) {
    const x = streetCenter(i) + STREET_WIDTH / 2;
    for (let z = MARKINGS_FAR + 1; z < ROAD_Z.near; z += 4)
      parts.push(flatStrip(x, z, z + 1.8, 0.11, 0.012));
  }
  return mergedFlat(kit, parts);
}

/**
 * THE HORIZON (2026-09-25). The camera looks 19.5 degrees down the road now,
 * not 37 (CROSSING_CAMERA), and the top quarter of the frame is what lies past
 * the far end of the highway: a sky, a city and the haze between. All of it is
 * built once here and none of it moves. The fog is the one colour the sky
 * wears at the horizon, so the road, the land and the sky meet in the same
 * navy with no seam between them.
 */
const SKY = {
  /** The haze at the horizon, which is also the fog colour: one value, or the ground would show a seam. */
  haze: 0x0f2446,
  /**
   * Up from the horizon, in degrees: the royal glow fading through deep navy
   * to obsidian. The camera sees about eight and a half degrees above the
   * horizon, so the whole ramp is spent inside that band and the top edge of
   * the frame is already night.
   */
  stops: [
    [0, 0x0f2446],
    [1.5, 0x0d2142],
    [4, 0x0a1832],
    [7, 0x07101f],
    [10, 0x050911],
    [90, 0x050607],
  ],
  radius: 420,
  stars: 190,
  /** The stars sit where the fixed camera can see them: this far round either side, and this band up. */
  starAzimuth: 70,
  starElevation: [2.2, 11] as const,
} as const;
/**
 * The city: a near row of blocks and a far row of towers, both in the haze.
 * The camera stands about five above the road, so a block's height above that
 * is what rises over the horizon; the tallest tower tops out near five
 * degrees, half way up the band of sky, so there is always night above it.
 */
const CITY = {
  front: -140,
  back: -186,
  fromX: -240,
  toX: 300,
  /** Front row: lowest, and how much taller the tallest are. */
  frontHeight: [7, 11] as const,
  backHeight: [10, 14] as const,
  /** The haze strip that stands in front of the city's foot. */
  hazeZ: -134,
  hazeHeight: 9,
} as const;
/** One repeat of the window texture covers this much building, across and up. */
const WINDOW_SPAN = { across: 9.2, up: 17.6 } as const;
/** The lamp posts: on the median beside every painted pool, a cobra head over the pool's street. */
const POST = { z: -4.2, height: 5.6, arm: 1.5 } as const;
/**
 * The idle attract: the two lamps that flicker, and the beats of the donkey's
 * ear flick and weight shift, in milliseconds at normal animation speed.
 */
const IDLE = {
  flickering: [1, 4] as const,
  earEvery: 3400,
  earMs: 260,
  shiftEvery: 5200,
  shiftMs: 900,
} as const;

/**
 * The sky: one dome, coloured at its vertices by elevation. Unfogged, drawn
 * first, never culled. Its triangles are wound to face inward and its colours
 * carry an alpha of one, so it is drawn by the very same program as the haze
 * strip (a front-faced, vertex-coloured, unfogged basic material): one program
 * fewer to compile when the scene mounts.
 */
function skyDome(kit: SceneParts) {
  const geometry = kit.own(new THREE.SphereGeometry(SKY.radius, 36, 180));
  const index = geometry.getIndex()!;
  for (let i = 0; i < index.count; i += 3) {
    const b = index.getX(i + 1);
    index.setX(i + 1, index.getX(i + 2));
    index.setX(i + 2, b);
  }
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 4);
  const stops = SKY.stops.map(([degrees, hex]) => ({ degrees, color: new THREE.Color(hex) }));
  const tint = new THREE.Color();
  for (let i = 0; i < position.count; i++) {
    const elevation =
      (Math.asin(Math.max(-1, Math.min(1, position.getY(i) / SKY.radius))) * 180) / Math.PI;
    let k = 0;
    while (k < stops.length - 2 && elevation > stops[k + 1].degrees) k++;
    const a = stops[k],
      b = stops[k + 1];
    const t = clamp01((elevation - a.degrees) / (b.degrees - a.degrees));
    tint.lerpColors(a.color, b.color, t * t * (3 - 2 * t));
    colors.set([tint.r, tint.g, tint.b, 1], i * 4);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const dome = new THREE.Mesh(
    geometry,
    kit.keep(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        fog: false,
        depthWrite: false,
      })
    )
  );
  dome.renderOrder = -2;
  dome.frustumCulled = false;
  return dome;
}
/**
 * A sparse starfield on the inside of the dome: static points, only in the
 * part of the sky the fixed camera can see, thinner low down where the haze
 * is and none behind the glow at the horizon itself. Seeded, never random.
 */
function starfield(kit: SceneParts, disc: THREE.Texture) {
  const n = SKY.stars,
    r = SKY.radius * 0.96;
  const position = new Float32Array(n * 3),
    color = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const azimuth = ((hash2(i, 1) * 2 - 1) * SKY.starAzimuth * Math.PI) / 180;
    const [low, high] = SKY.starElevation;
    const elevation = ((low + (high - low) * Math.pow(hash2(i, 2), 0.6)) * Math.PI) / 180;
    position.set(
      [
        r * Math.cos(elevation) * Math.sin(azimuth),
        r * Math.sin(elevation),
        -r * Math.cos(elevation) * Math.cos(azimuth),
      ],
      i * 3
    );
    const bright = 0.3 + 0.7 * Math.pow(hash2(i, 3), 2.4);
    const warm = hash2(i, 4) < 0.3;
    color.set([bright * (warm ? 1 : 0.85), bright * (warm ? 0.95 : 0.92), bright], i * 3);
  }
  const geometry = kit.own(new THREE.BufferGeometry());
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  const stars = new THREE.Points(
    geometry,
    kit.keep(
      new THREE.PointsMaterial({
        size: 2.2,
        sizeAttenuation: false,
        map: disc,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      })
    )
  );
  stars.renderOrder = -1;
  stars.frustumCulled = false;
  return stars;
}
/**
 * THE WINDOWS, GENERATED ONCE, AND THE WALLS BETWEEN THEM: eight columns and sixteen floors per repeat,
 * most dark, some warm white at their own brightness, a few royal blue. Pure
 * arithmetic on the seeded hash, no canvas, so it is the same city on every
 * mount and under every test double. Mipmapped, because at the city's
 * distance a window is a pixel or less and should average, not shimmer.
 */
function windowsTexture(kit: SceneParts) {
  const size = 256,
    cols = 8,
    rows = 16;
  const cw = size / cols,
    ch = size / rows;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const col = Math.floor(x / cw),
        row = Math.floor(y / ch);
      const px = x - col * cw,
        py = y - row * ch;
      const pane = px >= 10 && px < 22 && py >= 5 && py < 11;
      const r = hash2(col + 3, row + 5);
      const i = (y * size + x) * 4;
      // The wall between the windows is the building's own night colour: the
      // city is drawn unlit, so this texture is all of its colour.
      let red = 12,
        green = 16,
        blue = 24;
      if (pane && r < 0.15) {
        const b = 0.4 + 0.6 * hash2(col + 17, row + 29);
        red = 255 * b;
        green = 226 * b;
        blue = 184 * b;
      } else if (pane && r < 0.19) {
        red = 62;
        green = 156;
        blue = 230;
      }
      data[i] = red;
      data[i + 1] = green;
      data[i + 2] = blue;
      data[i + 3] = 255;
    }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return kit.texture(texture);
}
/**
 * THE CITY, ONE MESH. About seventy-five dark blocks in two rows along the far
 * side of the highway, each its own width, depth and height, merged into one
 * geometry with its window texture scaled per building so a window is always
 * the same size and offset per building so no two light the same panes. The
 * tallest carry a beacon: one instanced draw of red and blue dots. The fog
 * is complete well before the city (the road has to vanish into it), so the
 * city takes no fog of its own: it stands as a dark silhouette against the
 * glow at the horizon, and one gradient strip of the haze colour in front of
 * its foot (hazeStrip) sinks both rows into the haze. Everything here is
 * behind the end of the traffic, so it never stands in front of the road or
 * a sign.
 */
function skyline(kit: SceneParts, windows: THREE.Texture) {
  const parts: THREE.BufferGeometry[] = [];
  const tops: [number, number, number][] = [];
  let id = 0;
  for (const row of [0, 1]) {
    let x = CITY.fromX - 40 * row;
    while (x < CITY.toX + 40 * row) {
      const w = 5 + 9 * hash2(id, 11),
        d = 6 + 8 * hash2(id, 12);
      const tall = Math.pow(hash2(id, 13), 1.7);
      const [lowest, taller] = row ? CITY.backHeight : CITY.frontHeight;
      const h = lowest + taller * tall;
      const z = (row ? CITY.back : CITY.front) - hash2(id, 14) * 8;
      const block = new THREE.BoxGeometry(w, h, d);
      block.translate(x + w / 2, h / 2, z);
      // Faces come px, nx, py, ny, pz, nz, four corners each; the x faces span
      // the depth and the z faces the width. The top and bottom are never seen.
      const uv = block.getAttribute('uv') as THREE.BufferAttribute;
      const ox = Math.floor(hash2(id, 15) * 8) / 8,
        oy = Math.floor(hash2(id, 16) * 16) / 16;
      for (let v = 0; v < uv.count; v++) {
        const face = Math.floor(v / 4);
        const across = face < 2 ? d : w;
        uv.setXY(
          v,
          ox + (uv.getX(v) * across) / WINDOW_SPAN.across,
          oy + (uv.getY(v) * h) / WINDOW_SPAN.up
        );
      }
      // Unlit, so the shading is painted on: the faces turned across the view
      // a little darker than the ones facing it, the far row a little hazier.
      const shade = new Float32Array(uv.count * 3);
      for (let v = 0; v < uv.count; v++) {
        const k = (Math.floor(v / 4) < 2 ? 0.6 : 1) * (row ? 0.85 : 1);
        shade.set([k, k, k], v * 3);
      }
      block.setAttribute('color', new THREE.BufferAttribute(shade, 3));
      parts.push(block);
      if (h > lowest + taller * 0.55 && hash2(id, 17) < 0.7) tops.push([x + w / 2, h + 0.3, z]);
      x += w + 1.5 + 8 * hash2(id, 18);
      id++;
    }
  }
  const city = new THREE.Mesh(
    mergedFlat(kit, parts),
    kit.keep(
      // Unlit and unfogged: a basic program is a fraction of a lit one to
      // compile, and no light in this scene reaches the city anyway.
      new THREE.MeshBasicMaterial({
        map: windows,
        vertexColors: true,
        fog: false,
      })
    )
  );
  // A little over one, so a lit window still reads bright through the tone
  // mapping; the walls stay near black.
  (city.material as THREE.MeshBasicMaterial).color.setScalar(1.4);
  city.frustumCulled = false;
  const beacons = new THREE.InstancedMesh(
    kit.pebble,
    kit.keep(new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false })),
    Math.max(1, tops.length)
  );
  const at = new THREE.Matrix4(),
    tint = new THREE.Color();
  tops.forEach(([x, y, z], i) => {
    at.makeScale(0.5, 0.5, 0.5);
    at.setPosition(x, y, z);
    beacons.setMatrixAt(i, at);
    beacons.setColorAt(i, tint.setHex(i % 3 ? 0xff5b6e : 0x45adff));
  });
  if (!tops.length) beacons.setMatrixAt(0, at.makeScale(0, 0, 0));
  beacons.instanceMatrix.needsUpdate = true;
  beacons.frustumCulled = false;
  return { city, beacons, haze: hazeStrip(kit) };
}
/**
 * THE HAZE AT THE CITY'S FOOT: one wide quad standing across the view just in
 * front of the city, the fog colour at the ground fading to nothing a few
 * storeys up, so the blocks rise out of the same navy the road runs into.
 * Vertex colour with alpha, unlit, unfogged, drawn after the city.
 */
function hazeStrip(kit: SceneParts) {
  const width = CITY.toX - CITY.fromX + 200;
  const geometry = kit.own(
    new THREE.PlaneGeometry(width, CITY.hazeHeight, 1, 4).translate(
      (CITY.toX + CITY.fromX) / 2,
      CITY.hazeHeight / 2 - 0.5,
      CITY.hazeZ
    )
  );
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 4);
  const haze = new THREE.Color(SKY.haze);
  for (let i = 0; i < position.count; i++) {
    const up = clamp01((position.getY(i) + 0.5) / CITY.hazeHeight);
    colors.set([haze.r, haze.g, haze.b, 0.92 * (1 - up) ** 1.6], i * 4);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const strip = new THREE.Mesh(
    geometry,
    kit.keep(
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        fog: false,
      })
    )
  );
  strip.frustumCulled = false;
  return strip;
}
/**
 * THE LAMP POSTS, THREE DRAWS. A post on the median beside every painted
 * pool, its arm reaching over the pool's street: one instanced draw for the
 * poles and arms (lit steel), one for the heads (a flat warm light that fog
 * dims but no lamp shades), and one for the glow at each head, an additive
 * disc tilted to face the camera's fixed pitch. Geometry and emissive only:
 * the real SpotLight budget (three lights, one caster) is untouched. The
 * heads and glows carry an instance colour each, which is how one lamp
 * flickers on its own in the idle attract.
 */
function lampPosts(kit: SceneParts, disc: THREE.Texture) {
  const streets = Array.from({ length: Math.floor((SIGN_SLOTS - 1) / 2) }, (_, i) => 2 + i * 2);
  const pole = new THREE.CylinderGeometry(0.07, 0.1, POST.height, 8).translate(
    0,
    POST.height / 2,
    0
  );
  const arm = new THREE.BoxGeometry(POST.arm, 0.1, 0.1).translate(
    -POST.arm / 2 + 0.05,
    POST.height - 0.05,
    0
  );
  const poles = new THREE.InstancedMesh(
    mergedFlat(kit, [pole, arm]),
    kit.keep(new THREE.MeshStandardMaterial({ color: 0x9aa5b3, metalness: 0.8, roughness: 0.34 })),
    streets.length
  );
  const heads = new THREE.InstancedMesh(
    kit.own(new THREE.BoxGeometry(0.62, 0.14, 0.3)),
    kit.keep(new THREE.MeshBasicMaterial({ color: 0xffe9c8 })),
    streets.length
  );
  const glows = new THREE.InstancedMesh(
    kit.own(new THREE.PlaneGeometry(1, 1).rotateX((-CROSSING_CAMERA.pitch * Math.PI) / 180)),
    kit.keep(
      new THREE.MeshBasicMaterial({
        map: disc,
        color: 0xffd7a3,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        // Nearer than the fog starts; unfogged, the glows share the painted
        // pools' program.
        fog: false,
      })
    ),
    streets.length
  );
  const at = new THREE.Matrix4(),
    white = new THREE.Color(0xffffff);
  streets.forEach((street, i) => {
    const x = streetCenter(street) + STREET_WIDTH / 2;
    at.makeTranslation(x, 0, POST.z);
    poles.setMatrixAt(i, at);
    at.makeTranslation(x - POST.arm + 0.2, POST.height - 0.12, POST.z);
    heads.setMatrixAt(i, at);
    at.makeScale(3.4, 3.4, 1);
    at.setPosition(x - POST.arm + 0.2, POST.height - 0.2, POST.z + 0.25);
    glows.setMatrixAt(i, at);
    heads.setColorAt(i, white);
    glows.setColorAt(i, white);
  });
  for (const mesh of [poles, heads, glows]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
  }
  // The poles take the key light's shadow like the cars do, which also lets
  // them share the program the cars' plain standard parts already compile.
  poles.receiveShadow = true;
  return { poles, heads, glows };
}
/** A flat quad in a car's own space, coloured at its vertices. */
function glowQuad(x: number, z: number, w: number, d: number, hex: number, y = 0.02) {
  const g = flatStrip(x, z - d / 2, z + d / 2, w, y);
  const c = new THREE.Color(hex);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < g.attributes.position.count; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}
/**
 * THE LIGHT A CAR THROWS ON THE ROAD, in the car's own space: a faint blue
 * underglow beneath it and the red wash of its tail lights behind, drawn with
 * the soft disc, and the headlight beam ahead of it, drawn with the beam. Two
 * additive quad sets per car.
 */
function carGlowGeometry(kit: SceneParts) {
  return mergedFlat(kit, [
    glowQuad(0, 0.1, 2.7, 3.9, 0x0c2c60),
    glowQuad(0, -2.05, 2.0, 2.0, 0x8a1a06),
  ]);
}
function carBeamGeometry(kit: SceneParts) {
  return mergedFlat(kit, [glowQuad(0, 4.6, 3.6, 6.6, 0xdff2ff)]);
}
/**
 * A group baked flat into one geometry in its own space: the ghost of the
 * donkey is one translucent mesh where the donkey itself is twelve.
 */
function bakeGroup(kit: SceneParts, root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const list: THREE.BufferGeometry[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const geometry = obj.geometry as THREE.BufferGeometry;
    const baked = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    baked.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, obj.matrixWorld));
    list.push(baked);
  });
  return mergedFlat(kit, list);
}
type SceneParts = ReturnType<typeof sceneParts>;
function box(
  kit: SceneParts,
  parent: THREE.Object3D,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  radius = 0.08
) {
  const mesh = new THREE.Mesh(kit.boxGeometry(w, h, d, radius), mat);
  mesh.position.set(x, y, z);
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function sphere(
  kit: SceneParts,
  parent: THREE.Object3D,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number
) {
  const mesh = new THREE.Mesh(kit.ball, mat);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  parent.add(mesh);
  return mesh;
}
/**
 * ONE MESH PER MATERIAL INSTEAD OF ONE PER PART. Each part's transform is
 * baked into a copy of its shared geometry and the copies are merged, so a car
 * draws about six meshes where it drew seventeen and a donkey a dozen where it
 * drew thirty two. Nothing here moves relative to its parent - the donkey's
 * legs are groups, not meshes, and are left exactly as they are.
 */
function mergeParts(kit: SceneParts, parent: THREE.Object3D) {
  const parts = parent.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh);
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  for (const part of parts) {
    part.updateMatrix();
    const material = part.material as THREE.Material;
    // Spheres and cylinders are indexed and rounded boxes are not; one merge
    // takes either, never a mix of the two.
    const baked = part.geometry.index ? part.geometry.toNonIndexed() : part.geometry.clone();
    baked.applyMatrix4(part.matrix);
    buckets.set(material, [...(buckets.get(material) ?? []), baked]);
  }
  const merged = [...buckets].map(([material, list]) => {
    // Every part above carries position, normal and uv and none is indexed,
    // which is the whole of what three refuses a merge for.
    const geometry = list.length === 1 ? list[0] : mergeGeometries(list, false)!;
    list.forEach((one) => one !== geometry && one.dispose());
    const mesh = new THREE.Mesh(kit.own(geometry), material);
    mesh.receiveShadow = true;
    return mesh;
  });
  parts.forEach((part) => parent.remove(part));
  parent.add(...merged);
  return merged;
}

/** Original sculpted donkey, with separate ears, muzzle, mane, tail and walking legs. */
function donkey(kit: SceneParts) {
  const animal = new THREE.Group();
  // A matte coat with a sheen, the way short fur takes a rim light: the blue
  // rim from behind the road and the warm lamp pool both catch on it without
  // ever reading as lacquer. The hooves and the muzzle are the only gloss.
  const coat = kit.material(0x7a6e60, 0, 0.92),
    pale = kit.material(0xd9cec0, 0, 0.88);
  const dark = kit.material(0x1c2127, 0.1, 0.42),
    eye = kit.material(0x080b0d, 0.1, 0.05);
  for (const fur of [coat, pale]) {
    fur.clearcoat = 0;
    fur.sheen = 0.6;
    fur.sheenRoughness = 0.7;
    fur.sheenColor.setHex(0x9ab8d8);
    fur.envMapIntensity = 0.5;
  }
  sphere(kit, animal, coat, 0, 0.95, 0, 0.65, 0.43, 0.35);
  sphere(kit, animal, pale, 0, 0.8, 0, 0.49, 0.28, 0.32);
  const legs: THREE.Group[] = [];
  for (const x of [-0.38, 0.4])
    for (const z of [-0.23, 0.23]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.82, z);
      leg.name = `walking-leg-${legs.length}`;
      sphere(kit, leg, coat, 0, -0.25, 0, 0.1, 0.34, 0.105);
      box(kit, leg, dark, 0.035, -0.61, 0, 0.22, 0.17, 0.21, 0.06);
      animal.add(leg);
      legs.push(leg);
    }
  sphere(kit, animal, coat, 0.49, 1.27, 0, 0.25, 0.51, 0.26).rotation.z = -0.35;
  sphere(kit, animal, coat, 0.68, 1.66, 0, 0.35, 0.3, 0.28);
  sphere(kit, animal, pale, 0.96, 1.52, 0, 0.28, 0.21, 0.255);
  // The ears are groups like the legs, pivoted at their base, so the idle
  // attract can flick one; the parts inside each are merged as the body's are.
  const ears: THREE.Group[] = [];
  for (const z of [-0.215, 0.215]) {
    sphere(kit, animal, eye, 0.83, 1.74, z, 0.064, 0.076, 0.034);
    sphere(kit, animal, pale, 0.84, 1.77, z * 1.1, 0.018, 0.019, 0.014);
    sphere(kit, animal, dark, 1.16, 1.55, z * 0.75, 0.035, 0.023, 0.03);
    const ear = new THREE.Group();
    ear.position.set(0.53, 1.68, z * 0.65);
    ear.name = `ear-${ears.length}`;
    sphere(kit, ear, coat, 0, 0.37, 0, 0.095, 0.4, 0.105).rotation.z = 0.13;
    sphere(kit, ear, pale, 0.03, 0.41, 0, 0.045, 0.26, 0.108).rotation.z = 0.13;
    mergeParts(kit, ear);
    animal.add(ear);
    ears.push(ear);
  }
  for (let i = 0; i < 7; i++)
    sphere(kit, animal, dark, 0.3 + i * 0.045, 1.33 + i * 0.078, 0, 0.07, 0.095, 0.14);
  const tail = sphere(kit, animal, coat, -0.72, 0.9, 0, 0.055, 0.38, 0.055);
  tail.rotation.z = -0.7;
  sphere(kit, animal, dark, -0.94, 0.66, 0, 0.11, 0.17, 0.11);
  // The donkey is the shadow of this scene: it and the cars beside it are the
  // only things that cast one, and its sculpt draws as four meshes, not thirty.
  mergeParts(kit, animal);
  animal.traverse((obj) => {
    if (obj instanceof THREE.Mesh) obj.castShadow = true;
  });
  return { animal, legs, ears };
}

export default function ChoiceScene(props: Props) {
  if (props.game === 'mines') return <MinesGrid {...props} />;
  return <CrossingScene {...props} />;
}

/**
 * The four street tints, safe to dangerous, on the asphalt itself: vertex
 * colours over the one asphalt texture, so a street's tint stops at its line.
 * The road deepens toward black as the streets pay more (the
 * #SmarterCasinoRealism panel, carbon and obsidian tones), so the gold-edged
 * signs of the big streets read on black. It no longer warms toward maroon
 * (Dan: "ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS").
 */
const STREET_TINTS = [0x3a4a60, 0x303d4e, 0x28313d, 0x222931];
/** The pavements either side of the road: pale concrete against the charcoal. */
const PAVEMENT_TINT = 0x7f8c9b;
/**
 * The painted sign inks are the strip's own (ChoiceScene.module.css), so a
 * street reads the same on the road as in the strip: a black glass plate in a
 * chrome bevel, the street number in light blue, the multiplier in gold, and
 * an edge that carries the rise toward the big streets, chrome to pale gold to
 * gold to a gold-red. The street underfoot and the next one light an
 * electric-blue LED edge, a crossed street goes to plain chrome, a street the
 * ghost of a booked win reaches lights gold, and bust red is the crash alone.
 */
const SIGN_INK = {
  plate: '#05070a',
  bevel: '#3a4756',
  label: '#45adff',
  figure: '#ffd700',
  start: '#e6edf3',
  led: '#45adff',
  bust: '#ff5b6e',
  gold: '#ffd700',
  spentEdge: '#9aa5b3',
  spentInk: '#9aa5b3',
  edge: ['#9aa5b3', '#e8c877', '#ffd700', '#ff8a62'],
} as const;
/**
 * The eight paints on the road: the first four are the near lane, the last
 * four the far one. The lane traffic is drawn instanced, so a paint is one
 * instance colour over the one white lacquer, not a material of its own.
 * #SMARTERCASINOREALISM - black first, blue only as energy, gold only for
 * value: obsidian, graphite, gunmetal, midnight navy, royal blue, chrome and
 * pearl, and one deep crimson; never a candy colour and never a brown (Dan:
 * "ALWAYS USE SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS"). Gold
 * stays off the paint: on this road it belongs to the prizes.
 */
const CAR_PAINTS = [
  0x0f1114, 0x0f3f8f, 0xb8c3cd, 0x27313c, 0xe6edf3, 0x0f2140, 0x6e1420, 0x3a4756,
] as const;
/** Two lane cars per street, on every street after the starting shoulder. */
const LANE_CARS = (SIGN_SLOTS - 1) * 2;
const laneCar = (street: number, n: number) => (street - 1) * 2 + n;
/**
 * The car that comes to every street is obsidian, so its lit headlamps are the
 * threat rather than its paint. Gold on this road belongs to the prizes.
 */
const IMPACT_PAINT = 0x0f1114;
/** The clear colour under the sky dome: one obsidian, and the blue rim light
 *  is the only coloured light on the road. The haze itself is SKY.haze. */
const NIGHT = 0x05070a;
/** The impact glint, in milliseconds, against the 525 ms fall it is timed on. */
const GLINT = 120 / 525;
/** What the device says about itself, safely: jsdom and old browsers say nothing. */
function matches(query: string) {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}
/**
 * What a street's state adds to its spoken name, so a screen-reader player
 * hears the road the way it is painted. 'current' says nothing: aria-current
 * already names the street the donkey stands on.
 */
const STREET_SPOKEN: Record<StreetState, string> = {
  crash: ', Hit Here',
  crossed: ', Crossed',
  current: '',
  next: ', Next',
  ahead: '',
};
/** What a booked win's route adds: the streets it would have crossed, and the one it would not. */
const ROUTE_SPOKEN = {
  reachable: ', Would Have Been Crossed',
  crash: ', Would Have Been The Crash',
} as const;

/** What the scene is showing, which trails the confirmed round it is playing out. */
interface Shown {
  roundId: string;
  step: number;
  phase: Props['phase'];
}
/** A beat the scene still owes the page, and the frame that earns it. */
interface Pending {
  moments: readonly CrossingMoment[];
  next: Shown;
  at: 'now' | 'walk' | 'hit';
}
/**
 * The beats a confirmed advance owes, and when they are played: a crossing
 * lands when the walk completes, a collision reads when the car reaches the
 * donkey, and a win booked on the street the donkey already stands on has
 * nothing left to walk for.
 */
function momentsFor(prev: Shown, next: Shown): Pick<Pending, 'moments' | 'at'> {
  if (next.phase === 'lost') return { moments: ['hit'], at: 'hit' };
  if (next.phase === 'open') return { moments: ['landed'], at: 'walk' };
  if (next.phase === 'cashed')
    return next.step > prev.step
      ? { moments: ['landed', 'booked'], at: 'walk' }
      : { moments: ['booked'], at: 'now' };
  return { moments: [], at: 'now' };
}

function CrossingScene(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
  // The page hands the round's own ladder down; this is only the shape drawn
  // before one arrives, so it is the ladder a new round is dealt today.
  const ladder = props.ladder ?? ROAD_LADDERS_V4[CHOICE_MODE.crossing];
  const step = props.picked.length;
  /**
   * THE SCENE OWNS THE REVEAL. A confirmed answer lands on the page the moment
   * the server speaks, half a second before the car reaches the donkey. Every
   * surface the scene draws reads from what it is SHOWING instead: the
   * caption, the readout, the bust stamp and the strip stay on the street the
   * donkey is actually standing on until the beat arrives.
   */
  const [shown, setShown] = useState<Shown>(() => ({
    roundId: props.roundId ?? '',
    step,
    phase: props.phase,
  }));
  const shownRef = useRef(shown);
  /**
   * The street the ghost of a booked win has walked to, -1 while there is no
   * ghost on the road. The strip lights the streets behind it gold as it goes,
   * the same beat the signs on the road do.
   */
  const [ghostAt, setGhostAt] = useState(-1);
  const pending = useRef<Pending | null>(null);
  /** Whether the car coming to this street has already sounded its horn. */
  const horned = useRef(false);
  // Held in a ref so the draw loop, which is mounted once, always calls the
  // live one without listing it as a dependency it cannot have.
  const commit = useRef((next: Shown, moments: readonly CrossingMoment[], instant = false) => {
    pending.current = null;
    shownRef.current = next;
    setShown(next);
    for (const moment of moments) {
      /* THE BEATS ARE HEARD AND FELT HERE (2026-09-26), on the frame that
         shows them, the same frame the page is told. They moved here from the
         page's onMoment so there is one owner and never two: a landing is a
         light tick and buzz, a hit is the impact (with the horn, when there
         was no approach to sound it in) and a strong buzz, a booked win is the
         booked sting and a medium buzz. Reduced motion and a scene that cannot
         draw commit through this same door, so they keep every beat.
         Committed at once (reduced motion, or a scene that cannot draw), there
         was no walk and no approach to hear, so the street still gets its
         meaning in sound: one hoof step, and a safe street's squeal to a stop
         before the landing tick (a hit carries its horn in the impact). */
      if (instant && (moment === 'landed' || moment === 'hit')) soundService.playCrossingHoof(0);
      if (moment === 'landed') {
        if (instant) soundService.playCrossingBrake(getAnimationSpeed());
        soundService.playCrossingLanded(next.step);
      } else if (moment === 'hit') {
        soundService.playCrossingHit({ withHorn: !horned.current, speed: getAnimationSpeed() });
        horned.current = false;
      } else {
        const road = latest.current.ladder ?? ROAD_LADDERS_V4[CHOICE_MODE.crossing];
        const at = Math.min(Math.max(next.step, 1), road.length) - 1;
        soundService.playBonusBooked((road[at] ?? 100) / 100);
      }
      latest.current.onMoment?.(moment, next.step);
    }
  });
  const lost = shown.phase === 'lost';
  // Read as a subscription, not once at mount: a player who turns the setting
  // on mid-round gets it on the next frame, and the scene stops redrawing.
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const reducedRef = useRef(reducedMotion);
  reducedRef.current = reducedMotion;
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      return;
    }
    const changed = () => setReducedMotion(query.matches);
    changed();
    query.addEventListener?.('change', changed);
    return () => query.removeEventListener?.('change', changed);
  }, []);
  useEffect(() => {
    if (failed) latest.current.onSettled?.();
  }, [failed, props.phase, props.picked.length]);
  // A scene with no animation to time the reveal against gives it at once:
  // reduced motion, and a scene whose animation has failed. The same rule as
  // the failed -> onSettled effect above.
  useEffect(() => {
    if (!failed && !reducedMotion) return;
    const was = shownRef.current;
    const next: Shown = { roundId: props.roundId ?? '', step, phase: props.phase };
    if (was.roundId === next.roundId && was.step === next.step && was.phase === next.phase) return;
    const advanced = next.roundId !== '' && next.roundId === was.roundId && next.phase !== 'idle';
    commit.current(next, advanced ? momentsFor(was, next).moments : [], true);
  }, [failed, reducedMotion, props.roundId, props.phase, step]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try {
      // alpha: the canvas stays transparent until its first frame, so the CSS
      // placeholder under it shows while the programs compile; the scene's
      // opaque background clears every drawn frame to alpha 1.
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        alpha: true,
      });
    } catch (e) {
      setFailed(true);
      reportError(e, 'ChoiceScene.renderer');
      latest.current.onSettled?.();
      return;
    }
    const canvas = renderer.domElement;
    canvas.className = styles.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    node.prepend(canvas);
    // A CPU rasteriser starts at the floor tier; everything else starts at the
    // tier this session has found and steps down if the frames say so
    // (qualityGovernor.ts). Every element stays; only resolution and shadows move.
    const software = isSoftwareRenderer(
      typeof renderer.getContext === 'function' ? renderer.getContext() : null
    );
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    const kit = sceneParts();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(NIGHT);
    // The fog is the sky's own colour at the horizon (SKY.haze), so the far
    // road, the land and the dome meet in one navy with no seam.
    const fog = new THREE.Fog(SKY.haze, 22, 65);
    scene.fog = fog;
    // Nothing is within half a unit of a camera that stands 4.5 above the
    // road; a near plane there keeps the depth buffer fine enough for the
    // paint and the signs on asphalt that now runs 300 deep.
    const camera = new THREE.PerspectiveCamera(CROSSING_CAMERA.fov, 1, 0.5, 100);
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment(),
      environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.26;
    room.dispose();
    pmrem.dispose();
    /**
     * THREE LIGHTS, ONE SHADOW (CLAUDE.md: at most three real-time lights and
     * one caster). A cool overhead key that casts the one shadow map; the blue
     * rim from behind the road, the only coloured light and the edge on every
     * car and on the donkey's coat; and the lamp: a warm spot that stands over
     * whatever the camera is looking at, so the donkey and the street it is
     * crossing always sit in a real pool of light with real reflections. The
     * pools on the other streets are painted (POOLS below). The ambient fill
     * is the environment map, which costs no light at all.
     */
    const key = new THREE.DirectionalLight(0xcfe0ff, 1.2);
    key.position.set(-5, 12, 8);
    key.castShadow = true;
    // A phone pays for the shadow map in heat and battery, and at this size on
    // this screen nobody can tell the two apart.
    const touch = matches('(pointer: coarse)');
    key.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 14, bottom: -14 });
    key.shadow.bias = -0.001;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0x45adff, 2.6);
    rim.position.set(5, 7, -6);
    scene.add(rim);
    const LAMP = 165;
    const lamp = new THREE.SpotLight(0xffe7c2, LAMP, 28, Math.PI / 4.2, 0.75, 1.6);
    lamp.position.set(1.4, 8.5, 0.8);
    lamp.target.position.set(1.4, 0, -0.6);
    scene.add(lamp, lamp.target);
    const anisotropy = renderer.capabilities?.getMaxAnisotropy?.() ?? 1;
    const disc = softDisc(kit);
    // Past the end of the highway: the sky, its stars, the dark land the road
    // runs through, the city in the haze and, nearer, the lamp posts. Built
    // once; nothing here is touched again except two lamps in the idle attract.
    scene.add(skyDome(kit), starfield(kit, disc));
    const land = new THREE.Mesh(
      kit.own(new THREE.PlaneGeometry(1200, 620).rotateX(-Math.PI / 2).translate(30, -0.04, -280)),
      kit.keep(new THREE.MeshBasicMaterial({ color: 0x04070c }))
    );
    land.frustumCulled = false;
    scene.add(land);
    const distant = skyline(kit, windowsTexture(kit));
    scene.add(distant.city, distant.beacons, distant.haze);
    const posts = lampPosts(kit, disc);
    scene.add(posts.poles, posts.heads, posts.glows);
    const asphaltMaps = asphaltTextures(kit, Math.min(8, anisotropy));
    // Wet charcoal: a high roughness that the worn tracks lower, under a light
    // clearcoat, so lamps and headlights lie on the road as soft streaks.
    const asphalt = kit.keep(
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff,
        vertexColors: true,
        map: asphaltMaps.map,
        roughnessMap: asphaltMaps.roughnessMap,
        roughness: 1,
        metalness: 0.04,
        clearcoat: 0.3,
        clearcoatRoughness: 0.55,
        envMapIntensity: 0.3,
      })
    );
    const road = new THREE.Mesh(roadGeometry(kit), asphalt);
    road.receiveShadow = true;
    scene.add(road);
    const roadColor = road.geometry.getAttribute('color') as THREE.BufferAttribute;
    const chrome = kit.keep(
        new THREE.MeshPhysicalMaterial({
          color: 0xc9d2db,
          metalness: 1,
          roughness: 0.16,
          envMapIntensity: 1.6,
        })
      ),
      // Road paint: pale, matte, and lit a little from within so it reads on
      // the unlit streets too.
      paint = kit.keep(
        new THREE.MeshStandardMaterial({
          color: 0xe4e7ec,
          roughness: 0.55,
          metalness: 0,
          emissive: 0x9aa5b3,
          emissiveIntensity: 0.28,
        })
      ),
      concrete = kit.keep(
        new THREE.MeshStandardMaterial({ color: 0x8f99a4, roughness: 0.72, metalness: 0.12 })
      );
    const markings = new THREE.Mesh(markingsGeometry(kit), paint);
    markings.receiveShadow = true;
    scene.add(markings);
    // The kerbs: a concrete lip either side of the road, at the shoulder the
    // donkey starts from and at the far side of the last street.
    const kerbShape = kit.boxGeometry(0.34, 0.2, ROAD_Z.near - ROAD_Z.far, 0.04);
    const kerbs = new THREE.Mesh(
      mergedFlat(
        kit,
        [ROAD_EDGES[1] - 0.17, ROAD_EDGES[ROAD_EDGES.length - 2] + 0.17].map((x) =>
          kerbShape.clone().translate(x, 0.1, (ROAD_Z.near + ROAD_Z.far) / 2)
        )
      ),
      concrete
    );
    kerbs.castShadow = true;
    kerbs.receiveShadow = true;
    scene.add(kerbs);
    /**
     * THE CAT'S EYES: one reflective stud every four units down every divider,
     * blue-white on the lane lines and gold on the edge lines, as one
     * instanced draw. They are unlit, so they glint on the dark streets too.
     */
    const eyeLines = [
      ...[ROAD_EDGES[1], ROAD_EDGES[2], ROAD_EDGES[ROAD_EDGES.length - 2]].map((x) => ({
        x,
        gold: true,
      })),
      ...Array.from({ length: SIGN_SLOTS - 2 }, (_, i) => ({
        x: streetCenter(i + 1) + STREET_WIDTH / 2,
        gold: false,
      })),
    ];
    const eyeRows = Math.floor((ROAD_Z.near - EYES_FAR) / 4);
    const eyes = new THREE.InstancedMesh(
      kit.pebble,
      kit.keep(new THREE.MeshBasicMaterial({ color: 0xffffff })),
      eyeLines.length * eyeRows
    );
    const eyeAt = new THREE.Matrix4(),
      eyeTint = new THREE.Color();
    let eye = 0;
    for (const line of eyeLines)
      for (let r = 0; r < eyeRows; r++) {
        eyeAt.makeScale(0.07, 0.03, 0.1);
        eyeAt.setPosition(line.x, 0.02, EYES_FAR + 3 + r * 4);
        eyes.setMatrixAt(eye, eyeAt);
        eyes.setColorAt(eye++, eyeTint.setHex(line.gold ? 0xffd700 : 0x9fdcff));
      }
    eyes.instanceMatrix.needsUpdate = true;
    eyes.frustumCulled = false;
    scene.add(eyes);
    /** The painted lamp pools: a warm ellipse on every second street. */
    const glowPlane = kit.own(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2));
    const pools = new THREE.InstancedMesh(
      glowPlane,
      kit.keep(
        new THREE.MeshBasicMaterial({
          map: disc,
          color: 0xffe2b8,
          transparent: true,
          opacity: 0.045,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          fog: false,
        })
      ),
      Math.floor((SIGN_SLOTS - 1) / 2)
    );
    for (let i = 0; i < pools.count; i++) {
      eyeAt.makeScale(7, 1, 11);
      eyeAt.setPosition(streetCenter(2 + i * 2), 0.018, -1.2);
      pools.setMatrixAt(i, eyeAt);
      // A plain white instance colour: it changes nothing on screen, and it
      // lets the pools share one program with the lamp glows above them.
      pools.setColorAt(i, eyeTint.setHex(0xffffff));
    }
    pools.instanceMatrix.needsUpdate = true;
    pools.frustumCulled = false;
    scene.add(pools);
    const glass = kit.keep(
        new THREE.MeshPhysicalMaterial({
          color: 0x0a1626,
          metalness: 0.2,
          roughness: 0.04,
          clearcoat: 1,
          clearcoatRoughness: 0.03,
          envMapIntensity: 1.8,
        })
      ),
      rubber = kit.material(0x0a0d12, 0.02, 0.9),
      headlamp = kit.keep(
        new THREE.MeshStandardMaterial({
          color: 0xe3f8ff,
          emissive: 0xbfe9ff,
          emissiveIntensity: 4,
        })
      ),
      taillight = kit.keep(
        new THREE.MeshStandardMaterial({
          color: 0xf74932,
          emissive: 0xff2a3c,
          emissiveIntensity: 1.4,
          metalness: 0.1,
          roughness: 0.2,
        })
      ),
      carGlow = kit.keep(
        new THREE.MeshBasicMaterial({
          map: disc,
          vertexColors: true,
          transparent: true,
          opacity: 0.5,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      ),
      carBeam = kit.keep(
        new THREE.MeshBasicMaterial({
          map: beamTexture(kit),
          vertexColors: true,
          transparent: true,
          opacity: 0.8,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
    rubber.clearcoat = 0.1;
    const wheel = kit.own(new THREE.CylinderGeometry(0.27, 0.27, 0.22, 24));
    /**
     * THE CAR, BUILT ONCE. Every car on this road is the same body: a lower
     * hull and a raised bonnet and boot with a chrome belt line between them,
     * a tinted cabin under a painted roof, wheel arches, door seams, mirrors,
     * chrome bumpers and hub caps, lit headlamps, red tail lights, and the
     * light it throws on the road. It is merged into one geometry per material
     * here; the lane traffic then draws every part once for all thirty cars
     * (instanced), and the three cars that come to the donkey's street are
     * built from the same parts. Only the paint and the glass cast a shadow.
     */
    const template = (() => {
      const car = new THREE.Group(),
        body = kit.paint(CAR_PAINTS[0]);
      box(kit, car, body, 0, 0.44, 0, 1.42, 0.38, 2.82, 0.16);
      box(kit, car, body, 0, 0.64, 0, 1.3, 0.18, 2.52, 0.11);
      box(kit, car, glass, 0, 0.9, -0.12, 1.12, 0.5, 1.42, 0.2);
      box(kit, car, body, 0, 1.17, -0.15, 1.0, 0.08, 0.98, 0.06);
      for (const side of [-1, 1]) {
        box(kit, car, chrome, side * 0.715, 0.6, -0.05, 0.02, 0.03, 2.3, 0.01);
        box(kit, car, rubber, side * 0.716, 0.48, 0.12, 0.012, 0.28, 0.02, 0.005);
        box(kit, car, body, side * 0.78, 0.86, 0.5, 0.1, 0.07, 0.14, 0.03);
        for (const end of [-1, 1]) {
          box(kit, car, rubber, side * 0.64, 0.38, end * 0.86, 0.18, 0.4, 0.7, 0.14);
          const tyre = new THREE.Mesh(wheel, rubber);
          tyre.rotation.z = Math.PI / 2;
          tyre.position.set(side * 0.66, 0.3, end * 0.86);
          car.add(tyre);
          sphere(kit, car, chrome, side * 0.775, 0.3, end * 0.86, 0.026, 0.16, 0.16);
        }
      }
      box(kit, car, chrome, 0, 0.34, 1.41, 1.2, 0.1, 0.08, 0.03);
      box(kit, car, chrome, 0, 0.34, -1.41, 1.2, 0.1, 0.08, 0.03);
      box(kit, car, rubber, 0, 0.5, 1.415, 0.62, 0.12, 0.03, 0.01);
      for (const side of [-1, 1]) {
        box(kit, car, headlamp, side * 0.47, 0.56, 1.41, 0.28, 0.12, 0.05, 0.03);
        box(kit, car, taillight, side * 0.47, 0.56, -1.41, 0.3, 0.1, 0.05, 0.03);
      }
      const slots = mergeParts(kit, car).map((mesh) => ({
        geometry: mesh.geometry,
        material: mesh.material as THREE.Material,
        casts: mesh.material === body || mesh.material === glass,
        painted: mesh.material === body,
        /** The taillight, which only an approaching car brakes with. */
        lit: mesh.material === taillight,
      }));
      slots.push(
        {
          geometry: carGlowGeometry(kit),
          material: carGlow,
          casts: false,
          painted: false,
          lit: false,
        },
        {
          geometry: carBeamGeometry(kit),
          material: carBeam,
          casts: false,
          painted: false,
          lit: false,
        }
      );
      return slots;
    })();
    const buildCar = (color: number, tail?: THREE.Material) => {
      const car = new THREE.Group();
      for (const slot of template) {
        const worn = slot.painted ? kit.paint(color) : slot.lit && tail ? tail : slot.material;
        const mesh = new THREE.Mesh(slot.geometry, worn);
        mesh.castShadow = slot.casts;
        mesh.receiveShadow = true;
        car.add(mesh);
      }
      return car;
    };
    /**
     * THE LANE TRAFFIC, INSTANCED. Thirty cars are eight draws: one instanced
     * mesh per part, all eight sharing one matrix buffer, so a frame moves the
     * traffic by writing thirty matrices once. A car that is off its street is
     * scaled to nothing. The paint is an instance colour over white lacquer.
     */
    const laneTint = new THREE.Color();
    const traffic: THREE.InstancedMesh[] = [];
    for (const slot of template) {
      const mesh = new THREE.InstancedMesh(
        slot.geometry,
        slot.painted ? kit.paint(0xffffff) : slot.material,
        LANE_CARS
      );
      mesh.castShadow = slot.casts;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      if (traffic.length) mesh.instanceMatrix = traffic[0].instanceMatrix;
      if (slot.painted)
        for (let i = 1; i < SIGN_SLOTS; i++) {
          mesh.setColorAt(laneCar(i, 0), laneTint.setHex(CAR_PAINTS[i % 4]));
          mesh.setColorAt(laneCar(i, 1), laneTint.setHex(CAR_PAINTS[4 + (i % 4)]));
        }
      scene.add(mesh);
      traffic.push(mesh);
    }
    const carAt = new THREE.Matrix4(),
      carTurn = new THREE.Quaternion(),
      carPos = new THREE.Vector3(),
      carScale = new THREE.Vector3(),
      up = new THREE.Vector3(0, 1, 0);
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    /**
     * THE SIGNS, ONE MESH AND ONE TEXTURE. Sixteen plates lie on their streets
     * as one merged geometry, each reading its own slot of a 4 x 4 atlas; a
     * sign is repainted into its slot and the one atlas is re-sent.
     */
    const SIGN_W = 256,
      SIGN_H = 128,
      SIGN_COLS = 4;
    const atlas = document.createElement('canvas');
    atlas.width = SIGN_W * SIGN_COLS;
    atlas.height = SIGN_H * Math.ceil(SIGN_SLOTS / SIGN_COLS);
    const signTexture = kit.texture(new THREE.CanvasTexture(atlas));
    signTexture.colorSpace = THREE.SRGBColorSpace;
    signTexture.anisotropy = Math.min(8, anisotropy);
    const signSlot = (street: number) => ({
      ox: (street % SIGN_COLS) * SIGN_W,
      oy: Math.floor(street / SIGN_COLS) * SIGN_H,
    });
    const signs = new THREE.Mesh(
      mergedFlat(
        kit,
        Array.from({ length: SIGN_SLOTS }, (_, i) => {
          const plate = new THREE.PlaneGeometry(1.8, 0.9);
          plate.rotateX(-Math.PI / 2);
          plate.translate(streetCenter(i), 0.03, 2.25);
          const { ox, oy } = signSlot(i);
          const uv = plate.getAttribute('uv') as THREE.BufferAttribute;
          for (let v = 0; v < uv.count; v++)
            uv.setXY(
              v,
              (ox + uv.getX(v) * SIGN_W) / atlas.width,
              1 - (oy + (1 - uv.getY(v)) * SIGN_H) / atlas.height
            );
          return plate;
        })
      ),
      kit.keep(
        new THREE.MeshStandardMaterial({
          map: signTexture,
          metalness: 0.3,
          roughness: 0.35,
          emissive: 0xffffff,
          emissiveMap: signTexture,
          emissiveIntensity: 0.55,
        })
      )
    );
    signs.receiveShadow = true;
    scene.add(signs);
    type RouteState = 'reachable' | 'crash' | null;
    /**
     * A street sign prints the multiplier the street pays; the start prints
     * START. A black glass plate in a chrome bevel, with the strip's edge for
     * the street's band and state. The plate, the bevel, the edge and the
     * words need only fillRect, strokeRect and fillText; the glass gradient
     * and the glows are added when the context has them.
     */
    const paintSign = (
      street: number,
      multiplier: string | null,
      band: number,
      state: StreetState,
      route: RouteState
    ) => {
      const ctx = atlas.getContext('2d');
      if (!ctx) return;
      const { ox, oy } = signSlot(street);
      const rich = typeof ctx.createLinearGradient === 'function';
      const blank = multiplier === null && street > 0;
      const wouldHit = !blank && route === 'crash';
      const reached = !blank && route === 'reachable';
      const lit = !blank && (state === 'current' || state === 'next');
      const bust = !blank && state === 'crash';
      const spent = blank || state === 'crossed';
      const edge =
        bust || wouldHit
          ? SIGN_INK.bust
          : reached
            ? SIGN_INK.gold
            : lit
              ? SIGN_INK.led
              : spent
                ? SIGN_INK.spentEdge
                : SIGN_INK.edge[band];
      const glowing = lit || bust || reached || wouldHit;
      ctx.shadowBlur = 0;
      ctx.fillStyle = SIGN_INK.plate;
      ctx.fillRect(ox, oy, SIGN_W, SIGN_H);
      if (rich) {
        // Black glass: a cold sheen at the top, obsidian through the middle.
        const glassFace = ctx.createLinearGradient(0, oy, 0, oy + SIGN_H);
        glassFace.addColorStop(0, '#182230');
        glassFace.addColorStop(0.45, '#070a0f');
        glassFace.addColorStop(1, '#0b1119');
        ctx.fillStyle = glassFace;
        ctx.fillRect(ox + 4, oy + 4, SIGN_W - 8, SIGN_H - 8);
      }
      // The chrome bevel, then the edge: an LED seam blooms, a resting edge is
      // one crisp line.
      ctx.lineWidth = 2;
      ctx.strokeStyle = SIGN_INK.bevel;
      ctx.strokeRect(ox + 3, oy + 3, SIGN_W - 6, SIGN_H - 6);
      ctx.shadowColor = edge;
      ctx.shadowBlur = glowing ? 18 : 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = edge;
      ctx.strokeRect(ox + 8, oy + 8, SIGN_W - 16, SIGN_H - 16);
      ctx.shadowBlur = 0;
      ctx.textAlign = 'center';
      if (street === 0) {
        ctx.font = '800 54px "Roboto Condensed", Rajdhani, Inter, sans-serif';
        ctx.fillStyle = spent ? SIGN_INK.spentInk : SIGN_INK.start;
        ctx.fillText('START', ox + SIGN_W / 2, oy + 84);
        return;
      }
      if (multiplier === null) return;
      ctx.font = '700 23px Inter, "Roboto Condensed", sans-serif';
      ctx.fillStyle = spent ? SIGN_INK.spentInk : SIGN_INK.label;
      ctx.fillText(`STREET ${street}`, ox + SIGN_W / 2, oy + 38);
      ctx.font = '800 62px "Roboto Condensed", Rajdhani, Inter, sans-serif';
      ctx.fillStyle = spent ? SIGN_INK.spentInk : SIGN_INK.figure;
      if (rich && !spent) {
        ctx.shadowColor = SIGN_INK.figure;
        ctx.shadowBlur = 10;
      }
      ctx.fillText(multiplier, ox + SIGN_W / 2, oy + 103);
      ctx.shadowBlur = 0;
    };
    const animal = donkey(kit);
    // The ghost is the donkey baked to one translucent blue mesh: light, not flesh.
    const ghost = new THREE.Mesh(
      bakeGroup(kit, animal.animal),
      kit.keep(
        new THREE.MeshPhysicalMaterial({
          color: 0x45adff,
          emissive: 0x1877f2,
          emissiveIntensity: 0.9,
          roughness: 0.4,
          metalness: 0,
          transparent: true,
          opacity: 0.38,
          depthWrite: false,
        })
      )
    );
    ghost.scale.setScalar(DONKEY_SCALE);
    ghost.visible = false;
    scene.add(ghost);
    animal.animal.scale.setScalar(DONKEY_SCALE);
    scene.add(animal.animal);
    // The contact shadow: a soft dark disc that stays under the donkey's feet
    // and thins as it jumps, where the cast shadow alone reads as a paper cutout.
    const contact = new THREE.Mesh(
      glowPlane,
      kit.keep(
        new THREE.MeshBasicMaterial({
          color: 0x000000,
          map: disc,
          transparent: true,
          opacity: 0.6,
          depthWrite: false,
        })
      )
    );
    contact.scale.set(2.1 * DONKEY_SCALE, 1, 1.3 * DONKEY_SCALE);
    scene.add(contact);
    /**
     * THE CAR THAT COMES TO EVERY STREET. Two copies of the same car in the
     * same paint, used turn and turn about: the one that braked holds its lane
     * until the donkey has left it and then drives on, while the other is
     * already coming to the next street. They are the same car either way, so
     * its first frames never say which street this is going to be.
     */
    const brakeLight = () =>
      kit.keep(
        new THREE.MeshStandardMaterial({
          color: 0xf74932,
          emissive: 0xff2a3c,
          emissiveIntensity: 0,
          metalness: 0.1,
          roughness: 0.2,
        })
      );
    const approachTail = [0, 1].map(brakeLight);
    const approachCars = approachTail.map((tail) => {
      const car = buildCar(IMPACT_PAINT, tail);
      car.visible = false;
      car.rotation.y = Math.PI;
      scene.add(car);
      return car;
    });
    /**
     * THE CAR THAT WOULD HAVE HIT. Once the ghost of a booked win has walked
     * the streets the donkey would still have crossed, the same obsidian car
     * stands on the street after them, brake lights on, where the road ended.
     */
    const routeTail = brakeLight();
    routeTail.emissiveIntensity = 2.4;
    const routeCar = buildCar(IMPACT_PAINT, routeTail);
    routeCar.visible = false;
    routeCar.rotation.y = Math.PI;
    scene.add(routeCar);
    // The impact: an additive burst, and the lamp over the street spikes white
    // with it for the same few frames.
    const flash = new THREE.Sprite(
      kit.keep(
        new THREE.SpriteMaterial({
          map: disc,
          color: 0xe8f6ff,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      )
    );
    flash.visible = false;
    scene.add(flash);
    // Nothing behind a modal, nothing scrolled past and nothing standing still
    // is worth 60 draws a second; the clock behind it never stops.
    let animating = true,
      needsDraw = true,
      onScreen = true;
    const watcher =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            needsDraw = true;
          })
        : null;
    watcher?.observe(node);
    /* THE PROGRAMS ARE COMPILED BEFORE THE FIRST FRAME, NOT INSIDE IT
       (2026-09-22). Every material here is a MeshPhysicalMaterial lit by a
       shadow-casting key light, so the first renderer.render() compiles and
       links the whole program set on the main thread - and that first frame
       lands while the page is still animating the Double Down offer in.
       compileAsync gives the work to the driver instead, and the scene simply
       submits no frame until it answers. The clock below keeps running while
       it waits, so the walk is not delayed, only unshown.
       A renderer without compileAsync - an older three, a test double - draws
       immediately, exactly as it did before. The same hold runs again when
       the governor turns shadows off, since that re-links every material on
       exactly the device that was just found too slow. */
    let compiled = typeof renderer.compileAsync !== 'function';
    let compileTimer = 0;
    let compileStarted = false;
    const compile = () => {
      compileStarted = true;
      if (typeof renderer.compileAsync !== 'function') return;
      compiled = false;
      clearTimeout(compileTimer);
      let answered = false;
      const ready = () => {
        if (answered) return;
        answered = true;
        compiled = true;
        needsDraw = true;
        clearTimeout(compileTimer);
      };
      // Either answer releases the scene: a driver that refuses to compile
      // ahead of time still renders, it just pays for it in the first frame.
      void renderer.compileAsync(scene, camera).then(ready, ready);
      compileTimer = window.setTimeout(ready, 1500);
    };
    const governor = createQualityGovernor({
      intervalMs: 16,
      start: software ? FLOOR_TIER : undefined,
      apply: (tier) => {
        const relinked = applyQualityTier(
          renderer,
          scene,
          tier,
          node.clientWidth,
          node.clientHeight
        );
        if (relinked && compileStarted) compile();
        needsDraw = true;
      },
    });
    const resize = () => {
      const w = node.clientWidth,
        h = node.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      needsDraw = true;
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    const gpu = gpuFrameRenderer(renderer, scene, camera);
    const frames = {
      /** intervalMs: the pace the loop is drawing at, so the governor judges it against that. */
      render(intervalMs: number) {
        const submitted = gpu.render();
        governor.frame(performance.now(), submitted, intervalMs);
        return submitted;
      },
      dispose: gpu.dispose,
    };
    compile();
    let raf = 0,
      last = 0,
      signature = '',
      roadSignature = '',
      signsPainted = '',
      hazards: number[] = [],
      sceneElapsed = 0,
      actual = 0,
      from = 0,
      to = 0,
      stalled = 0,
      lean = 0,
      leanFrom = 0,
      leanClock = 0,
      leaned = false,
      answered = false,
      carried = 0,
      turn = 0,
      departX = 0,
      notified = false,
      /** Hoof steps sounded on this walk, four a street. */
      hoofs = 4,
      /** The approach car's engine is sounding, and has finished for this street. */
      carOn = false,
      carDone = false;
    let approaching: 'safe' | 'hit' | null = null,
      departing: THREE.Group | null = null;
    let lastVisibleFrame: number | null = null;
    const silenceCar = (fadeSec: number) => {
      if (!carOn) return;
      carOn = false;
      soundService.stopCrossingCar(fadeSec);
    };
    const visibilityChanged = () => {
      lastVisibleFrame = null;
      if (document.hidden) silenceCar(0.05);
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    /** The road is repainted only when its ladder changes: tints and traffic density. */
    const tint = new THREE.Color();
    const paintRoad = (road: readonly number[]) => {
      hazards = Array.from({ length: SIGN_SLOTS }, (_, i) =>
        i === 0 || i > road.length ? 0 : streetHazard(i - 1, road.length)
      );
      // Column 0 and the last column are the pavements; column i + 1 is street i.
      const columns = ROAD_EDGES.length - 1;
      for (let c = 0; c < columns; c++) {
        const i = c - 1;
        tint.setHex(
          c === 0 || c === columns - 1
            ? PAVEMENT_TINT
            : i === 0 || i > road.length
              ? STREET_TINTS[0]
              : STREET_TINTS[hazardBand(hazards[i])]
        );
        for (let k = 0; k < 4; k++) roadColor.setXYZ(c * 4 + k, tint.r, tint.g, tint.b);
      }
      roadColor.needsUpdate = true;
    };
    /**
     * What a booked win's route says about a street: one the ghost has reached
     * lights gold, and the one after the last it would have crossed is the
     * crash. Nothing until the win is shown as booked and the route is known.
     */
    const routeState = (
      street: number,
      step: number,
      phase: Props['phase'],
      roadEnd: number | null,
      ghostAt: number
    ): RouteState => {
      if (phase !== 'cashed' || roadEnd === null || ghostAt < 0) return null;
      if (street > step && street <= ghostAt) return 'reachable';
      if (street === roadEnd + 1 && ghostAt >= roadEnd) return 'crash';
      return null;
    };
    /** A sign is repainted only when its figure, band, state or route changes. */
    const signPainted: string[] = [];
    const paintSigns = (
      road: readonly number[],
      step: number,
      phase: Props['phase'],
      roadEnd: number | null,
      ghostAt: number
    ) => {
      let repainted = false;
      for (let i = 0; i < SIGN_SLOTS; i++) {
        const cents = road[i - 1];
        const multiplier = i > 0 && cents !== undefined ? streetMultiplier(cents) : null;
        const band = hazardBand(hazards[i] ?? 0);
        const state = streetState(i, step, phase);
        const route = routeState(i, step, phase, roadEnd, ghostAt);
        const key = `${multiplier}|${band}|${state}|${route ?? ''}`;
        if (signPainted[i] === key) continue;
        signPainted[i] = key;
        paintSign(i, multiplier, band, state, route);
        repainted = true;
      }
      if (repainted) signTexture.needsUpdate = true;
    };
    /** The street the ghost of a booked win has reached, or -1 with no ghost on the road. */
    let ghostAt = -1;
    /** The level each flickering lamp was last set to, so an unchanged lamp costs nothing. */
    const lampLevel = IDLE.flickering.map(() => 1);
    const lampTint = new THREE.Color();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const reduced = reducedRef.current;
      const pace = reduced ? 100 : animating ? 16 : 33;
      if (document.hidden || now - last < pace) return;
      last = now;
      const visibleDelta = lastVisibleFrame === null ? 0 : now - lastVisibleFrame;
      lastVisibleFrame = now;
      const p = latest.current,
        road = p.ladder ?? ROAD_LADDERS_V4[CHOICE_MODE.crossing],
        step = p.picked.length,
        newSignature = `${p.roundId}:${step}:${p.phase}`;
      const newRoad = road.join(',');
      const roadChanged = newRoad !== roadSignature;
      if (roadChanged) {
        roadSignature = newRoad;
        paintRoad(road);
        needsDraw = true;
      }
      const roundChanged = newSignature !== signature;
      if (roundChanged) {
        // A beat still owed is played out before the round moves on, so fast
        // play never swallows the street the player just crossed.
        if (pending.current) commit.current(pending.current.next, pending.current.moments);
        const was = shownRef.current;
        const id = p.roundId ?? '';
        // Only a round that advanced under its own id has a beat to show. A
        // first frame, a new round or an idle scene is placed where it stands,
        // which also stops a resumed open round hopping across every lane.
        const advanced = signature !== '' && id !== '' && id === was.roundId && p.phase !== 'idle';
        const next: Shown = { roundId: id, step, phase: p.phase };
        // Already shown (reduced motion and a failed scene commit a change the
        // moment it lands): nothing is owed, so no beat is told twice.
        const seenAlready = was.step === next.step && was.phase === next.phase;
        const owed = advanced && !seenAlready ? momentsFor(was, next) : null;
        // A new street, or a new round: whatever the last car was doing, it is done.
        silenceCar(0.1);
        carDone = false;
        horned.current = false;
        hoofs = 4;
        signature = newSignature;
        to = streetCenter(step);
        if (owed && owed.moments.length) {
          from = actual;
          pending.current = { moments: owed.moments, next, at: owed.at };
          // The street the player just committed to gets its own car. The one
          // that braked on the street behind holds its lane, then drives on.
          if (approaching) {
            departing = approachCars[turn];
            departX = streetCenter(was.step);
            turn = 1 - turn;
          }
          approaching = p.phase === 'lost' ? 'hit' : 'safe';
          if (Math.abs(to - from) > 0.01) hoofs = 0;
          // The lean the walk now absorbs: the donkey carries on from the kerb
          // it stepped to, it does not snap back to the middle of its street.
          carried = lean;
          lean = 0;
          leanFrom = 0;
          leaned = false;
          answered = true;
        } else {
          from = to;
          commit.current(next, []);
          approaching = null;
          carried = 0;
        }
        sceneElapsed = 0;
        stalled = 0;
        notified = false;
        needsDraw = true;
      } else sceneElapsed += visibleDelta;
      const seen = shownRef.current;
      const elapsed = sceneElapsed,
        speed = getAnimationSpeed(),
        walk = reduced ? 1 : Math.min(1, elapsed / (WALK_MS * speed));
      actual = THREE.MathUtils.lerp(from, to, walk * walk * (3 - 2 * walk));
      // The step to the kerb: taken the moment the player commits, held until
      // the answer lands, and eased back over 200 ms if the move is refused or
      // never answered at all.
      if (!p.moving) answered = false;
      const stepping = Boolean(p.moving) && !answered && p.phase === 'open';
      if (stepping !== leaned) {
        leaned = stepping;
        leanFrom = lean;
        leanClock = 0;
      } else leanClock += visibleDelta;
      lean = stepping
        ? anticipationFrame(leanClock, speed, reduced)
        : Math.max(0, leanFrom * (1 - leanClock / (200 * speed)));
      const hop = walk < 1 ? Math.sin(walk * Math.PI) * 0.28 : 0;
      animal.animal.position.set(
        actual - 0.12 + lean + (walk < 1 ? carried * (1 - walk) : 0),
        0.05 + hop,
        0
      );
      animal.animal.rotation.set(0, 0, 0);
      animal.animal.scale.setScalar(DONKEY_SCALE);
      animal.legs.forEach((leg, i) => {
        leg.rotation.z = walk < 1 ? Math.sin(walk * Math.PI * 4 + (i % 2) * Math.PI) * 0.5 : 0;
      });
      // A hoof on the road each time a pair of legs passes the vertical: the
      // gait above is two strides a street, so four steps, on the walk's clock.
      // (Reduced motion commits a street at once, through commit below, which
      // sounds one step for it.)
      if (hoofs < 4 && !reduced && walk >= (hoofs + 0.5) / 4) {
        soundService.playCrossingHoof(hoofs);
        hoofs = walk >= 1 ? 4 : hoofs + 1;
      }
      /**
       * THE IDLE ATTRACT. Before the first street the traffic already flows;
       * the donkey flicks an ear every few seconds and shifts its weight
       * between times, and two of the lamps flicker, very slightly, now and
       * then. Every beat is measured against the animation speed, and none of
       * it happens under reduced motion (the scene then draws only on change).
       * Nothing is allocated: two rotations, one position, and an instance
       * colour rewritten only when a lamp's level actually changes.
       */
      const attract = seen.phase === 'idle' && p.phase === 'idle' && !reduced;
      const beat = attract ? now / speed : 0;
      const flick = (beat % IDLE.earEvery) / IDLE.earMs;
      const flicking = Math.floor(beat / IDLE.earEvery) % 2;
      animal.ears.forEach((ear, i) => {
        ear.rotation.x =
          attract && i === flicking && flick < 1
            ? Math.sin(flick * Math.PI) * 0.6 * (i ? 1 : -1)
            : 0;
      });
      const shift = ((beat + 1900) % IDLE.shiftEvery) / IDLE.shiftMs;
      if (attract && shift < 1) {
        const settle = Math.sin(shift * Math.PI);
        animal.animal.rotation.x = 0.06 * settle;
        animal.animal.position.x += 0.04 * settle;
        animal.animal.position.y -= 0.012 * settle;
      }
      for (let k = 0; k < IDLE.flickering.length; k++) {
        const lampIndex = IDLE.flickering[k];
        const episode = attract && hash2(lampIndex * 13 + 1, Math.floor(beat / 3000)) < 0.45;
        const level = episode ? 0.74 + 0.26 * hash2(lampIndex, Math.floor(beat / 55)) : 1;
        if (level === lampLevel[k]) continue;
        lampLevel[k] = level;
        lampTint.setScalar(level);
        posts.heads.setColorAt(lampIndex, lampTint);
        posts.glows.setColorAt(lampIndex, lampTint);
        if (posts.heads.instanceColor) posts.heads.instanceColor.needsUpdate = true;
        if (posts.glows.instanceColor) posts.glows.instanceColor.needsUpdate = true;
      }
      // The ghost walks the rest of the route once the win is shown as booked,
      // and the streets light gold behind it as it reaches them.
      const roadEnd = p.roadEnd ?? null;
      ghost.visible = seen.phase === 'cashed' && roadEnd !== null;
      let ghostProgress = 1;
      if (ghost.visible) {
        ghostProgress = reduced
          ? 1
          : Math.max(0, Math.min(1, (elapsed - 800 * speed) / (2400 * speed)));
        ghost.position.set(
          THREE.MathUtils.lerp(to, streetCenter(roadEnd ?? step), ghostProgress),
          0.05,
          0
        );
      }
      const reached = ghost.visible
        ? Math.max(
            step,
            Math.min(roadEnd ?? step, Math.floor(ghost.position.x / STREET_WIDTH + 0.5))
          )
        : -1;
      if (reached !== ghostAt) {
        ghostAt = reached;
        setGhostAt(reached);
      }
      // THE ROAD AGREES WITH THE STRIP. The sign painted on a street and the
      // street's chip in the strip read one streetState between them, so both
      // wait for the scene to reach the street: a sign that went bust red the
      // moment the server answered would give the collision away while the
      // donkey was still standing in the road.
      const seenSignature = `${seen.step}:${seen.phase}:${roadEnd ?? ''}:${ghostAt}`;
      if (roadChanged || seenSignature !== signsPainted) {
        signsPainted = seenSignature;
        paintSigns(road, seen.step, seen.phase, roadEnd, ghostAt);
        needsDraw = true;
      }
      // The car that would have hit stands on the street after the route,
      // once the ghost has walked it; that street's own traffic makes way.
      const crashStreet =
        ghost.visible && roadEnd !== null && ghostAt >= roadEnd && roadEnd < road.length
          ? roadEnd + 1
          : -1;
      routeCar.visible = crashStreet > 0;
      if (routeCar.visible) routeCar.position.set(streetCenter(crashStreet), 0, 0.1);
      // Thirty lane cars, one matrix buffer. A car off its street is scaled away.
      for (let i = 1; i < SIGN_SLOTS; i++) {
        const hazard = hazards[i] ?? 0;
        const open =
          crossingTrafficVisible(
            i,
            step,
            p.phase === 'lost',
            // The route a booked win sealed is cleared when the scene says the
            // win is booked, not when the answer lands.
            seen.phase === 'cashed' ? roadEnd : null
          ) &&
          !(walk < 1 && i === step - 1) &&
          i !== crashStreet;
        // Traffic runs faster and thicker the further down the road it is. The
        // lap is the visible road, TRAFFIC_Z.far to near; a car within five
        // units of the far end is scaled toward nothing, so it recedes into the
        // haze rather than popping in or out of it. Its pace follows Animation
        // Speed like every other motion in the scene.
        const period = 330 - 130 * hazard;
        carTurn.setFromAxisAngle(up, i % 2 ? 0 : Math.PI);
        for (let n = 0; n < 2; n++) {
          const shown = open && (n === 0 || hazardBand(hazard) >= 2);
          if (shown) {
            const z = reduced
              ? -3 - n * 12
              : (((((now / (period * speed)) * (i % 2 ? 1 : -1) +
                  i * 3.13 +
                  n * (TRAFFIC_LAP / 2)) %
                  TRAFFIC_LAP) +
                  TRAFFIC_LAP) %
                  TRAFFIC_LAP) +
                TRAFFIC_Z.far;
            const near = Math.min(1, (z - TRAFFIC_Z.far) / 5);
            carPos.set(streetCenter(i), 0, z);
            carAt.compose(carPos, carTurn, carScale.set(near, near, near));
          }
          traffic[0].setMatrixAt(laneCar(i, n), shown ? carAt : hidden);
        }
      }
      traffic[0].instanceMatrix.needsUpdate = true;
      flash.visible = false;
      lamp.intensity = LAMP;
      lamp.color.setHex(0xffe7c2);
      let finished = walk === 1,
        struck = false,
        arrived = true;
      approachCars.forEach((car) => {
        car.visible = false;
      });
      // The braked car holds its lane until the donkey is across, then leaves.
      if (departing) {
        const gone = Math.min(1, Math.max(0, elapsed - WALK_MS * speed) / (1050 * speed));
        departing.position.set(departX, 0, APPROACH_REST_Z - 18 * gone);
        departing.visible = gone < 1;
        if (gone >= 1) departing = null;
      }
      const outcome = p.phase === 'lost' ? 'hit' : approaching;
      if (outcome) {
        // Stretched with the walk, so the car never arrives before the donkey.
        const impact = approachFrame(elapsed, speed, outcome, reduced);
        const car = approachCars[turn];
        car.position.set(to, 0, impact.carZ);
        car.visible = true;
        // Only the car that is stopping shows a brake light.
        approachTail[turn].emissiveIntensity = impact.brake * 2.4;
        if (impact.hit) {
          // Struck and carried: the donkey turns over along the line the car
          // was driving and slides with it. No squash - this is not a cartoon.
          animal.animal.rotation.x = -Math.PI * 1.15 * impact.fall;
          animal.animal.rotation.z = (-Math.PI / 3) * impact.fall;
          animal.animal.position.y = 0.1 + Math.sin(impact.fall * Math.PI) * 0.34;
          animal.animal.position.z = -1.7 * impact.fall;
          // One short white burst, not a gold flare: gold is for value alone.
          // The sprite blooms out as it fades and the lamp overhead spikes with it.
          const glint = Math.min(1, impact.fall / GLINT);
          flash.position.set(to, 0.8, 0.2);
          flash.visible = impact.fall < GLINT;
          flash.scale.setScalar(2.4 + 4.2 * glint);
          (flash.material as THREE.SpriteMaterial).opacity = 0.95 * (1 - glint * glint);
          if (flash.visible) {
            lamp.intensity = LAMP * (1 + 3 * (1 - glint));
            lamp.color.setHex(0xf2f8ff);
          }
        }
        struck = impact.hit;
        /* The car is heard as it is seen: its engine grows as it closes on
           the street; past the point where a safe street and a hit part, the
           safe car's tyres squeal as it brakes and the other sounds its horn;
           the engine ends when it has stopped or struck (the strike itself is
           the 'hit' beat, told on the frame that shows it). Under reduced
           motion there is no approach to hear; commit below still sounds the
           step, the squeal of a safe street and the horn with the hit. */
        if (!reduced && !carDone && impact.t > 0) {
          if (outcome === 'safe' && impact.brake > 0) {
            carDone = true;
            silenceCar(0.3 * speed);
            soundService.playCrossingBrake(speed);
          } else if (outcome === 'hit' && impact.hit) {
            carDone = true;
            silenceCar(0.04);
          } else {
            carOn = true;
            soundService.driveCrossingCar(Math.max(0, Math.min(1, (9 - impact.carZ) / 9)));
            if (outcome === 'hit' && !horned.current && impact.t >= APPROACH_COMMITTED) {
              horned.current = true;
              soundService.playCrossingHorn();
            }
          }
        }
        // A street ends when its car has settled, braked or driven through, so
        // a safe crossing and a hit resolve on the very same beat.
        arrived = impact.resting;
        finished = outcome === 'hit' ? impact.finished : finished && impact.resting;
      }
      // The contact shadow stays under the feet, and thins as the donkey leaves the ground.
      contact.position.set(animal.animal.position.x, 0.016, animal.animal.position.z);
      const lift = Math.max(0, animal.animal.position.y - 0.05);
      (contact.material as THREE.MeshBasicMaterial).opacity = 0.6 / (1 + lift * 3);
      contact.scale.set(2.1 * DONKEY_SCALE * (1 + lift), 1, 1.3 * DONKEY_SCALE * (1 + lift));
      let focus = actual;
      if (ghost.visible) {
        focus = THREE.MathUtils.lerp(actual, ghost.position.x, 0.65);
        finished = finished && ghostProgress === 1;
      }
      // The lamp stands over what the camera is looking at, a little ahead of it.
      lamp.position.x = focus + 1.4;
      lamp.target.position.x = focus + 1.4;
      // Straight down the road: the camera stands over the x it looks at.
      const view = aimCrossingCamera(camera, focus);
      fog.near = view.fogNear;
      fog.far = view.fogFar;
      // The shadow box follows the view, so every street in frame keeps its shadows.
      key.position.x = view.x - 4;
      key.target.position.x = view.x;
      const owed = pending.current;
      const ready =
        owed !== null &&
        (owed.at === 'now' || (owed.at === 'walk' ? walk === 1 && arrived : struck));
      // Paused (an offer over an idle road, a receipt on top of it) or scrolled
      // off screen: the clock, the beats and completion all carry on, and only
      // the draw call is skipped. No reveal ever waits on scroll position.
      // Under reduced motion there is nothing to redraw between changes.
      // Nothing is drawn before compileAsync answers, so no beat and no
      // completion lands on a frame the driver has not linked yet.
      const drawing = compiled && !p.paused && onScreen && (!reduced || needsDraw);
      const submitted = compiled && (drawing ? frames.render(pace) : true);
      if (drawing) needsDraw = false;
      animating = !finished || lean > 0 || stepping;
      // A beat belongs to the frame that shows it: the same terminal-frame
      // rule completion follows, so neither ever runs ahead of the picture.
      if (submitted && ready && owed) commit.current(owed.next, owed.moments);
      if (submitted && finished && !notified) {
        notified = true;
        p.onSettled?.();
      }
      // A beat nobody can see is not worth holding a round on. After eight
      // seconds of visible time with no frame submitted, the reveal goes to
      // the failed path, which settles it and prints the fallback line. This
      // is the ONLY watchdog here: completion itself still waits for its
      // terminal frame however long that takes.
      if (pending.current) {
        stalled = submitted ? 0 : stalled + visibleDelta;
        if (stalled >= 8000) setFailed(true);
      } else stalled = 0;
    };
    raf = requestAnimationFrame(draw);
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
      latest.current.onSettled?.();
    };
    // A context the browser gives back is drawn on again: every sign is
    // repainted onto the fresh context and the reveal waits for its animation
    // once more, instead of the scene staying "unavailable" for good.
    const restored = () => {
      signPainted.length = 0;
      // Repaint the road and every sign on the next frame; the round itself
      // carries on where it was (no replayed walk or strike).
      roadSignature = '';
      signTexture.needsUpdate = true;
      needsDraw = true;
      setFailed(false);
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(compileTimer);
      silenceCar(0.05);
      document.removeEventListener('visibilitychange', visibilityChanged);
      frames.dispose();
      observer.disconnect();
      watcher?.disconnect();
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      // The kit owns every shape, finish and texture the scene was built from;
      // the traversal catches anything a mesh was given outside it.
      scene.traverse((obj) => {
        if (obj instanceof THREE.InstancedMesh) obj.dispose();
        if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite)
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) =>
            kit.materials.add(m)
          );
      });
      kit.dispose();
      environment.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      // The page mounts this scene again for every round. Without this the tab
      // keeps one live WebGL context per round it has played.
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);
  /**
   * THE STRIP SCROLLS THE STRIP, NEVER THE PAGE.
   *
   * Keeping the current street in view used to be scrollIntoView on the chip,
   * and scrollIntoView walks every scrollable ancestor up to the document: any
   * street crossed while the strip itself was off screen - reading the rules or
   * the round proof mid-round, a landscape phone - yanked the window to the
   * scene and took the plates out from under the player's thumb. The strip is
   * its own scroll container, so it is the only thing that has to move: the
   * chip is centred in the LIST's own box, and a new round starts the list back
   * at street one.
   */
  const streets = useRef<HTMLOListElement>(null);
  const currentStreet = useRef<HTMLLIElement>(null);
  // Everything below prints the street the scene is showing; the prizes, the
  // ladder and the settled chips are the round's own numbers, printed as given.
  const shownStep = shown.step,
    shownPhase = shown.phase;
  const shownRound = shown.roundId;
  useEffect(() => {
    const list = streets.current;
    if (list) list.scrollLeft = 0;
  }, [shownRound]);
  useEffect(() => {
    const list = streets.current,
      item = currentStreet.current;
    if (!list || !item || typeof list.scrollTo !== 'function') return;
    list.scrollTo({
      left: item.offsetLeft - (list.clientWidth - item.offsetWidth) / 2,
      behavior: reducedRef.current ? 'auto' : 'smooth',
    });
  }, [shownStep, shownPhase, shownRound]);
  const reached = shownStep > 0 ? (props.prizes?.[shownStep - 1] ?? null) : null;
  const ahead = props.prizes?.[shownStep] ?? null;
  const lastStreet = ladder.length;
  /** A street beyond the ladder (a saved round on another road) reads as its last street. */
  const mult = (index: number) =>
    streetMultiplier(ladder[Math.min(Math.max(0, index), lastStreet - 1)]);
  const booked = props.payoutChips ?? reached;
  const floor = props.floorChips ?? null;
  /** The amount a hit still pays, said beside the amount being risked. */
  const guarantee =
    floor === null
      ? null
      : `${props.superFloor ? 'Super Guarantee' : 'A Hit Pays'} ${gameChips(floor)}`;
  const reach = `${lastStreet} Streets Up To ${mult(lastStreet - 1)}`;
  const readout = lost
    ? {
        label: `Hit At Street ${shownStep}`,
        value:
          props.payoutChips === undefined
            ? 'Round Over'
            : `${gameChips(props.payoutChips)} Chips Paid`,
        note:
          props.payoutChips === undefined ? 'The Donkey Did Not Make It Across' : 'Your Guarantee',
      }
    : shownPhase === 'cashed'
      ? {
          label: `Booked At Street ${shownStep}`,
          value: booked === null ? 'Win Booked' : `${gameChips(booked)} Chips`,
          note:
            props.roadEnd === null
              ? `${mult(shownStep - 1)} Reached`
              : props.roadEnd >= lastStreet
                ? 'It Would Have Crossed Every Street'
                : props.roadEnd <= shownStep
                  ? `Street ${props.roadEnd + 1} Was The Crash`
                  : `It Would Have Made It To Street ${props.roadEnd}`,
        }
      : shownStep > 0
        ? {
            label: 'Cash Out Value',
            value: reached === null ? mult(shownStep - 1) : `${gameChips(reached)} Chips`,
            note:
              shownStep < lastStreet
                ? [
                    ahead === null
                      ? `Next Street At ${mult(shownStep)}`
                      : `Next Street ${gameChips(ahead)} At ${mult(shownStep)}`,
                    guarantee,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'The Final Street. Book The Win.',
          }
        : {
            label: 'First Street Pays',
            value: ahead === null ? mult(0) : `${gameChips(ahead)} Chips At ${mult(0)}`,
            note:
              floor === null
                ? reach
                : `${props.superFloor ? 'A Super Hit Still Pays' : 'A Hit Still Pays'} ${gameChips(floor)} Chips · ${reach}`,
          };
  /**
   * HOW FAR THE DONKEY COULD HAVE GONE (Dan: "if a user books a win, it should
   * tell them how far they could have gone"). The sealed road is known the
   * moment the win is booked, and the ghost walks it below; this plate says it
   * in one line, in gold, over the scene. The readout keeps its own shorter
   * note, and the strip and the signs light the same streets.
   */
  const roadEnd = props.roadEnd;
  const route =
    shownPhase === 'cashed' && roadEnd !== null
      ? {
          title:
            roadEnd === 0
              ? 'The Donkey Would Have Stopped Before Street 1'
              : roadEnd >= lastStreet
                ? `You Could Have Gone All The Way To Street ${lastStreet} At ${mult(lastStreet - 1)}`
                : roadEnd <= shownStep
                  ? 'The Next Street Was The Crash'
                  : `You Could Have Gone To Street ${roadEnd} At ${mult(roadEnd - 1)}`,
          note: `You Booked Street ${shownStep} At ${mult(shownStep - 1)}`,
          outcome: roadEnd >= lastStreet ? 'all' : roadEnd <= shownStep ? 'crash' : 'further',
        }
      : null;
  // The failed path and reduced motion have no ghost walk to wait for: the
  // whole route lights at once.
  const routeReached = route === null ? -1 : failed || reducedMotion ? roadEnd! : ghostAt;
  const routeOf = (street: number) =>
    route === null || routeReached < 0
      ? undefined
      : street > shownStep && street <= routeReached
        ? 'reachable'
        : street === roadEnd! + 1 && routeReached >= roadEnd!
          ? 'crash'
          : undefined;
  return (
    <div className={styles.scene} ref={host} data-motion="keep" data-phase={shownPhase}>
      <div className={styles.caption}>
        {lost
          ? // ONE NAME FOR THIS OUTCOME, in the caption's own two-part shape:
            // the same words the readout, the receipt and the history row use.
            `Hit At Street ${shownStep}${props.payoutChips ? ' · Guarantee Paid' : ''}`
          : shownPhase === 'cashed'
            ? 'Win Booked · Showing The Remaining Route'
            : shownPhase === 'idle'
              ? props.sealed
                ? `Round Sealed · ${props.sealed}`
                : 'Start · Highway Ahead'
              : // Never "Next Street Clear": the next street is sealed, and the
                // traffic on screen does not decide it.
                shownStep === 0
                ? 'Start · Your Move'
                : `Safe On Street ${shownStep} · Your Move`}
      </div>
      {/* Not a live region. The page has the one polite region for both games,
          and it speaks each street once, when the scene reaches it. */}
      <div className={styles.readout} data-tone={lost ? 'bust' : undefined}>
        <span className={styles.readoutLabel}>{readout.label}</span>
        <strong className={styles.readoutValue}>{readout.value}</strong>
        <span className={styles.readoutNote}>{readout.note}</span>
      </div>
      {/* The stamp decorates a fact the page states in words; reading it again
          would announce the same hit twice. */}
      {lost && (
        <div className={styles.bust} aria-hidden="true">
          <span>Bust</span>
        </div>
      )}
      {route && (
        <div className={styles.route} data-outcome={route.outcome}>
          <span className={styles.routeLabel}>How Far You Could Have Gone</span>
          <strong className={styles.routeValue}>{route.title}</strong>
          <span className={styles.routeNote}>{route.note}</span>
        </div>
      )}
      <ol className={styles.streets} ref={streets} aria-label="Streets And Their Multipliers">
        {ladder.map((cents, index) => {
          const street = index + 1;
          const state = streetState(street, shownStep, shownPhase);
          const prize = props.prizes?.[index];
          const onRoute = routeOf(street);
          return (
            <li
              key={street}
              ref={street === shownStep ? currentStreet : undefined}
              className={styles.street}
              data-state={state}
              data-route={onRoute}
              data-hazard={hazardBand(streetHazard(index, ladder.length))}
              aria-current={street === shownStep ? 'step' : undefined}
              aria-label={`Street ${street} Pays ${streetMultiplier(cents)}${prize === undefined ? '' : `, ${gameChips(prize)} Chips`}${STREET_SPOKEN[state]}${onRoute === undefined ? '' : ROUTE_SPOKEN[onRoute]}`}
            >
              <span className={styles.streetNumber}>{street}</span>
              <strong className={styles.streetMultiplier}>{streetMultiplier(cents)}</strong>
              {prize !== undefined && (
                <small className={styles.streetPrize}>{gameChips(prize)}</small>
              )}
            </li>
          );
        })}
      </ol>
      {failed && (
        <p className={styles.fallback}>
          The Street Animation Is Unavailable. Your Confirmed Result And Controls Remain Available.
        </p>
      )}
    </div>
  );
}
