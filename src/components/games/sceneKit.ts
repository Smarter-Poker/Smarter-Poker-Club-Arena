import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { gpuFrameRenderer } from './gpuFrameRenderer';
import { isSoftwareRenderer } from './rendererTier';
import {
  createQualityGovernor,
  FLOOR_TIER,
  type QualityTier,
  type QualityGovernor,
} from './qualityGovernor';

/** How long a scene waits for compileAsync before drawing anyway. */
export const COMPILE_WAIT_MS = 1500;

/**
 * Put a quality tier on a renderer: the pixel ratio (never above the device's
 * own), the shadow maps, and a re-link of every material so a shadow-map change
 * takes effect (three only re-reads shadowMap.enabled when a program is built).
 * Returns true when the programs were marked for a re-link, so the caller can
 * compile them ahead of the next frame (warmUp) instead of stalling inside it.
 */
export function applyQualityTier(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  tier: QualityTier,
  width: number,
  height: number
): boolean {
  const device = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  renderer.setPixelRatio(Math.min(device, tier.ratio));
  renderer.setSize(width, height, false);
  if (renderer.shadowMap.enabled !== tier.shadows) {
    renderer.shadowMap.enabled = tier.shadows;
    scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        for (const m of Array.isArray(object.material) ? object.material : [object.material])
          m.needsUpdate = true;
      }
    });
    return true;
  }
  return false;
}

/**
 * Compile the scene's programs off the first frame. Calls onReady when the
 * driver has linked them, and after COMPILE_WAIT_MS regardless, so a driver
 * that will not compile ahead of time still draws (it pays in frame one, as
 * before). A renderer without compileAsync is ready at once.
 */
export function warmUp(
  renderer: Partial<Pick<THREE.WebGLRenderer, 'compileAsync'>>,
  scene: THREE.Scene,
  camera: THREE.Camera,
  onReady: () => void
): () => void {
  if (typeof renderer.compileAsync !== 'function') {
    onReady();
    return () => {};
  }
  let done = false;
  const ready = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    onReady();
  };
  const timer = setTimeout(ready, COMPILE_WAIT_MS);
  void renderer.compileAsync(scene, camera).then(ready, ready);
  return () => {
    done = true;
    clearTimeout(timer);
  };
}

export function metal(color: number, roughness = 0.2) {
  return new THREE.MeshPhysicalMaterial({ color, metalness: 0.85, roughness, clearcoat: 0.8 });
}
export function solid(
  parent: THREE.Object3D,
  material: THREE.Material,
  size: [number, number, number],
  position: [number, number, number],
  radius = 0.06
) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(...size, 3, radius), material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}
export function gameRenderer(canvas: HTMLCanvasElement, width: number, height: number) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    // Transparent until the first frame, so the CSS placeholder under the
    // canvas shows while the programs compile. The scene's opaque background
    // clears every drawn frame to alpha 1, so a drawn frame looks the same.
    alpha: true,
  });
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  // A CPU rasteriser starts at the floor tier; everything else starts at the
  // tier this session has already found, and steps down from there if the
  // frames say so (qualityGovernor.ts). Every element stays; only resolution
  // and shadows move.
  const software = isSoftwareRenderer(
    typeof renderer.getContext === 'function' ? renderer.getContext() : null
  );
  let size = { width, height };
  // Frames are held until the programs are linked: first when the caller
  // draws for the first time (its scene is dressed by then, so every program
  // it will use compiles), and again after a tier that turns shadows off,
  // which re-links every material on exactly the device that was too slow.
  let compiled = false;
  let warming = false;
  let stopWarmUp = () => {};
  const startWarmUp = () => {
    stopWarmUp();
    compiled = false;
    warming = true;
    stopWarmUp = warmUp(renderer, scene, camera, () => {
      compiled = true;
    });
  };
  const governor: QualityGovernor = createQualityGovernor({
    intervalMs: 30,
    start: software ? FLOOR_TIER : undefined,
    apply: (tier) => {
      const relinked = applyQualityTier(renderer, scene, tier, size.width, size.height);
      if (relinked && warming) startWarmUp();
    },
  });
  scene.background = new THREE.Color(0x070b10);
  const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 150);
  const generator = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = generator.fromScene(room, 0.04);
  scene.environment = environment.texture;
  room.dispose();
  generator.dispose();
  scene.add(new THREE.HemisphereLight(0xc9e6ff, 0x090d16, 0.75));
  const key = new THREE.DirectionalLight(0xffffff, 3);
  key.position.set(-5, 8, 8);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.001;
  scene.add(key);
  const blue = new THREE.DirectionalLight(0x1877f2, 3);
  blue.position.set(6, -2, 4);
  scene.add(blue);
  const frames = gpuFrameRenderer(renderer, scene, camera);
  // No frame is submitted until the programs are linked (or the wait runs
  // out), so the first frame a phone shows is a drawn one, not a compile stall.
  return {
    renderer,
    scene,
    camera,
    /** Resize the canvas, keeping the governor's pixel ratio. */
    setSize(nextWidth: number, nextHeight: number) {
      size = { width: nextWidth, height: nextHeight };
      renderer.setSize(nextWidth, nextHeight, false);
    },
    /**
     * Draw one frame. intervalMs is the throttle the caller's loop is running
     * at right now (a reduced-motion loop draws far less often), so the
     * governor judges the frame against the pace it was asked for.
     */
    render(intervalMs?: number) {
      if (!warming) startWarmUp();
      if (!compiled) return false;
      const submitted = frames.render();
      governor.frame(performance.now(), submitted, intervalMs);
      return submitted;
    },
    cleanup() {
      stopWarmUp();
      frames.dispose();
      const geometries = new Set<THREE.BufferGeometry>(),
        materials = new Set<THREE.Material>(),
        textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        if (
          object instanceof THREE.Mesh ||
          object instanceof THREE.Points ||
          object instanceof THREE.Line
        ) {
          geometries.add(object.geometry);
          for (const m of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(m);
            if ('map' in m && m.map instanceof THREE.Texture) textures.add(m.map);
          }
        }
      });
      geometries.forEach((g) => g.dispose());
      materials.forEach((m) => m.dispose());
      textures.forEach((t) => t.dispose());
      environment.dispose();
      key.shadow.map?.dispose();
      renderer.dispose();
    },
  };
}

export function inscription(text: string, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#101a29';
    ctx.fillRect(0, 0, 256, 96);
    ctx.font = '700 54px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(text, 128, 50, 238);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
