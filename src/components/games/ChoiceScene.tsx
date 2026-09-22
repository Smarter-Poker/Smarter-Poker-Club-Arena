/** Lit geometry is presentation only. Every reveal comes from a confirmed RPC. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { gpuFrameRenderer } from './gpuFrameRenderer';
import MinesGrid from './MinesGrid';
import {
  STREET_WIDTH,
  DONKEY_SCALE,
  CROSSING_CAMERA,
  aimCrossingCamera,
  streetCenter,
  streetState,
  crossingTrafficVisible,
  collisionAt,
  WALK_MS,
  type StreetState,
} from '../../utils/crossingScene';
import { CHOICE_MODE, ROAD_LADDERS, type ChoiceGame } from '../../utils/diamondChoiceMath';
import { gameChips } from '../../utils/bonusGameBudget';
import { prefersReducedMotion, getAnimationSpeed } from '../../utils/animationSpeed';
import { reportError } from '../../utils/errorReporter';
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
   * Nothing on screen is looking at the scene: an offer over an idle road, or
   * a receipt on top of it. The clock, the beats and completion carry on; only
   * the draw call is skipped.
   */
  paused?: boolean;
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
  const boxes = new Map<string, THREE.BufferGeometry>();
  const paints = new Map<number, THREE.MeshPhysicalMaterial>();
  const own = <T extends THREE.BufferGeometry>(geometry: T) => {
    geometries.add(geometry);
    return geometry;
  };
  const kit = {
    geometries,
    materials,
    /** The unit sphere every sculpted part is scaled from. */
    ball: own(new THREE.SphereGeometry(1, 24, 16)),
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
    /** The paint a car wears: one material per colour on the whole road. */
    paint(color: number) {
      const made = paints.get(color) ?? kit.material(color, 0.65, 0.18);
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
    },
  };
  return kit;
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
  const coat = kit.material(0x786c5d, 0, 0.94),
    pale = kit.material(0xd7cbbb, 0, 0.9);
  const dark = kit.material(0x20252b, 0.05, 0.5),
    eye = kit.material(0x080b0d, 0.1, 0.05);
  coat.clearcoat = 0.03;
  pale.clearcoat = 0.02;
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
  for (const z of [-0.215, 0.215]) {
    sphere(kit, animal, eye, 0.83, 1.74, z, 0.064, 0.076, 0.034);
    sphere(kit, animal, pale, 0.84, 1.77, z * 1.1, 0.018, 0.019, 0.014);
    sphere(kit, animal, dark, 1.16, 1.55, z * 0.75, 0.035, 0.023, 0.03);
    const ear = sphere(kit, animal, coat, 0.53, 2.05, z * 0.65, 0.095, 0.4, 0.105);
    ear.rotation.z = 0.13;
    sphere(kit, animal, pale, 0.56, 2.09, z * 0.65, 0.045, 0.26, 0.108).rotation.z = 0.13;
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
  return { animal, legs };
}

export default function ChoiceScene(props: Props) {
  if (props.game === 'mines') return <MinesGrid {...props} />;
  return <CrossingScene {...props} />;
}

/**
 * The four street tints, safe to dangerous, on the asphalt itself. The road
 * deepens toward black as the streets pay more (the #SmarterCasinoRealism
 * panel, carbon and obsidian tones), so the gold-edged signs of the big streets
 * read on black. It no longer warms toward maroon (Dan: "ALWAYS USE
 * SMARTER.POKER COLOR SCHEMA COLORS, NO BROWNS OR PINKS").
 */
const STREET_TINTS = [0x172536, 0x111925, 0x0d1218, 0x0b1017];
/**
 * The painted sign inks are the strip's own (ChoiceScene.module.css), so a
 * street reads the same on the road as in the strip: a black plate, the
 * multiplier in silver, and an edge that carries the rise toward the big
 * streets, dim chrome to chrome to brass to gold. The street underfoot and the
 * next one light an electric-blue LED edge; red is the bust alone.
 */
const SIGN_INK = {
  plate: '#05070a',
  label: '#9aa5b3',
  figure: '#e4e7ec',
  led: '#45adff',
  bust: '#ff5b6e',
  spentEdge: '#3a4756',
  spentInk: '#7f8c9b',
  edge: ['#7f8c9b', '#b8c3cd', '#d6ad52', '#ffd700'],
} as const;
const SIGN_SLOTS = 16;
/** Dashes painted down one lane line, every two units across nine of them. */
const DASHES_PER_STREET = 9;
/**
 * The eight paints on the road: the first four are the near lane, the last
 * four the far one. One material per colour is shared by every car wearing it.
 */
