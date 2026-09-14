/** A rendered flight follows the server clock, then reveals the sealed crash. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { gameRenderer, metal, solid } from '../games/sceneKit';
import { prefersReducedMotion, getAnimationSpeed } from '../../utils/animationSpeed';
import { crashMultiplierCents } from '../../utils/diamondGamesFairness';
import { reportError } from '../../utils/errorReporter';
import styles from './CrashCurve.module.css';
export type CrashPhase = 'idle' | 'open' | 'cashed' | 'crashed';
export interface CrashCurveProps {
  phase: CrashPhase;
  growthK: number;
  capCents: number;
  startedAtLocalMs: number | null;
  finalCents: number | null;
  cashoutCents: number | null;
  crashCents?: number | null;
  autoCashoutCents: number | null;
  width?: number;
  height?: number;
  onTick?: (cents: number) => void;
}
function jet() {
  const group = new THREE.Group();
  const chrome = metal(0xd4dde5, 0.13),
    blue = metal(0x1877f2, 0.14),
    dark = metal(0x111b2b, 0.15);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.33, 2.6, 28), chrome);
  body.rotation.z = -Math.PI / 2;
  group.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.8, 28), chrome);
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 1.7;
  group.add(nose);
  const glass = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), dark);
  glass.scale.set(0.7, 0.22, 0.22);
  glass.position.set(0.65, 0.2, 0);
  group.add(glass);
  for (const side of [-1, 1]) {
    const shape = new THREE.Shape();
    shape.moveTo(0.55, 0);
    shape.lineTo(-0.8, side * 1.65);
    shape.lineTo(-1.02, side * 1.52);
    shape.lineTo(-0.65, 0);
    shape.closePath();
    const wing = new THREE.Mesh(
      new THREE.ExtrudeGeometry(shape, {
        depth: 0.06,
        bevelEnabled: true,
        bevelThickness: 0.02,
        bevelSize: 0.025,
        bevelSegments: 2,
        steps: 1,
      }),
      chrome
    );
    wing.rotation.x = Math.PI / 2;
    group.add(wing);
    solid(group, blue, [0.7, 0.08, 0.55], [-1, 0.12, side * 0.35], 0.03);
  }
  solid(group, blue, [0.45, 0.72, 0.06], [-1.05, 0.4, 0], 0.03).rotation.z = 0.25;
  const exhaust = new THREE.Mesh(
    new THREE.ConeGeometry(0.21, 1.45, 20),
    new THREE.MeshBasicMaterial({
      color: 0x39b6ff,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  exhaust.rotation.z = Math.PI / 2;
  exhaust.position.x = -1.95;
  group.add(exhaust);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh) o.castShadow = true;
  });
  return { group, exhaust };
}
export default function CrashCurve(props: CrashCurveProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const width = props.width ?? 360;
  const height = props.height ?? 300;
  useEffect(() => {
    if (!canvas.current) return;
    let kit: ReturnType<typeof gameRenderer>;
    try {
      kit = gameRenderer(canvas.current, width, height);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      reportError(e, 'CrashCurve.renderer');
      return;
    }
    const { scene, camera, renderer } = kit;
    const surface = renderer.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    const restored = () => setFailed(false);
    surface.addEventListener('webglcontextlost', lost);
    surface.addEventListener('webglcontextrestored', restored);
    camera.position.set(0, 3.5, 12);
    camera.lookAt(0, 0, 0);
    scene.fog = new THREE.FogExp2(0x070b10, 0.025);
    const points = new Float32Array(240 * 3);
    for (let i = 0; i < 240; i++) {
      points[i * 3] = ((i * 37.13) % 42) - 21;
      points[i * 3 + 1] = ((i * 11.71) % 24) - 9;
      points[i * 3 + 2] = -((i * 19.3) % 60) - 6;
    }
    const starsGeometry = new THREE.BufferGeometry();
    starsGeometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    const stars = new THREE.Points(
      starsGeometry,
      new THREE.PointsMaterial({ color: 0x92c8ff, size: 0.07, transparent: true, opacity: 0.7 })
    );
    scene.add(stars);
    const grid = new THREE.GridHelper(60, 30, 0x1877f2, 0x102644);
    grid.position.y = -3.2;
    scene.add(grid);
    const orbit = new THREE.Mesh(new THREE.TorusGeometry(4.5, 0.035, 8, 100), metal(0x1877f2));
    orbit.position.set(1, 1, -8);
    orbit.rotation.x = 0.35;
    scene.add(orbit);
    const flight = jet();
    scene.add(flight.group);
    flight.group.scale.setScalar(0.83);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
    const trailMat = new THREE.LineBasicMaterial({
      color: 0x39b6ff,
      transparent: true,
      opacity: 0.85,
    });
    const trail = new THREE.Line(trailGeo, trailMat);
    scene.add(trail);
    const marker = new THREE.Mesh(
      new THREE.TorusGeometry(0.22, 0.035, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x5df2a0 })
    );
    scene.add(marker);
    marker.visible = false;
    const burstGeometry = new THREE.BufferGeometry();
    burstGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(80 * 3), 3));
    const burst = new THREE.Points(
      burstGeometry,
      new THREE.PointsMaterial({ color: 0xff6c52, size: 0.08, transparent: true, opacity: 0.9 })
    );
    scene.add(burst);
    burst.visible = false;
    let raf = 0,
      last = 0,
      previousPhase: CrashPhase = 'idle',
      revealAt = 0;
    const reduced = prefersReducedMotion();
    const speed = getAnimationSpeed();
    const point = (v: number) => new THREE.Vector3(-3.8 + v * 7.1, -1.55 + v * v * 3.5, 0);
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced ? 180 : 30)) return;
      last = now;
      const p = latest.current;
      if (p.phase !== previousPhase) {
        previousPhase = p.phase;
        revealAt = now;
      }
      const elapsed =
        p.startedAtLocalMs === null ? 0 : Math.max(0, performance.now() - p.startedAtLocalMs);
      const current =
        p.phase === 'open'
          ? crashMultiplierCents(p.growthK, elapsed, p.capCents)
          : (p.finalCents ?? 100);
      if (p.phase === 'open') p.onTick?.(current);
      const target =
        p.phase === 'cashed' ? (p.crashCents ?? p.finalCents ?? 100) : (p.finalCents ?? current);
      const replay =
        p.phase === 'cashed'
          ? reduced
            ? 1
            : Math.max(0, Math.min(1, (now - revealAt - 800) / (2600 * speed)))
          : 0;
      const shown =
        p.phase === 'cashed'
          ? Math.exp(
              THREE.MathUtils.lerp(
                Math.log(Math.max(100, p.cashoutCents ?? 100)),
                Math.log(Math.max(100, target)),
                replay
              )
            )
          : current;
      const maxLog = Math.max(Math.log(4), Math.log(Math.max(shown, target) / 100) * 1.12);
      const progress =
        p.phase === 'idle' ? 0.14 : Math.min(0.92, Math.log(Math.max(100, shown) / 100) / maxLog);
      const head = point(progress);
      flight.group.position.copy(head);
      flight.group.rotation.set(
        0.08,
        0.08,
        Math.atan(progress * 0.85) +
          (p.phase === 'idle' && !reduced ? Math.sin(now / 900) * 0.035 : 0)
      );
      flight.exhaust.scale.y = reduced ? 1 : 0.8 + Math.sin(now / 75) * 0.2;
      const finished = p.phase === 'crashed' || (p.phase === 'cashed' && replay === 1);
      flight.group.visible = !finished;
      burst.visible = finished;
      const values = trailGeo.attributes.position.array as Float32Array;
      for (let i = 0; i < 96; i++) {
        const v = point((progress * i) / 95);
        values.set([v.x, v.y, v.z], i * 3);
      }
      trailGeo.attributes.position.needsUpdate = true;
      trailMat.color.setHex(finished ? 0xff6152 : 0x39b6ff);
      marker.visible = p.phase === 'cashed';
      if (marker.visible)
        marker.position.copy(
          point(Math.min(0.92, Math.log(Math.max(100, p.cashoutCents ?? 100) / 100) / maxLog))
        );
      if (finished) {
        const positions = burstGeometry.attributes.position.array as Float32Array;
        const t = reduced ? 0.55 : Math.min(1, (now - revealAt) / (1200 * speed));
        for (let i = 0; i < 80; i++) {
          const angle = i * 2.39996;
          const radius = (0.2 + (i % 9) * 0.1) * t;
          positions.set(
            [
              head.x + Math.cos(angle) * radius,
              head.y + Math.sin(angle) * radius,
              Math.sin(i) * radius,
            ],
            i * 3
          );
        }
        burstGeometry.attributes.position.needsUpdate = true;
      }
      if (!reduced) {
        stars.position.z = (now / 300) % 6;
        orbit.rotation.z = now / 16000;
        grid.position.z = (now / 650) % 2;
      }
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      surface.removeEventListener('webglcontextlost', lost);
      surface.removeEventListener('webglcontextrestored', restored);
      kit.cleanup();
    };
  }, [width, height]);
  return (
    <div className={styles.wrap} data-motion="keep">
      {failed ? (
        <p className="sc-copy">
          The 3D Scene Is Unavailable. Your Live Multiplier And Cash Out Controls Still Work.
        </p>
      ) : null}
      <canvas
        ref={canvas}
        className={styles.canvas}
        style={{ width, height, display: failed ? 'none' : undefined }}
        role="img"
        aria-label="Crash Curve"
      />
    </div>
  );
}
