/** Lit geometry is presentation only. Every reveal comes from a confirmed RPC. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { gpuFrameRenderer } from './gpuFrameRenderer';
import MinesGrid from './MinesGrid';
import {
  STREET_WIDTH,
  DONKEY_SCALE,
  streetCenter,
  crossingTrafficVisible,
  collisionFrame,
} from '../../utils/crossingScene';
import { CHOICE_MODE, ROAD_LADDERS, type ChoiceGame } from '../../utils/diamondChoiceMath';
import { gameChips } from '../../utils/bonusGameBudget';
import { prefersReducedMotion, getAnimationSpeed } from '../../utils/animationSpeed';
import { reportError } from '../../utils/errorReporter';
import styles from './ChoiceScene.module.css';

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
}

/** "1.10x" and "20.00x": a street's multiplier always reads with two decimals. */
export const streetMultiplier = (cents: number) => `${(cents / 100).toFixed(2)}x`;
/** How dangerous a street reads, 0 at the first street to 1 at the last. */
export const streetHazard = (index: number, count: number) =>
  count <= 1 ? 0 : Math.max(0, Math.min(1, index / (count - 1)));
/** Four hazard bands: the tint, the traffic and the strip all read from the same one. */
export const hazardBand = (hazard: number) => Math.min(3, Math.floor(hazard * 4));

function material(color: number, metalness = 0.7, roughness = 0.24) {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness,
    roughness,
    clearcoat: 0.85,
    clearcoatRoughness: 0.2,
  });
}
function box(
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
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), mat);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
function sphere(
  parent: THREE.Object3D,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number
) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), mat);
  mesh.position.set(x, y, z);
  mesh.scale.set(sx, sy, sz);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Original sculpted donkey, with separate ears, muzzle, mane, tail and walking legs. */
function donkey() {
  const animal = new THREE.Group();
  const coat = material(0x786c5d, 0, 0.94),
    pale = material(0xd7cbbb, 0, 0.9);
  const dark = material(0x20252b, 0.05, 0.5),
    eye = material(0x080b0d, 0.1, 0.05);
  coat.clearcoat = 0.03;
  pale.clearcoat = 0.02;
  sphere(animal, coat, 0, 0.95, 0, 0.65, 0.43, 0.35);
  sphere(animal, pale, 0, 0.8, 0, 0.49, 0.28, 0.32);
  const legs: THREE.Group[] = [];
  for (const x of [-0.38, 0.4])
    for (const z of [-0.23, 0.23]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.82, z);
      leg.name = `walking-leg-${legs.length}`;
      sphere(leg, coat, 0, -0.25, 0, 0.1, 0.34, 0.105);
      box(leg, dark, 0.035, -0.61, 0, 0.22, 0.17, 0.21, 0.06);
      animal.add(leg);
      legs.push(leg);
    }
  sphere(animal, coat, 0.49, 1.27, 0, 0.25, 0.51, 0.26).rotation.z = -0.35;
  sphere(animal, coat, 0.68, 1.66, 0, 0.35, 0.3, 0.28);
  sphere(animal, pale, 0.96, 1.52, 0, 0.28, 0.21, 0.255);
  for (const z of [-0.215, 0.215]) {
    sphere(animal, eye, 0.83, 1.74, z, 0.064, 0.076, 0.034);
    sphere(animal, pale, 0.84, 1.77, z * 1.1, 0.018, 0.019, 0.014);
    sphere(animal, dark, 1.16, 1.55, z * 0.75, 0.035, 0.023, 0.03);
    const ear = sphere(animal, coat, 0.53, 2.05, z * 0.65, 0.095, 0.4, 0.105);
    ear.rotation.z = 0.13;
    sphere(animal, pale, 0.56, 2.09, z * 0.65, 0.045, 0.26, 0.108).rotation.z = 0.13;
  }
  for (let i = 0; i < 7; i++)
    sphere(animal, dark, 0.3 + i * 0.045, 1.33 + i * 0.078, 0, 0.07, 0.095, 0.14);
  const tail = sphere(animal, coat, -0.72, 0.9, 0, 0.055, 0.38, 0.055);
  tail.rotation.z = -0.7;
  sphere(animal, dark, -0.94, 0.66, 0, 0.11, 0.17, 0.11);
  return { animal, legs };
}