const CAR_PAINTS = [
  0x246bad, 0xc3d4df, 0x8b3441, 0x49655f, 0x9a4a1f, 0x5b6f86, 0xb7a23a, 0x7a2e2e,
] as const;
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
  const ladder = props.ladder ?? ROAD_LADDERS[CHOICE_MODE.crossing];
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
  const pending = useRef<Pending | null>(null);
  // Held in a ref so the draw loop, which is mounted once, always calls the
  // live one without listing it as a dependency it cannot have.
  const commit = useRef((next: Shown, moments: readonly CrossingMoment[]) => {
    pending.current = null;
    shownRef.current = next;
    setShown(next);
    for (const moment of moments) latest.current.onMoment?.(moment, next.step);
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
    commit.current(next, advanced ? momentsFor(was, next).moments : []);
  }, [failed, reducedMotion, props.roundId, props.phase, step]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
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
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const kit = sceneParts();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1424);
    const fog = new THREE.Fog(0x0a1424, 22, 65);
    scene.fog = fog;
    const camera = new THREE.PerspectiveCamera(CROSSING_CAMERA.fov, 1, 0.1, 100);
    const pmrem = new THREE.PMREMGenerator(renderer),
      room = new RoomEnvironment(),
      environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    scene.environmentIntensity = 0.22;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xc9e9ff, 0x080f20, 0.8));
    const key = new THREE.DirectionalLight(0xffe9ca, 2.4);
    key.position.set(-5, 12, 8);
    key.castShadow = true;
    // A phone pays for the shadow map in heat and battery, and at this size on
    // this screen nobody can tell the two apart.
    const touch = matches('(pointer: coarse)');
    key.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 14, bottom: -14 });
    key.shadow.bias = -0.001;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0x4dbdff, 3.2);
    rim.position.set(5, 7, -6);
    scene.add(rim);
    const asphalt = kit.material(0x172536, 0.06, 0.95),
      steel = kit.material(0x6a8097, 0.8, 0.3),
      paint = kit.material(0xc7d9db, 0.1, 0.75);
    box(kit, scene, asphalt, 18, -0.28, 0, 62, 0.5, 20, 0.1);
    // Two cars per street: the second one joins the traffic on the more dangerous streets.
    const traffic: THREE.Group[][] = [];
    const glass = kit.material(0x071b2e, 0.4, 0.08),
      rubber = kit.material(0x080d16, 0.05, 0.85),
      lamp = kit.keep(
        new THREE.MeshStandardMaterial({
          color: 0xe3f8ff,
          emissive: 0x9bdfff,
          emissiveIntensity: 3,
        })
      ),
      taillight = kit.material(0xf74932, 0.1, 0.2);
    const wheel = kit.own(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 24));
    /**
     * THE CAR, BUILT ONCE. Every car on this road is the same seventeen parts,
     * so they are merged into one mesh per material here and every car after
     * this one is six meshes over those same six geometries. Only the paint
     * differs, and only the paint and the glass cast a shadow: a wheel's
     * shadow falls under the car that already casts one.
     */
    const template = (() => {
      const car = new THREE.Group(),
        body = kit.paint(CAR_PAINTS[0]);
      box(kit, car, body, 0, 0.49, 0, 1.35, 0.46, 2.7, 0.19);
      box(kit, car, glass, 0, 0.84, -0.15, 1.08, 0.54, 1.5, 0.16);
      box(kit, car, body, 0, 1.12, -0.23, 1, 0.1, 0.9, 0.08);
      box(kit, car, steel, 0, 0.34, 1.32, 1.15, 0.1, 0.08, 0.02);
      box(kit, car, steel, 0, 0.33, -1.32, 1.15, 0.1, 0.08, 0.02);
      for (const side of [-1, 1])
        for (const end of [-1, 1]) {
          const tyre = new THREE.Mesh(wheel, rubber);
          tyre.rotation.z = Math.PI / 2;
          tyre.position.set(side * 0.66, 0.3, end * 0.86);
          car.add(tyre);
          sphere(kit, car, steel, side * 0.77, 0.3, end * 0.86, 0.024, 0.15, 0.15);
        }
      for (const side of [-1, 1]) {
        box(kit, car, lamp, side * 0.46, 0.55, 1.35, 0.25, 0.13, 0.04, 0.03);
        box(kit, car, taillight, side * 0.46, 0.52, -1.35, 0.26, 0.13, 0.04, 0.03);
      }
      return mergeParts(kit, car).map((mesh) => ({
        geometry: mesh.geometry,
        material: mesh.material as THREE.Material,
        casts: mesh.material === body || mesh.material === glass,
        painted: mesh.material === body,
      }));
    })();
    const buildCar = (color: number) => {
      const car = new THREE.Group();
      for (const slot of template) {
        const mesh = new THREE.Mesh(slot.geometry, slot.painted ? kit.paint(color) : slot.material);
        mesh.castShadow = slot.casts;
        mesh.receiveShadow = true;
        car.add(mesh);
      }
      return car;
    };
    const laneSlabs: THREE.Mesh[] = [];
    // The 144 lane dashes are one shape in one place: one draw, not 144.
    const dashes = new THREE.InstancedMesh(
      kit.boxGeometry(0.035, 0.01, 0.9, 0.002),
      paint,
      SIGN_SLOTS * DASHES_PER_STREET
    );
    dashes.receiveShadow = true;
    const dashAt = new THREE.Matrix4();
    let dash = 0;
    const signGeometry = kit.own(new THREE.PlaneGeometry(1.6, 0.8));
    const signCanvases: HTMLCanvasElement[] = [];
    const textures: THREE.CanvasTexture[] = [];
    /**
     * A street sign prints the multiplier the street pays; the start prints
     * START. A black plate with the strip's edge for the street's band and state.
     */
    const paintSign = (
      canvas: HTMLCanvasElement,
      street: number,
      multiplier: string | null,
      band: number,
      state: StreetState
    ) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const blank = multiplier === null && street > 0;
      const lit = !blank && (state === 'current' || state === 'next');
      const bust = !blank && state === 'crash';
      const spent = blank || state === 'crossed';
      const edge = bust
        ? SIGN_INK.bust
        : lit
          ? SIGN_INK.led
          : spent
            ? SIGN_INK.spentEdge
            : SIGN_INK.edge[band];
      ctx.shadowBlur = 0;
      ctx.fillStyle = SIGN_INK.plate;
      ctx.fillRect(0, 0, 256, 128);
      // A lit edge blooms like an LED seam; a resting edge is one crisp line.
      ctx.shadowColor = edge;
      ctx.shadowBlur = lit || bust ? 16 : 0;
      ctx.strokeStyle = edge;
      ctx.lineWidth = 3;
      ctx.strokeRect(6, 6, 244, 116);
      ctx.shadowBlur = 0;
      ctx.textAlign = 'center';
      ctx.fillStyle = spent ? SIGN_INK.spentInk : SIGN_INK.figure;
      if (street === 0) {
        ctx.font = '700 48px sans-serif';
        ctx.fillText('START', 128, 82);
        return;
      }
      if (multiplier === null) return;
      ctx.font = '600 24px sans-serif';
      ctx.fillStyle = spent ? SIGN_INK.spentInk : SIGN_INK.label;
      ctx.fillText(`STREET ${street}`, 128, 38);
      ctx.font = '700 58px sans-serif';
      ctx.fillStyle = spent ? SIGN_INK.spentInk : SIGN_INK.figure;
      ctx.fillText(multiplier, 128, 100);
    };
    const streetSign = (street: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      signCanvases[street] = canvas;
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures.push(texture);
      return new THREE.MeshStandardMaterial({
        map: texture,
        metalness: 0.2,
        roughness: 0.6,
        // A neutral glow off the painted inks, so the silver reads as silver.
        emissive: 0xffffff,
        emissiveMap: texture,
        emissiveIntensity: 0.3,
      });
    };
    for (let i = 0; i < SIGN_SLOTS; i++) {
      const x = streetCenter(i);
      const slab = box(
        kit,
        scene,
        kit.keep(asphalt.clone()),
        x,
        -0.03,
        0,
        STREET_WIDTH - 0.12,
        0.12,
        19,
        0.025
      );
      laneSlabs.push(slab);
      for (let z = -8; z <= 8; z += 2)
        dashes.setMatrixAt(dash++, dashAt.makeTranslation(x - STREET_WIDTH / 2, 0.04, z));
      const sign = new THREE.Mesh(signGeometry, streetSign(i));
      sign.rotation.x = -Math.PI / 2;
      sign.position.set(x, 0.07, 2.25);
      scene.add(sign);
      if (i > 0) {
        const lane = [buildCar(CAR_PAINTS[i % 4]), buildCar(CAR_PAINTS[4 + (i % 4)])];
        lane.forEach((car) => {
          car.position.x = x;
          scene.add(car);
        });
        traffic[i] = lane;
      }
    }
    dashes.instanceMatrix.needsUpdate = true;
    scene.add(dashes);
    // One continuous highway. The starting shoulder is outside every traffic lane.
    box(kit, scene, paint, STREET_WIDTH / 2, 0.05, 0, 0.08, 0.02, 19, 0.005);
    box(kit, scene, paint, -STREET_WIDTH / 2, 0.05, 0, 0.08, 0.02, 19, 0.005);
    const animal = donkey(kit);
    animal.animal.scale.setScalar(DONKEY_SCALE);
    scene.add(animal.animal);
    const ghost = animal.animal.clone(true);
    ghost.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.material = obj.material.clone();
        obj.material.transparent = true;
        obj.material.opacity = 0.3;
      }
    });
    ghost.visible = false;
    scene.add(ghost);
    const impactCar = buildCar(0xe4a233);
    impactCar.visible = false;
    scene.add(impactCar);
    const flash = new THREE.Mesh(
      kit.own(new THREE.SphereGeometry(0.8, 20, 12)),
      kit.keep(new THREE.MeshBasicMaterial({ color: 0xffe2a3, transparent: true, opacity: 0.75 }))
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
    const frames = gpuFrameRenderer(renderer, scene, camera);
    let raf = 0,
      last = 0,
      signature = '',
      roadSignature = '',
      hazards: number[] = [],
      sceneElapsed = 0,
      actual = 0,
      from = 0,
      to = 0,
      stalled = 0,
      notified = false;
    let lastVisibleFrame: number | null = null;
    const visibilityChanged = () => {
      lastVisibleFrame = null;
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    /** The road is repainted only when its ladder changes: tints and traffic density. */
    const paintRoad = (road: readonly number[]) => {
      hazards = Array.from({ length: SIGN_SLOTS }, (_, i) =>
        i === 0 || i > road.length ? 0 : streetHazard(i - 1, road.length)
      );
      for (let i = 0; i < SIGN_SLOTS; i++)
        (laneSlabs[i].material as THREE.MeshPhysicalMaterial).color.setHex(
          i === 0 || i > road.length ? STREET_TINTS[0] : STREET_TINTS[hazardBand(hazards[i])]
        );
    };
    /** A sign is repainted only when its figure, band or state changes. */
    const signPainted: string[] = [];
    const paintSigns = (road: readonly number[], step: number, phase: Props['phase']) => {
      for (let i = 0; i < SIGN_SLOTS; i++) {
        const cents = road[i - 1];
        const multiplier = i > 0 && cents !== undefined ? streetMultiplier(cents) : null;
        const band = hazardBand(hazards[i] ?? 0);
        const state = streetState(i, step, phase);
        const key = `${multiplier}|${band}|${state}`;
        if (signPainted[i] === key) continue;
        signPainted[i] = key;
        paintSign(signCanvases[i], i, multiplier, band, state);
        textures[i].needsUpdate = true;
      }
    };
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const reduced = reducedRef.current;
      if (document.hidden || now - last < (reduced ? 100 : animating ? 16 : 33)) return;
      last = now;
      const visibleDelta = lastVisibleFrame === null ? 0 : now - lastVisibleFrame;
      lastVisibleFrame = now;
      const p = latest.current,
        road = p.ladder ?? ROAD_LADDERS[CHOICE_MODE.crossing],
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
        const owed = advanced ? momentsFor(was, next) : null;
        signature = newSignature;
        to = streetCenter(step);
        if (owed && owed.moments.length) {
          from = actual;
          pending.current = { moments: owed.moments, next, at: owed.at };
        } else {
          from = to;
          commit.current(next, []);
        }
        sceneElapsed = 0;
        stalled = 0;
        notified = false;
        needsDraw = true;
      } else sceneElapsed += visibleDelta;
      if (roadChanged || roundChanged) paintSigns(road, step, p.phase);
      const elapsed = sceneElapsed,
        walk = reduced ? 1 : Math.min(1, elapsed / (WALK_MS * getAnimationSpeed()));
      actual = THREE.MathUtils.lerp(from, to, walk * walk * (3 - 2 * walk));
      animal.animal.position.set(
        actual - 0.12,
        0.05 + (walk < 1 ? Math.sin(walk * Math.PI) * 0.28 : 0),
        0
      );
      animal.animal.rotation.z = 0;
      animal.animal.scale.setScalar(DONKEY_SCALE);
      animal.legs.forEach((leg, i) => {
        leg.rotation.z = walk < 1 ? Math.sin(walk * Math.PI * 4 + (i % 2) * Math.PI) * 0.5 : 0;
      });
      traffic.forEach((lane, i) => {
        if (!lane) return;
        const hazard = hazards[i] ?? 0;
        const open =
          crossingTrafficVisible(
            i,
            step,
            p.phase === 'lost',
            p.phase === 'cashed' ? (p.roadEnd ?? null) : null
          ) && !(walk < 1 && i === step - 1);
        // Traffic runs faster and thicker the further down the road it is.
        const period = 530 - 210 * hazard;
        lane.forEach((car, n) => {
          car.visible = open && (n === 0 || hazardBand(hazard) >= 2);
          car.position.z = reduced
            ? 7 - n * 6
            : (((((now / period) * (i % 2 ? 1 : -1) + i * 3.13 + n * 11) % 22) + 22) % 22) - 11;
          car.rotation.y = i % 2 ? 0 : Math.PI;
        });
      });
      impactCar.visible = p.phase === 'lost';
      flash.visible = false;
      let finished = walk === 1,
        struck = false;
      if (p.phase === 'lost') {
        // Stretched with the walk, so the car never arrives before the donkey.
        const impact = collisionAt(elapsed, getAnimationSpeed(), reduced);
        impactCar.position.set(to, 0, impact.carZ);
        impactCar.rotation.y = Math.PI;
        if (impact.hit) {
          animal.animal.rotation.z = (-Math.PI / 2) * impact.fall;
          animal.animal.position.y = 0.1;
          animal.animal.scale.y = DONKEY_SCALE * (1 - 0.8 * impact.fall);
          flash.position.set(to, 0.7, 0);
          flash.visible = impact.fall < 0.5;
          flash.scale.setScalar(0.5 + impact.fall);
        }
        struck = impact.hit;
        finished = impact.finished;
      }
      let focus = actual;
      ghost.visible = p.phase === 'cashed' && p.roadEnd !== null;
      if (ghost.visible) {
        const speed = getAnimationSpeed();
        const progress = reduced
          ? 1
          : Math.max(0, Math.min(1, (elapsed - 800 * speed) / (2400 * speed)));
        ghost.position.set(
          THREE.MathUtils.lerp(to, streetCenter(p.roadEnd ?? step), progress),
          0.05,
          0
        );
        focus = THREE.MathUtils.lerp(actual, ghost.position.x, 0.65);
        finished = finished && progress === 1;
      }
      // Straight down the road: the camera stands over the x it looks at.
      const view = aimCrossingCamera(camera, focus);
      fog.near = view.fogNear;
      fog.far = view.fogFar;
      // The shadow box follows the view, so every street in frame keeps its shadows.
      key.position.x = view.x - 4;
      key.target.position.x = view.x;
      const owed = pending.current;
      const ready =
        owed !== null && (owed.at === 'now' || (owed.at === 'walk' ? walk === 1 : struck));
      // Paused (an offer over an idle road, a receipt on top of it) or scrolled
      // off screen: the clock, the beats and completion all carry on, and only
      // the draw call is skipped. No reveal ever waits on scroll position.
      // Under reduced motion there is nothing to redraw between changes.
      const drawing = !p.paused && onScreen && (!reduced || needsDraw);
      const submitted = drawing ? frames.render() : true;
      if (drawing) needsDraw = false;
      animating = !finished;
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
      textures.forEach((texture) => {
        texture.needsUpdate = true;
      });
      needsDraw = true;
      setFailed(false);
    };
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visibilityChanged);
      frames.dispose();
      observer.disconnect();
      watcher?.disconnect();
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
      // The kit owns every shape and finish the scene was built from; the
      // traversal catches what the scene cloned for itself (the ghost's coats).
      scene.traverse((obj) => {
        if (obj instanceof THREE.InstancedMesh) obj.dispose();
        if (obj instanceof THREE.Mesh)
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) =>
            kit.materials.add(m)
          );
      });
      kit.dispose();
      textures.forEach((t) => t.dispose());
      environment.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      // The page mounts this scene again for every round. Without this the tab
      // keeps one live WebGL context per round it has played.
      renderer.forceContextLoss();
      canvas.remove();
    };
  }, []);
  // The strip keeps the street the donkey stands on in view without stealing the page scroll.
  const currentStreet = useRef<HTMLLIElement>(null);
  // Everything below prints the street the scene is showing; the prizes, the
  // ladder and the settled chips are the round's own numbers, printed as given.
  const shownStep = shown.step,
    shownPhase = shown.phase;
  useEffect(() => {
    const item = currentStreet.current;
    if (item && typeof item.scrollIntoView === 'function')
      item.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
  }, [shownStep, shownPhase, shown.roundId]);
  const reached = shownStep > 0 ? (props.prizes?.[shownStep - 1] ?? null) : null;
  const ahead = props.prizes?.[shownStep] ?? null;
  const lastStreet = ladder.length;
  /** A street beyond the ladder (a saved round on another road) reads as its last street. */
  const mult = (index: number) =>
    streetMultiplier(ladder[Math.min(Math.max(0, index), lastStreet - 1)]);
  const booked = props.payoutChips ?? reached;
  const readout = lost
    ? {
        label: `Bust On Street ${shownStep}`,
        value:
          props.payoutChips === undefined
            ? 'Round Over'
            : `${gameChips(props.payoutChips)} Chips Kept`,
        note:
          props.payoutChips === undefined
            ? 'The Donkey Did Not Make It Across'
            : 'The Guaranteed Minimum Is Yours',
      }
    : shownPhase === 'cashed'
      ? {
          label: `Booked At Street ${shownStep}`,
          value: booked === null ? 'Win Booked' : `${gameChips(booked)} Chips`,
          note:
            props.roadEnd === null
              ? `${mult(shownStep - 1)} Reached`
              : props.roadEnd === 0
                ? 'The Donkey Would Have Stopped Before Street 1'
                : `The Donkey Would Have Reached Street ${props.roadEnd}`,
        }
      : shownStep > 0
        ? {
            label: 'Cash Out Value',
            value: reached === null ? mult(shownStep - 1) : `${gameChips(reached)} Chips`,
            note:
              shownStep < lastStreet
                ? `Next Street Pays ${mult(shownStep)}${ahead === null ? '' : ` For ${gameChips(ahead)} Chips`}`
                : 'The Final Street. Book The Win.',
          }
        : {
            label: 'First Street Pays',
            value: ahead === null ? mult(0) : `${gameChips(ahead)} Chips At ${mult(0)}`,
            note: `${lastStreet} Streets Up To ${mult(lastStreet - 1)}`,
          };
  return (
    <div className={styles.scene} ref={host} data-motion="keep" data-phase={shownPhase}>
      <div className={styles.caption}>
        {lost
          ? 'Collision · Round Over'
          : shownPhase === 'cashed'
            ? 'Win Booked · Showing The Remaining Route'
            : shownPhase === 'idle'
              ? 'Start · Highway Ahead'
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
      <ol className={styles.streets} aria-label="Streets And Their Multipliers">
        {ladder.map((cents, index) => {
          const street = index + 1;
          const state = streetState(street, shownStep, shownPhase);
          const prize = props.prizes?.[index];
          return (
            <li
              key={street}
              ref={street === shownStep ? currentStreet : undefined}
              className={styles.street}
              data-state={state}
              data-hazard={hazardBand(streetHazard(index, ladder.length))}
              aria-current={street === shownStep ? 'step' : undefined}
              aria-label={`Street ${street} Pays ${streetMultiplier(cents)}${prize === undefined ? '' : `, ${gameChips(prize)} Chips`}${STREET_SPOKEN[state]}`}
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
