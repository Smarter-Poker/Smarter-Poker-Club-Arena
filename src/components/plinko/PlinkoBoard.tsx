/** A physical Plinko cabinet. The server supplies every turn of the ball. */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { gameRenderer, inscription, metal, solid } from '../games/sceneKit';
import { plinkoPegField } from './plinkoPegField';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import { reportError } from '../../utils/errorReporter';
import styles from './PlinkoBoard.module.css';
export const PLINKO_ROWS = 16;
export interface PlinkoBoardProps {
  multipliersCents: number[];
  tableMultipliersCents?: number[];
  path: number[] | null;
  dropKey: number;
  batchPathBits?: number[] | null;
  onProgress?: (landed: number) => void;
  restingSlot: number | null;
  onLanded?: () => void;
  width?: number;
}
export default function PlinkoBoard(props: PlinkoBoardProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const width = props.width ?? 360;
  const height = Math.round(width * 1.13);
  const initialSize = useRef({ width, height });
  const sceneRef = useRef<ReturnType<typeof gameRenderer> | null>(null);
  useEffect(() => {
    if (!canvas.current) return;
    let kit: ReturnType<typeof gameRenderer>;
    try {
      kit = gameRenderer(canvas.current, initialSize.current.width, initialSize.current.height);
      sceneRef.current = kit;
      setFailed(false);
    } catch (error) {
      setFailed(true);
      reportError(error, 'PlinkoBoard.renderer');
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
    camera.position.set(0, 2.6, 19.9);
    camera.lookAt(0, -0.1, 0);
    const steel = metal(0xa8b4c2),
      blue = metal(0x1877f2),
      dark = metal(0x101820, 0.38);
    solid(scene, steel, [12, 13, 0.6], [0, 0, -0.45], 0.3);
    solid(scene, dark, [11.6, 12.6, 0.18], [0, 0, -0.08], 0.2);
    const glow = new THREE.MeshStandardMaterial({
      color: 0x1877f2,
      emissive: 0x1877f2,
      emissiveIntensity: 2,
    });
    solid(scene, glow, [0.06, 11.8, 0.06], [-5.56, 0, 0.07], 0.02);
    solid(scene, glow, [0.06, 11.8, 0.06], [5.56, 0, 0.07], 0.02);
    // Two instanced draw calls preserve every physical peg and its blue contact
    // light, without 136 separate material/shadow submissions on small devices.
    const pegs = plinkoPegField(steel);
    scene.add(pegs.group);
    const slots: THREE.Mesh[] = [];
    const labels: THREE.Mesh[] = [];
    for (let i = 0; i < 17; i++) {
      const x = (i - 8) * 0.65;
      const slot = solid(
        scene,
        i === 8 ? dark.clone() : blue.clone(),
        [0.61, 0.82, 0.28],
        [x, -4.55, 0.08],
        0.07
      );
      slots.push(slot);
      const label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.57, 0.24),
        new THREE.MeshBasicMaterial({ map: inscription('') })
      );
      label.position.set(x, -4.48, 0.235);
      scene.add(label);
      labels.push(label);
    }
    solid(scene, steel, [10.95, 0.12, 0.25], [0, -5.06, 0.1], 0.04);
    const title = new THREE.Mesh(
      new THREE.PlaneGeometry(5.1, 0.67),
      new THREE.MeshBasicMaterial({ map: inscription('DIAMOND PLINKO', '#8bd6ff') })
    );
    title.position.set(0, 5.65, 0.04);
    scene.add(title);
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.205, 24, 16),
      new THREE.MeshPhysicalMaterial({
        color: 0xf5fbff,
        metalness: 0.7,
        roughness: 0.08,
        clearcoat: 1,
      })
    );
    ball.castShadow = true;
    scene.add(ball);
    const batchBalls = Array.from({ length: 32 }, () => {
      const mesh = new THREE.Mesh(ball.geometry, ball.material);
      mesh.castShadow = true;
      mesh.visible = false;
      scene.add(mesh);
      return mesh;
    });
    let reported = -1;
    const halo = new THREE.PointLight(0x39b6ff, 3, 2);
    scene.add(halo);
    let raf = 0,
      last = 0,
      key = -1,
      start = 0,
      duration = 0,
      landed = true,
      pendingLanding = false,
      pendingProgress: number | null = null,
      labelKey = '';
    const reduced = prefersReducedMotion();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced ? 150 : 30)) return;
      last = now;
      const p = latest.current;
      const nextLabel = p.multipliersCents.join(',');
      if (labelKey !== nextLabel) {
        labelKey = nextLabel;
        labels.forEach((label, i) => {
          const m = label.material as THREE.MeshBasicMaterial;
          m.map?.dispose();
          m.map = inscription(
            multiplierLabel(p.multipliersCents[i] ?? 0),
            i === 8 ? '#8797a8' : '#ffffff'
          );
          m.needsUpdate = true;
        });
      }
      if ((p.path || p.batchPathBits?.length) && key !== p.dropKey) {
        key = p.dropKey;
        start = now;
        duration = 16 * 118 * getAnimationSpeed();
        landed = false;
        pendingLanding = false;
        pendingProgress = null;
        reported = -1;
        pegs.reveal([], -1);
      }
      ball.visible = !p.batchPathBits?.length;
      batchBalls.forEach((mesh) => {
        mesh.visible = false;
      });
      if (p.batchPathBits?.length && !landed) {
        const gap = 70 * getAnimationSpeed();
        const elapsed = reduced ? duration + gap * p.batchPathBits.length : now - start;
        const finished = Math.max(
          0,
          Math.min(p.batchPathBits.length, Math.floor((elapsed - duration) / gap) + 1)
        );
        const newest = Math.min(p.batchPathBits.length - 1, Math.floor(elapsed / gap));
        for (let j = 0; j < 32; j++) {
          const index = newest - j;
          if (index < finished || index < 0) continue;
          const progress = Math.min(16, ((elapsed - index * gap) / duration) * 16);
          if (progress < 0 || progress >= 16) continue;
          const row = Math.min(15, Math.floor(progress)),
            t = progress - row;
          const bits = p.batchPathBits[index];
          let rights = 0;
          for (let k = 0; k < row; k++) rights += (bits >> k) & 1;
          const mesh = batchBalls[j];
          mesh.visible = true;
          mesh.position.set(
            (rights - row / 2) * 0.65 + ((bits >> row) & 1 ? 1 : -1) * 0.325 * t,
            4.95 - progress * 0.55 + Math.sin(t * Math.PI) * 0.17,
            0.46
          );
        }
        if (reported !== finished) {
          reported = finished;
          pendingProgress = finished;
        }
        if (finished === p.batchPathBits.length) {
          landed = true;
          pendingLanding = true;
        }
      } else if (p.path && !landed) {
        const progress = reduced ? 16 : Math.min(16, ((now - start) / duration) * 16);
        const row = Math.min(15, Math.floor(progress));
        const t = progress - row;
        const rights = p.path.slice(0, row).reduce((a, b) => a + b, 0);
        const x = (rights - row / 2) * 0.65;
        const dx = (p.path[row] === 1 ? 1 : -1) * 0.325;
        ball.position.set(x + dx * t, 4.95 - progress * 0.55 + Math.sin(t * Math.PI) * 0.17, 0.46);
        pegs.reveal(p.path, row);
        if (progress >= 16) {
          landed = true;
          const slot = p.path.reduce((a, b) => a + b, 0);
          ball.position.set((slot - 8) * 0.65, -4.01, 0.4);
          pendingLanding = true;
        }
      } else if (pendingLanding && p.path) {
        const slot = p.path.reduce((a, b) => a + b, 0);
        ball.position.set((slot - 8) * 0.65, -4.01, 0.4);
      } else if (p.restingSlot !== null) {
        ball.position.set((p.restingSlot - 8) * 0.65, -4.01, 0.4);
      } else {
        ball.position.set(0, 5.04 + (reduced ? 0 : Math.sin(now / 650) * 0.055), 0.4);
      }
      slots.forEach((slot, i) => {
        const m = slot.material as THREE.MeshPhysicalMaterial;
        m.emissive.setHex(i === p.restingSlot ? 0x1877f2 : 0);
        m.emissiveIntensity = i === p.restingSlot ? 1.1 : 0;
      });
      halo.position.copy(ball.position);
      if (kit.render()) {
        if (pendingProgress !== null) {
          p.onProgress?.(pendingProgress);
          pendingProgress = null;
        }
        if (pendingLanding) {
          pendingLanding = false;
          p.onLanded?.();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      surface.removeEventListener('webglcontextlost', lost);
      surface.removeEventListener('webglcontextrestored', restored);
      sceneRef.current = null;
      pegs.dispose();
      kit.cleanup();
    };
  }, []);
  // A measured viewport change resizes the existing GPU resources. Rebuilding
  // the room and every shader on the first ResizeObserver event stalled touch
  // controls on software-rendered and resource-constrained browsers.
  useEffect(() => {
    const kit = sceneRef.current;
    if (!kit) return;
    kit.camera.aspect = width / height;
    kit.camera.updateProjectionMatrix();
    kit.renderer.setSize(width, height, false);
  }, [width, height]);
  return (
    <div className={styles.board} data-motion="keep">
      {failed ? (
        <p className="sc-copy">
          The 3D Scene Is Unavailable. Use Show Results To See Your Saved Bonus.
        </p>
      ) : null}
      <canvas
        ref={canvas}
        className={styles.canvas}
        style={{ width, height, display: failed ? 'none' : undefined }}
        role="img"
        aria-label="Plinko Board"
      />
    </div>
  );
}
