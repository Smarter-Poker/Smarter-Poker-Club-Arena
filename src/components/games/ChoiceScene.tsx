/** Lit geometry is presentation only. Every reveal comes from a confirmed RPC. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { brilliantGem } from './brilliantGem';
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
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const [positions, setPositions] = useState<Array<{ x: number; y: number }>>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
    } catch (error) {
      reportError(error, 'ChoiceScene.renderer');
      setFailed(true);
      return;
    }
    setFailed(false);
    const canvas = renderer.domElement;
    canvas.className = styles.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    node.prepend(canvas);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.82;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070b10);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const environment = pmrem.fromScene(room, 0.04);
    scene.environment = environment.texture;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xc8e8ff, 0x111924, 0.6));
    const key = new THREE.DirectionalLight(0xf4f7ff, 3);
    key.position.set(-4, 10, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10 });
    key.shadow.bias = -0.001;
    scene.add(key);
    scene.add(key.target);
    const rim = new THREE.DirectionalLight(0x1877f2, 2.5);
    rim.position.set(8, 4, -7);
    scene.add(rim);
    const steel = material(0x8797a8, 0.92, 0.2),
      gunmetal = material(0x19222d, 0.8, 0.3);
    const blue = material(0x1877f2, 0.5, 0.18),
      black = material(0x090d12, 0.12, 0.65);
    const tiles: THREE.Mesh[] = [];
    const prizes: THREE.Group[] = [];
    const traffic: THREE.Group[] = [];
    const animal = props.game === 'crossing' ? donkey() : null;
    let ghost: THREE.Object3D | null = null;
    if (props.game === 'mines') {
      camera.position.set(7.4, 11.5, 9.8);
      camera.lookAt(0, 0, 0);
      box(scene, steel, 0, -0.45, 0, 8.15, 0.55, 8.15, 0.22);
      box(scene, gunmetal, 0, -0.1, 0, 7.92, 0.26, 7.92, 0.15);
      for (let i = 0; i < 25; i++) {
        const x = ((i % 5) - 2) * 1.48,
          z = (Math.floor(i / 5) - 2) * 1.48;
        box(scene, blue, x, 0.04, z, 1.37, 0.12, 1.37, 0.12);
        const tile = box(scene, gunmetal.clone(), x, 0.24, z, 1.32, 0.38, 1.32, 0.14);
        tiles.push(tile);
        box(tile, steel, 0, 0.2, 0, 0.82, 0.018, 0.82, 0.12);
        const emblem = new THREE.Mesh(new THREE.OctahedronGeometry(0.2), blue);
        emblem.position.set(0, 0.26, 0);
        emblem.scale.y = 0.48;
        tile.add(emblem);
        const prize = new THREE.Group();
        prize.position.set(x, 0.48, z);
        scene.add(prize);
        prize.visible = false;
        prizes.push(prize);
        const crystal = new THREE.Mesh(
          brilliantGem(0.59),
          new THREE.MeshPhysicalMaterial({
            color: 0xe5f7ff,
            metalness: 0,
            roughness: 0.05,
            transmission: 0.86,
            ior: 2.417,
            thickness: 0.8,
            envMapIntensity: 3.2,
            attenuationColor: new THREE.Color(0xa8e6ff),
            attenuationDistance: 2,
            clearcoat: 1,
          })
        );
        crystal.scale.y = 1.25;
        crystal.rotation.z = 0.17;
        prize.add(crystal);
        const mine = new THREE.Group();
        sphere(mine, black, 0, 0, 0, 0.39, 0.39, 0.39);
        for (let j = 0; j < 8; j++) {
          const pin = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.33, 8), steel);
          pin.position.set(
            Math.sin((j * Math.PI) / 4) * 0.39,
            0,
            Math.cos((j * Math.PI) / 4) * 0.39
          );
          pin.quaternion.setFromUnitVectors(
            new THREE.Vector3(0, 1, 0),
            pin.position.clone().normalize()
          );
          mine.add(pin);
        }
        sphere(mine, material(0xff3232, 0.25, 0.15), 0, 0.39, 0, 0.1, 0.06, 0.1);
        prize.add(mine);
      }
      camera.updateMatrixWorld();
      setPositions(
        tiles.map((tile) => {
          const v = tile.position.clone().project(camera);
          return { x: (v.x + 1) * 50, y: (1 - v.y) * 50 };
        })
      );
    } else if (animal) {
      camera.position.set(5.4, 6.5, 9);
      camera.lookAt(1, 0, 0);
      box(scene, gunmetal, 9, -0.38, 0, 38, 0.5, 11, 0.1);
      for (let i = 0; i < 15; i++) {
        const x = i * 2.3;
        box(scene, black, x, -0.06, 0, 2.17, 0.15, 11, 0.03);
        for (let j = -3; j <= 3; j++)
          box(scene, steel, x, 0.03, j * 1.65, 0.06, 0.015, 0.66, 0.005);
        box(scene, blue, x, 0.08, -4.8, 2.1, 0.18, 0.22, 0.04);
        box(scene, steel, x, 0.08, 4.8, 2.1, 0.18, 0.22, 0.04);
        const car = new THREE.Group();
        car.position.x = x;
        scene.add(car);
        traffic.push(car);
        const paint = material([0x1877f2, 0xcfd7df, 0x263645][i % 3], 0.65, 0.18);
        box(car, paint, 0, 0.45, 0, 1.13, 0.44, 2.25, 0.16);
        box(car, black, 0, 0.77, -0.1, 0.87, 0.47, 1.2, 0.12);
        box(car, paint, 0, 1.01, -0.1, 0.84, 0.1, 0.73, 0.08);
        for (const side of [-1, 1])
          for (const end of [-1, 1]) {
            const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.23, 0.15, 18), black);
            wheel.rotation.z = Math.PI / 2;
            wheel.position.set(side * 0.56, 0.25, end * 0.71);
            car.add(wheel);
            sphere(car, steel, side * 0.66, 0.25, end * 0.71, 0.018, 0.13, 0.13);
          }
        box(car, material(0xf7f7ff, 0.3, 0.1), 0, 0.5, 1.1, 0.78, 0.09, 0.03, 0.01);
        box(car, material(0xe52b2b, 0.2, 0.2), 0, 0.5, -1.1, 0.78, 0.08, 0.03, 0.01);
      }
      // A small city gives the moving road distance, reflected light and scale.
      for (let i = 0; i < 18; i++) {
        const x = i * 2.5 - 4,
          height = 2.5 + ((i * 7) % 5) * 0.6;
        box(scene, gunmetal, x, height / 2, -7.2, 2.1, height, 2.3, 0.1);
        for (let floor = 0; floor < Math.floor(height / 0.6); floor++) {
          box(scene, blue, x, 0.5 + floor * 0.6, -5.99, 1.65, 0.12, 0.025, 0.01);
        }
      }
      animal.animal.scale.setScalar(1.18);
      animal.animal.position.set(-1.15, 0.05, 1.7);
      scene.add(animal.animal);
      ghost = animal.animal.clone(true);
      ghost.visible = false;
      ghost.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          const m = obj.material.clone();
          m.transparent = true;
          m.opacity = 0.4;
          obj.material = m;
        }
      });
      scene.add(ghost);
    }
    const resize = () => {
      const width = node.clientWidth;
      renderer.setSize(width, width, false);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(node);
    resize();
    let frame = 0,
      last = 0,
      previousStep = -1,
      changedAt = 0,
      from = -1.15,
      to = -1.15,
      actual = -1.15,
      revealAt = 0;
    let previousPhase = 'idle';
    const reduced = prefersReducedMotion();
    const draw = (now: number) => {
      frame = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced ? 180 : 30)) return;
      last = now;
      const p = latest.current;
      if (p.game === 'mines') {
        tiles.forEach((tile, i) => {
          const picked = p.picked.includes(i),
            exposed = p.mines !== null;
          const isMine = p.mines?.includes(i) ?? false;
          tile.visible = !picked && !exposed;
          prizes[i].visible = picked || exposed;
          prizes[i].children[0].visible = !isMine;
          prizes[i].children[1].visible = isMine;
          prizes[i].scale.setScalar(picked ? 1 : 0.78);
          prizes[i].position.y = 0.92 + (reduced ? 0 : Math.sin(now / 800 + i) * 0.045);
          prizes[i].children[0].rotation.y = reduced ? 0 : now / 3000 + i;
        });
      } else if (animal) {
        const step = p.picked.length - (p.phase === 'lost' ? 1 : 0);
        if (step !== previousStep) {
          previousStep = step;
          changedAt = now;
          from = actual;
          to = step * 2.3 - 1.15;
        }
        if (p.phase !== previousPhase) {
          previousPhase = p.phase;
          revealAt = now;
        }
        const t = reduced ? 1 : Math.min(1, (now - changedAt) / (550 * getAnimationSpeed()));
        actual = THREE.MathUtils.lerp(from, to, t * t * (3 - 2 * t));
        animal.animal.position.x = actual;
        animal.animal.position.y = 0.05 + (t < 1 ? Math.sin(t * Math.PI) * 0.48 : 0);
        animal.legs.forEach((leg, i) => {
          leg.rotation.z = t < 1 ? Math.sin(t * Math.PI * 4 + (i % 2) * Math.PI) * 0.55 : 0;
        });
        let focus = actual;
        if (ghost) {
          ghost.visible = p.phase === 'cashed' && p.roadEnd !== null;
          if (ghost.visible) {
            const progress = reduced ? 1 : Math.max(0, Math.min(1, (now - revealAt - 900) / 2400));
            ghost.position.set(
              THREE.MathUtils.lerp(to, (p.roadEnd ?? step) * 2.3 - 1.15, progress),
              0.05,
              1.7
            );
            ghost.traverse((part) => {
              if (part.name.startsWith('walking-leg-'))
                part.rotation.z =
                  !reduced && progress > 0 && progress < 1
                    ? Math.sin(progress * 24 + Number(part.name.slice(-1)) * Math.PI) * 0.55
                    : 0;
            });
            focus = ghost.position.x;
          }
        }
        traffic.forEach((car, i) => {
          car.position.z = reduced
            ? ((i * 3.17) % 12) - 6
            : (((((now / 650) * (i % 2 ? 1 : -1) + i * 3.17) % 14) + 14) % 14) - 7;
          car.rotation.y = i % 2 ? 0 : Math.PI;
        });
        camera.position.set(focus + 5.4, 6.5, 9);
        camera.lookAt(focus + 1, 0, 0);
        key.position.x = focus - 4;
        key.target.position.x = focus;
      }
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(draw);
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    const restored = () => setFailed(false);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
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
      materials.forEach((m) => m.dispose());
      environment.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
      canvas.remove();
    };
  }, [props.game]);
  return (
    <div className={styles.scene} ref={host} data-motion="keep">
      {failed ? (
        <div className={styles.fallback}>
          The 3D Scene Is Unavailable. Your Game Controls Still Work.
        </div>
      ) : null}
      {props.game === 'mines' && failed ? (
        <div className={styles.fallbackGrid}>
          {Array.from({ length: 25 }, (_, i) => (
            <button
              key={i}
              type="button"
              className={styles.fallbackTile}
              aria-label={`Tile ${i + 1}${props.mines?.includes(i) ? ', Mine' : props.picked.includes(i) || props.mines ? ', Gem' : ''}`}
              disabled={props.busy || props.phase !== 'open' || props.picked.includes(i)}
              onClick={() => props.onPick(i)}
            >
              {props.mines?.includes(i)
                ? 'Mine'
                : props.picked.includes(i) || props.mines
                  ? 'Gem'
                  : i + 1}
            </button>
          ))}
        </div>
      ) : null}
      {props.game === 'mines' && !failed
        ? positions.map((position, i) => (
            <button
              key={i}
              type="button"
              className={styles.tile}
              style={{ left: `${position.x}%`, top: `${position.y}%` }}
              aria-label={`Tile ${i + 1}${props.mines?.includes(i) ? ', Mine' : props.picked.includes(i) || props.mines ? ', Gem' : ''}`}
              disabled={props.busy || props.phase !== 'open' || props.picked.includes(i)}
              onClick={() => props.onPick(i)}
            />
          ))
        : null}
      <div className={styles.caption}>
        {props.game === 'crossing'
          ? 'Donkey Crossing'
          : props.phase === 'cashed'
            ? 'All Mines Revealed'
            : props.phase === 'open'
              ? 'Choose Your Next Tile'
              : 'Diamond Mines'}
      </div>
    </div>
  );
}
