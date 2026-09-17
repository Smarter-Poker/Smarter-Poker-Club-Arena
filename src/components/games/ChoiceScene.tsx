/** Lit geometry is presentation only. Every reveal comes from a confirmed RPC. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import MinesGrid from './MinesGrid';
import {
  STREET_WIDTH,
  DONKEY_SCALE,
  streetCenter,
  crossingTrafficVisible,
  collisionFrame,
} from '../../utils/crossingScene';
import type { ChoiceGame } from '../../utils/diamondChoiceMath';
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
}

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
function CrossingScene(props: Props) {
  const host = useRef<HTMLDivElement>(null),
    latest = useRef(props);
  latest.current = props;
  const [failed, setFailed] = useState(false);
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
      paint = material(0xc7d9db, 0.1, 0.75),
      curb = material(0x3f5268, 0.1, 0.7);
    box(scene, asphalt, 18, -0.28, 0, 62, 0.5, 20, 0.1);
    const traffic: THREE.Group[] = [];
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
    const textures: THREE.Texture[] = [];
    const streetSign = (street: number) => {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 128;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#091722';
      ctx.fillRect(0, 0, 256, 128);
      ctx.strokeStyle = '#85cfff';
      ctx.lineWidth = 3;
      ctx.strokeRect(6, 6, 244, 116);
      ctx.textAlign = 'center';
      ctx.fillStyle = '#def5ff';
      ctx.font = '600 24px sans-serif';
      ctx.fillText('STREET', 128, 42);
      ctx.font = '700 55px sans-serif';
      ctx.fillText(String(street), 128, 98);
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
    for (let i = 0; i < 16; i++) {
      const x = streetCenter(i);
      box(scene, asphalt, x, -0.03, 0, STREET_WIDTH - 0.12, 0.12, 19, 0.025);
      for (let z = -8; z <= 8; z += 2)
        box(scene, paint, x - STREET_WIDTH / 2, 0.04, z, 0.035, 0.01, 0.9, 0.002);
      for (const z of [-5, 5]) {
        box(scene, curb, x, 0.15, z, STREET_WIDTH - 0.08, 0.36, 0.65, 0.045);
        box(scene, steel, x, 0.36, z, STREET_WIDTH - 0.08, 0.03, 0.66, 0.01);
      }
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.8), streetSign(i));
      sign.rotation.x = -Math.PI / 2;
      sign.position.set(x, 0.07, 2.25);
      scene.add(sign);
      laneSigns.push(sign);
      if (i > 0) {
        const car = buildCar([0x246bad, 0xc3d4df, 0x8b3441, 0x49655f][i % 4]);
        car.position.x = x;
        scene.add(car);
        traffic[i] = car;
      }
    }
    // Pavement, illuminated shopfronts and street lamps establish a real street scale.
    for (let i = -2; i < 18; i++) {
      const x = i * 3.1,
        h = 3 + ((i * i) % 4);
      box(scene, curb, x, h / 2, -8, 2.9, h, 3, 0.06);
      for (let floor = 0; floor < h - 0.5; floor += 0.9)
        for (let col = -1; col <= 1; col++) {
          const windowMat = new THREE.MeshStandardMaterial({
            color: 0x8ec6e5,
            emissive: (i + col) % 3 ? 0x246082 : 0xa0713b,
            emissiveIntensity: 0.65,
          });
          box(scene, windowMat, x + col * 0.75, 0.65 + floor, -6.47, 0.46, 0.46, 0.025, 0.01);
        }
      if (i % 2 === 0) {
        box(scene, steel, x, 1.7, 4.8, 0.065, 3.4, 0.065, 0.01);
        box(scene, steel, x, 3.4, 4.35, 0.07, 0.06, 0.9, 0.01);
        const light = new THREE.Mesh(
          new THREE.SphereGeometry(0.14, 12, 8),
          new THREE.MeshBasicMaterial({ color: 0xffe8ad })
        );
        light.position.set(x, 3.35, 3.95);
        scene.add(light);
      }
    }
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
    let raf = 0,
      last = 0,
      signature = '',
      changedAt = 0,
      actual = 0,
      from = 0,
      to = 0,
      notified = false;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced ? 100 : 16)) return;
      last = now;
      const p = latest.current,
        step = p.picked.length,
        newSignature = `${p.roundId}:${step}:${p.phase}`;
      if (newSignature !== signature) {
        signature = newSignature;
        from = p.phase === 'idle' ? 0 : actual;
        to = streetCenter(step);
        changedAt = now;
        notified = false;
      }
      const elapsed = now - changedAt,
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
      traffic.forEach((car, i) => {
        if (!car) return;
        car.visible =
          crossingTrafficVisible(i, step, p.phase === 'lost') && !(walk < 1 && i === step - 1);
        car.position.z = reduced
          ? 7
          : (((((now / 530) * (i % 2 ? 1 : -1) + i * 3.13) % 22) + 22) % 22) - 11;
        car.rotation.y = i % 2 ? 0 : Math.PI;
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
      if (finished && !notified) {
        notified = true;
        p.onSettled?.();
      }
      renderer.render(scene, camera);
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
  return (
    <div className={styles.scene} ref={host} data-motion="keep" data-phase={props.phase}>
      <div className={styles.caption}>
        {props.phase === 'lost'
          ? 'Collision · No Prize'
          : props.phase === 'cashed'
            ? 'Win Booked · Showing The Remaining Route'
            : `Street ${props.picked.length} · Next Street Clear`}
      </div>
      {failed && (
        <p className={styles.fallback}>
          The Street Animation Is Unavailable. Your Confirmed Result And Controls Remain Available.
        </p>
      )}
    </div>
  );
}
