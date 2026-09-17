import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { gpuFrameRenderer } from './gpuFrameRenderer';

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
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
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
  return {
    renderer,
    scene,
    camera,
    render: frames.render,
    cleanup() {
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