export default function ChoiceScene(props: Props) {
  if (props.game === 'mines') return <MinesGrid {...props} />;
  return <CrossingScene {...props} />;
}

/** The four street tints, safe to dangerous, on the asphalt itself. */
const STREET_TINTS = [0x172536, 0x23283a, 0x322838, 0x442532];
const SIGN_SLOTS = 16;

function CrossingScene(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
  const ladder = props.ladder ?? ROAD_LADDERS[CHOICE_MODE.crossing];
  const step = props.picked.length;
  const lost = props.phase === 'lost';
  useEffect(() => {
    if (failed) latest.current.onSettled?.();
  }, [failed, props.phase, props.picked.length]);
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
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a1424);
    scene.fog = new THREE.Fog(0x0a1424, 22, 65);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
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
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -12, right: 12, top: 14, bottom: -14 });
    key.shadow.bias = -0.001;
    scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0x4dbdff, 3.2);
    rim.position.set(5, 7, -6);
    scene.add(rim);
    const asphalt = material(0x172536, 0.06, 0.95),
      steel = material(0x6a8097, 0.8, 0.3),
      paint = material(0xc7d9db, 0.1, 0.75);
    box(scene, asphalt, 18, -0.28, 0, 62, 0.5, 20, 0.1);
    // Two cars per street: the second one joins the traffic on the more dangerous streets.
    const traffic: THREE.Group[][] = [];
    const buildCar = (color: number) => {
      const car = new THREE.Group(),
        body = material(color, 0.65, 0.18),
        glass = material(0x071b2e, 0.4, 0.08),
        rubber = material(0x080d16, 0.05, 0.85);
      box(car, body, 0, 0.49, 0, 1.35, 0.46, 2.7, 0.19);
      box(car, glass, 0, 0.84, -0.15, 1.08, 0.54, 1.5, 0.16);
      box(car, body, 0, 1.12, -0.23, 1, 0.1, 0.9, 0.08);
      box(car, steel, 0, 0.34, 1.32, 1.15, 0.1, 0.08, 0.02);
      box(car, steel, 0, 0.33, -1.32, 1.15, 0.1, 0.08, 0.02);
      for (const side of [-1, 1])
        for (const end of [-1, 1]) {
          const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 24), rubber);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(side * 0.66, 0.3, end * 0.86);
          car.add(wheel);
          sphere(car, steel, side * 0.77, 0.3, end * 0.86, 0.024, 0.15, 0.15);
        }
      const lamp = new THREE.MeshStandardMaterial({
        color: 0xe3f8ff,
        emissive: 0x9bdfff,
        emissiveIntensity: 3,
      });
      for (const side of [-1, 1]) {
        box(car, lamp, side * 0.46, 0.55, 1.35, 0.25, 0.13, 0.04, 0.03);
        box(car, material(0xf74932, 0.1, 0.2), side * 0.46, 0.52, -1.35, 0.26, 0.13, 0.04, 0.03);
      }
      return car;
    };
    const laneSigns: THREE.Mesh[] = [];
    const laneSlabs: THREE.Mesh[] = [];
    const signCanvases: HTMLCanvasElement[] = [];
    const textures: THREE.CanvasTexture[] = [];
    /** A street sign prints the multiplier the street pays; the start prints START. */
    const paintSign = (canvas: HTMLCanvasElement, street: number, multiplier: string | null) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#091722';
      ctx.fillRect(0, 0, 256, 128);
      ctx.strokeStyle = multiplier === null && street > 0 ? '#2c4658' : '#85cfff';
      ctx.lineWidth = 3;
      ctx.strokeRect(6, 6, 244, 116);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#def5ff';
      if (street === 0) {
        ctx.font = '700 48px sans-serif';
        ctx.fillText('START', 128, 82);
        return;
      }
      if (multiplier === null) return;
      ctx.font = '600 24px sans-serif';
      ctx.fillText(`STREET ${street}`, 128, 38);
      ctx.font = '700 58px sans-serif';
      ctx.fillStyle = '#ffe9a8';
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
        emissive: 0x326b8e,
        emissiveMap: texture,
        emissiveIntensity: 0.25,
      });
    };
    for (let i = 0; i < SIGN_SLOTS; i++) {
      const x = streetCenter(i);
      const slab = box(scene, asphalt.clone(), x, -0.03, 0, STREET_WIDTH - 0.12, 0.12, 19, 0.025);
      laneSlabs.push(slab);
      for (let z = -8; z <= 8; z += 2)
        box(scene, paint, x - STREET_WIDTH / 2, 0.04, z, 0.035, 0.01, 0.9, 0.002);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), streetSign(i));
      sign.rotation.x = -Math.PI / 2;
      sign.position.set(x, 0.07, 2.25);
      scene.add(sign);
      laneSigns.push(sign);
      if (i > 0) {
        const lane = [
          buildCar([0x246bad, 0xc3d4df, 0x8b3441, 0x49655f][i % 4]),
          buildCar([0x9a4a1f, 0x5b6f86, 0xb7a23a, 0x7a2e2e][i % 4]),
        ];
        lane.forEach((car) => {
          car.position.x = x;
          scene.add(car);
        });
        traffic[i] = lane;
      }
    }
    // One continuous highway. The starting shoulder is outside every traffic lane.
    box(scene, paint, STREET_WIDTH / 2, 0.05, 0, 0.08, 0.02, 19, 0.005);
    box(scene, paint, -STREET_WIDTH / 2, 0.05, 0, 0.08, 0.02, 19, 0.005);
    const animal = donkey();
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
      new THREE.SphereGeometry(0.8, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe2a3, transparent: true, opacity: 0.75 })
    );
    flash.visible = false;
    scene.add(flash);
    const resize = () => {
      const w = node.clientWidth,
        h = node.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    const reduced = prefersReducedMotion();
    const frames = gpuFrameRenderer(renderer, scene, camera);
    /* THE PROGRAMS ARE COMPILED BEFORE THE FIRST FRAME, NOT INSIDE IT
       (2026-09-22). Every material here is a MeshPhysicalMaterial lit by a
       shadow-casting key light, so the first renderer.render() compiles and
       links the whole program set on the main thread - and that first frame
       lands while the page is still animating the Double Down offer in.
       compileAsync gives the work to the driver instead, and the scene simply
       submits no frame until it answers. The clock below keeps running while
       it waits, so the walk is not delayed, only unshown.
       A renderer without compileAsync - an older three, a test double - draws
       immediately, exactly as it did before. */
    let compiled = typeof renderer.compileAsync !== 'function';
    let compileTimer = 0;
    if (!compiled) {
      const ready = () => {
        compiled = true;
        clearTimeout(compileTimer);
      };
      // Either answer releases the scene: a driver that refuses to compile
      // ahead of time still renders, it just pays for it in the first frame.
      void renderer.compileAsync(scene, camera).then(ready, ready);
      compileTimer = window.setTimeout(ready, 1500);
    }
    let raf = 0,
      last = 0,
      signature = '',
      roadSignature = '',
      hazards: number[] = [],
      sceneElapsed = 0,
      actual = 0,
      from = 0,
      to = 0,
      notified = false;
    let lastVisibleFrame: number | null = null;
    const visibilityChanged = () => {
      lastVisibleFrame = null;
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    /** The road is repainted only when its ladder changes: signs, tints and traffic density. */
    const paintRoad = (road: readonly number[]) => {
      hazards = Array.from({ length: SIGN_SLOTS }, (_, i) =>
        i === 0 || i > road.length ? 0 : streetHazard(i - 1, road.length)
      );
      for (let i = 0; i < SIGN_SLOTS; i++) {
        const cents = road[i - 1];
        paintSign(
          signCanvases[i],
          i,
          i > 0 && cents !== undefined ? streetMultiplier(cents) : null
        );
        textures[i].needsUpdate = true;
        (laneSlabs[i].material as THREE.MeshPhysicalMaterial).color.setHex(
          i === 0 || i > road.length ? STREET_TINTS[0] : STREET_TINTS[hazardBand(hazards[i])]
        );
      }
    };
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced ? 100 : 16)) return;
      last = now;
      const visibleDelta = lastVisibleFrame === null ? 0 : now - lastVisibleFrame;
      lastVisibleFrame = now;
      const p = latest.current,
        road = p.ladder ?? ROAD_LADDERS[CHOICE_MODE.crossing],
        step = p.picked.length,
        newSignature = `${p.roundId}:${step}:${p.phase}`;
      const newRoad = road.join(',');
      if (newRoad !== roadSignature) {
        roadSignature = newRoad;
        paintRoad(road);
      }
      if (newSignature !== signature) {
        signature = newSignature;
        from = p.phase === 'idle' ? 0 : actual;
        to = streetCenter(step);
        sceneElapsed = 0;
        notified = false;
      } else sceneElapsed += visibleDelta;
      const elapsed = sceneElapsed,
        walk = reduced ? 1 : Math.min(1, elapsed / (420 * getAnimationSpeed()));
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
          crossingTrafficVisible(i, step, p.phase === 'lost') && !(walk < 1 && i === step - 1);
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
      let finished = walk === 1;
      if (p.phase === 'lost') {
        const impact = collisionFrame(Math.max(0, elapsed - 220), reduced);
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
        finished = impact.finished;
      }
      let focus = actual;
      ghost.visible = p.phase === 'cashed' && p.roadEnd !== null;
      if (ghost.visible) {
        const progress = reduced ? 1 : Math.max(0, Math.min(1, (elapsed - 800) / 2400));
        ghost.position.set(
          THREE.MathUtils.lerp(to, streetCenter(p.roadEnd ?? step), progress),
          0.05,
          0
        );
        focus = THREE.MathUtils.lerp(actual, ghost.position.x, 0.65);
        finished = finished && progress === 1;
      }
      laneSigns.forEach((sign, i) => {
        (sign.material as THREE.MeshPhysicalMaterial).color.setHex(
          i === step
            ? p.phase === 'lost'
              ? 0xff745b
              : 0x64cbb0
            : i === step + 1
              ? 0x65cfff
              : 0x294966
        );
      });
      camera.position.set(focus + 2.6, 8.5, 10.8);
      camera.lookAt(focus + 0.6, 0.1, 0);
      key.position.x = focus - 4;
      key.target.position.x = focus;
      if (compiled && frames.render() && finished && !notified) {
        notified = true;
        p.onSettled?.();
      }
    };
    raf = requestAnimationFrame(draw);
    const lost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
      latest.current.onSettled?.();
    };
    canvas.addEventListener('webglcontextlost', lost);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(compileTimer);
      document.removeEventListener('visibilitychange', visibilityChanged);
      frames.dispose();
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', lost);
      const geometries = new Set<THREE.BufferGeometry>(),
        materials = new Set<THREE.Material>();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          geometries.add(obj.geometry);
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((m) =>
            materials.add(m)
          );
        }
      });
      geometries.forEach((g) => g.dispose());
      textures.forEach((t) => t.dispose());
      materials.forEach((m) => m.dispose());
      environment.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, []);
  // The strip keeps the street the donkey stands on in view without stealing the page scroll.
  const currentStreet = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const item = currentStreet.current;
    if (item && typeof item.scrollIntoView === 'function')
      item.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'auto' });
  }, [step, props.phase, props.roundId]);
  const reached = step > 0 ? (props.prizes?.[step - 1] ?? null) : null;
  const ahead = props.prizes?.[step] ?? null;
  const lastStreet = ladder.length;
  /** A street beyond the ladder (a saved round on another road) reads as its last street. */
  const mult = (index: number) =>
    streetMultiplier(ladder[Math.min(Math.max(0, index), lastStreet - 1)]);
  const booked = props.payoutChips ?? reached;
  const readout =
    props.phase === 'lost'
      ? {
          label: `Bust On Street ${step}`,
          value:
            props.payoutChips === undefined
              ? 'Round Over'
              : `${gameChips(props.payoutChips)} Chips Kept`,
          note:
            props.payoutChips === undefined
              ? 'The Donkey Did Not Make It Across'
              : 'The Guaranteed Minimum Is Yours',
        }
      : props.phase === 'cashed'
        ? {
            label: `Booked At Street ${step}`,
            value: booked === null ? 'Win Booked' : `${gameChips(booked)} Chips`,
            note:
              props.roadEnd === null
                ? `${mult(step - 1)} Reached`
                : props.roadEnd === 0
                  ? 'The Donkey Would Have Stopped Before Street 1'
                  : `The Donkey Would Have Reached Street ${props.roadEnd}`,
          }
        : step > 0
          ? {
              label: 'Cash Out Value',
              value: reached === null ? mult(step - 1) : `${gameChips(reached)} Chips`,
              note:
                step < lastStreet
                  ? `Next Street Pays ${mult(step)}${ahead === null ? '' : ` For ${gameChips(ahead)} Chips`}`
                  : 'The Final Street. Book The Win.',
            }
          : {
              label: 'First Street Pays',
              value: ahead === null ? mult(0) : `${gameChips(ahead)} Chips At ${mult(0)}`,
              note: `${lastStreet} Streets Up To ${mult(lastStreet - 1)}`,
            };
  return (
    <div className={styles.scene} ref={host} data-motion="keep" data-phase={props.phase}>
      <div className={styles.caption}>
        {lost
          ? 'Collision · Round Over'
          : props.phase === 'cashed'
            ? 'Win Booked · Showing The Remaining Route'
            : props.phase === 'idle'
              ? 'Start · Highway Ahead'
              : `Street ${step} · Next Street Clear`}
      </div>
      <div className={styles.readout} aria-live="polite" data-tone={lost ? 'bust' : undefined}>
        <span className={styles.readoutLabel}>{readout.label}</span>
        <strong className={styles.readoutValue}>{readout.value}</strong>
        <span className={styles.readoutNote}>{readout.note}</span>
      </div>
      {lost && (
        <div className={styles.bust} role="status" aria-label={`Bust On Street ${step}`}>
          <span>Bust</span>
        </div>
      )}
      <ol className={styles.streets} aria-label="Streets And Their Multipliers">
        {ladder.map((cents, index) => {
          const street = index + 1;
          const state =
            lost && street === step
              ? 'crash'
              : street < step || (street === step && props.phase === 'cashed')
                ? 'crossed'
                : street === step
                  ? 'current'
                  : street === step + 1 && !lost
                    ? 'next'
                    : 'ahead';
          const prize = props.prizes?.[index];
          return (
            <li
              key={street}
              ref={street === step ? currentStreet : undefined}
              className={styles.street}
              data-state={state}
              data-hazard={hazardBand(streetHazard(index, ladder.length))}
              aria-current={street === step ? 'step' : undefined}
              aria-label={`Street ${street} Pays ${streetMultiplier(cents)}${prize === undefined ? '' : `, ${gameChips(prize)} Chips`}`}
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
