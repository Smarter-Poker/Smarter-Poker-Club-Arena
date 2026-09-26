/**
 * THE DIAMOND PLINKO CABINET IN THE HOUSE STYLE (mobile spins, phase 4).
 *
 * Crash and Donkey Cross were rebuilt as black glass, chrome hairlines, blue
 * LEDs and gold for money; this is the same language for the Plinko machine:
 *
 *   - a black-glass back panel in a chrome bevel frame, on an obsidian casing;
 *   - a blue LED strip down each side and an LED in each corner, breathing
 *     while the board is idle;
 *   - a lit sign plate across the top that reads DIAMOND PLINKO in chrome;
 *   - a glass sill under the buckets with a blue LED line and a warm gold pool
 *     under every bucket that pays five times the drop or more;
 *   - a soft blue underglow under the whole machine;
 *   - a glow behind every peg, which runs down the rows as a light chase while
 *     the board waits for a drop, and flares on the peg a diamond strikes;
 *   - a glow and a trail of sparkles behind every falling diamond.
 *
 * THE BUDGET. No new real-time light (the halo that used to follow the diamond
 * was a fourth light; its glow is a sprite now). Every glow on the machine is
 * ONE instanced draw of additive quads and every sparkle is one more, so the
 * attract, the flares and the trail cost two draw calls between them. Nothing
 * here allocates a geometry, a material or a texture after it is built, and
 * the two canvas textures are painted once (the title once more when the web
 * font arrives). Every animation is opacity or emissive only, every one is
 * scaled by Animation Speed, and none runs under reduced motion: the pegs and
 * the LEDs then rest lit.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { metal, solid } from '../games/sceneKit';
import { PEG_COUNT, PEG_ROWS, pegCentre } from './plinkoPegField';

/** The slot row's own layout, repeated here so the sill and its pools line up with it. */
const SLOTS = 17;
const slotX = (slot: number) => (slot - 8) * 0.65;

/** How the glows share their one instanced draw. */
const PEG_GLOW = 0;
const BUCKET_GLOW = PEG_GLOW + PEG_COUNT;
const BALL_GLOW = BUCKET_GLOW + SLOTS;
/** The drop diamond and its thirty-two batch companions. */
const BALLS = 33;
const CORNER_GLOW = BALL_GLOW + BALLS;
const GLOWS = CORNER_GLOW + 4;
/** Sparkles alive at once, across every diamond in flight. */
const SPARKS = 96;

/** The axis a sparkle spins about: the one pointing at the player. */
const FACING = new THREE.Vector3(0, 0, 1);
/** Where the side LED strips and the corner LEDs sit. */
const LED_X = 5.62;
const CORNERS: Array<[number, number]> = [
  [-LED_X, 6.02],
  [LED_X, 6.02],
  [-LED_X, -6.06],
  [LED_X, -6.06],
];

/**
 * A deterministic scatter in [0, 1) for the n-th sparkle. The trail must look
 * random without calling Math.random (the render-surface law): a hash of a
 * counter is the same every run and costs nothing.
 */
export function sparkleScatter(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function paint(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { canvas, texture };
}

/** A soft round glow: a hot core and a long falloff, white so each instance tints it. */
function glowTexture() {
  return paint(64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.16, 'rgba(255,255,255,0.62)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.18)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
  }).texture;
}

/** A four-point sparkle: a bright core with two thin crossed rays. */
function sparkTexture() {
  return paint(64, 64, (ctx) => {
    const core = ctx.createRadialGradient(32, 32, 0, 32, 32, 14);
    core.addColorStop(0, 'rgba(255,255,255,1)');
    core.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, 64, 64);
    for (const vertical of [false, true]) {
      const ray = vertical
        ? ctx.createLinearGradient(0, 2, 0, 62)
        : ctx.createLinearGradient(2, 0, 62, 0);
      ray.addColorStop(0, 'rgba(255,255,255,0)');
      ray.addColorStop(0.5, 'rgba(255,255,255,0.95)');
      ray.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = ray;
      if (vertical) ctx.fillRect(30.5, 2, 3, 60);
      else ctx.fillRect(2, 30.5, 60, 3);
    }
  }).texture;
}

/**
 * The sign plate's lettering: DIAMOND PLINKO in chrome (a white-to-steel
 * gradient with a dark engraving line and a blue LED bloom behind it), flanked
 * by two light-blue diamonds. Painted onto a transparent canvas so the black
 * glass of the plate is what shows between the letters.
 */
function paintTitle(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2 + 4;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '800 92px "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
  if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = '6px';
  const text = 'DIAMOND PLINKO';
  // The LED bloom behind the lettering.
  ctx.save();
  ctx.shadowColor = 'rgba(24,119,242,0.95)';
  ctx.shadowBlur = 26;
  ctx.fillStyle = 'rgba(69,173,255,0.55)';
  ctx.fillText(text, width / 2, mid, width - 190);
  ctx.restore();
  // The engraving line, then the chrome face.
  ctx.lineJoin = 'round';
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#050607';
  ctx.strokeText(text, width / 2, mid, width - 190);
  const chrome = ctx.createLinearGradient(0, mid - 46, 0, mid + 46);
  chrome.addColorStop(0, '#ffffff');
  chrome.addColorStop(0.42, '#dfe5ec');
  chrome.addColorStop(0.5, '#8d99a8');
  chrome.addColorStop(0.62, '#c3ccd6');
  chrome.addColorStop(1, '#f4f7fb');
  ctx.fillStyle = chrome;
  ctx.fillText(text, width / 2, mid, width - 190);
  // A diamond at each end, in the light blue of the LEDs.
  for (const x of [52, width - 52]) {
    ctx.save();
    ctx.translate(x, mid);
    ctx.shadowColor = 'rgba(69,173,255,0.9)';
    ctx.shadowBlur = 16;
    const facet = ctx.createLinearGradient(-22, -30, 22, 30);
    facet.addColorStop(0, '#f4f7fb');
    facet.addColorStop(0.45, '#45adff');
    facet.addColorStop(1, '#1877f2');
    ctx.fillStyle = facet;
    ctx.beginPath();
    ctx.moveTo(0, -30);
    ctx.lineTo(22, -6);
    ctx.lineTo(0, 30);
    ctx.lineTo(-22, -6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

/** Everything the cabinet reads off one frame of the board. */
export interface CabinetFrame {
  /** The frame clock, in real milliseconds. */
  now: number;
  /** The player's Animation Speed, a duration multiplier. */
  speed: number;
  reduced: boolean;
  /** No diamond is in flight: the attract may run. */
  idle: boolean;
  /** Peg indices a diamond is striking this frame. */
  struck: readonly number[];
  /** Every diamond mesh; a visible one carries a glow. */
  balls: readonly THREE.Object3D[];
  /** How many of `balls`, from the start, are falling and leave a trail. */
  flying: number;
  /** The big-win pulse is up: the glows go gold. */
  pulsing: boolean;
}

/**
 * Build the cabinet around the board's own pegs and slots. `slots` are the
 * board's bucket meshes: their chrome rims are drawn instanced and follow each
 * bucket's squash every frame.
 */
export function plinkoCabinet(scene: THREE.Scene, slots: readonly THREE.Mesh[]) {
  const chrome = metal(0xd4dce6, 0.12);
  chrome.envMapIntensity = 1.5;
  const obsidian = metal(0x0b0f15, 0.42);
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x04070b,
    metalness: 0.15,
    roughness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: 0.4,
  });

  // THE CASING, THE GLASS AND THE CHROME BEVEL.
  solid(scene, obsidian, [12.5, 13.5, 0.5], [0, 0, -0.5], 0.3);
  solid(scene, glass, [11.5, 12.6, 0.14], [0, 0, -0.1], 0.05);
  for (const x of [-5.88, 5.88]) solid(scene, chrome, [0.34, 13.18, 0.44], [x, 0, 0.02], 0.12);
  for (const y of [-6.42, 6.42]) solid(scene, chrome, [12.1, 0.34, 0.44], [0, y, 0.02], 0.12);

  // THE SIDE LED STRIPS: an emissive tube each; the bloom is the glow field's.
  const led = new THREE.MeshStandardMaterial({
    color: 0x0a1424,
    emissive: 0x2a86ff,
    emissiveIntensity: 1.1,
    toneMapped: false,
  });
  for (const x of [-LED_X, LED_X]) {
    const strip = solid(scene, led, [0.06, 11.9, 0.06], [x, -0.02, 0.06], 0.02);
    strip.castShadow = false;
  }
  for (const [x, y] of CORNERS) {
    const dot = solid(scene, led, [0.14, 0.14, 0.08], [x, y, 0.12], 0.05);
    dot.castShadow = false;
  }

  // THE SIGN PLATE: chrome rim, black glass face, chrome lettering.
  solid(scene, chrome, [5.9, 0.9, 0.16], [0, 5.8, 0.02], 0.08);
  solid(scene, glass, [5.7, 0.74, 0.16], [0, 5.8, 0.07], 0.05);
  const title = paint(1024, 136, (ctx) => paintTitle(ctx, 1024, 136));
  const titleMaterial = new THREE.MeshBasicMaterial({
    map: title.texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const titlePlate = new THREE.Mesh(new THREE.PlaneGeometry(5.56, 0.74), titleMaterial);
  titlePlate.name = 'Plinko Title Plate';
  titlePlate.position.set(0, 5.8, 0.16);
  scene.add(titlePlate);
  let disposed = false;
  // The lettering is painted with the web font once it has arrived. One repaint,
  // never a per-frame one.
  const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
  fonts?.ready
    ?.then(() => {
      if (disposed) return;
      const ctx = title.canvas.getContext('2d');
      if (!ctx) return;
      paintTitle(ctx, 1024, 136);
      title.texture.needsUpdate = true;
    })
    .catch(() => {});

  // THE SILL: a chrome rail under the buckets, a blue LED line, black glass.
  solid(scene, chrome, [11.3, 0.08, 0.26], [0, -5.26, 0.06], 0.03);
  solid(scene, glass, [11.3, 0.92, 0.18], [0, -5.76, 0.0], 0.04);
  const sillLed = solid(scene, led, [10.9, 0.035, 0.035], [0, -5.4, 0.1], 0.012);
  sillLed.castShadow = false;

  // THE BUCKET RIMS: one chrome bezel a bucket, drawn instanced behind each
  // plate so only its edge shows, and moved with the plate when it squashes.
  const rimGeometry = new RoundedBoxGeometry(0.64, 1.04, 0.2, 2, 0.05);
  rimGeometry.translate(0, -0.09, 0);
  const rims = new THREE.InstancedMesh(rimGeometry, chrome, SLOTS);
  rims.name = 'Plinko Bucket Rims';
  rims.receiveShadow = true;
  rims.frustumCulled = false;
  scene.add(rims);

  // THE GLOW FIELD: every soft light on the machine, one additive draw.
  const glowMaterial = new THREE.MeshBasicMaterial({
    map: glowTexture(),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const glows = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), glowMaterial, GLOWS);
  glows.name = 'Plinko Glow Field';
  glows.frustumCulled = false;
  glows.renderOrder = 2;
  scene.add(glows);
  const scratch = new THREE.Matrix4();
  const at = new THREE.Vector3();
  const size = new THREE.Vector3(1, 1, 1);
  const turn = new THREE.Quaternion();
  const place = (
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h = w
  ) => {
    at.set(x, y, z);
    size.set(w, h, 1);
    turn.identity();
    mesh.setMatrixAt(index, scratch.compose(at, turn, size));
  };
  const pegRow = new Uint8Array(PEG_COUNT);
  for (let row = 0, index = 0; row < PEG_ROWS; row++)
    for (let col = 0; col <= row; col++, index++) {
      const [x, y] = pegCentre(row, col);
      pegRow[index] = row;
      place(glows, PEG_GLOW + index, x, y, 0.0, 0.66);
    }
  for (let i = 0; i < SLOTS; i++) place(glows, BUCKET_GLOW + i, slotX(i), -5.46, 0.2, 1.4, 0.8);
  for (let i = 0; i < BALLS; i++) place(glows, BALL_GLOW + i, 0, 0, 0, 0);
  CORNERS.forEach(([x, y], i) => place(glows, CORNER_GLOW + i, x, y, 0.2, 0.9));
  const tint = new THREE.Color();
  const flashTint = new THREE.Color();
  for (let i = 0; i < GLOWS; i++) glows.setColorAt(i, tint.setRGB(0, 0, 0));

  // The big washes: the blue behind the peg field, the two LED blooms down the
  // sides, and the underglow beneath the machine. Each is one quad of the same
  // soft texture with its own opacity, so the breathing is opacity only.
  const wash = (color: number, opacity: number) =>
    new THREE.MeshBasicMaterial({
      map: glowMaterial.map,
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
  const backdropMaterial = wash(0x1877f2, 0.2);
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backdropMaterial);
  backdrop.scale.set(11.5, 10.5, 1);
  backdrop.position.set(0, 0.7, -0.02);
  scene.add(backdrop);
  const bloomMaterial = wash(0x1877f2, 0.6);
  for (const x of [-LED_X, LED_X]) {
    const bloom = new THREE.Mesh(backdrop.geometry, bloomMaterial);
    bloom.scale.set(1.1, 14.5, 1);
    bloom.position.set(x, 0, 0.1);
    bloom.renderOrder = 2;
    scene.add(bloom);
  }
  const underglowMaterial = wash(0x1877f2, 0.5);
  const underglow = new THREE.Mesh(backdrop.geometry, underglowMaterial);
  underglow.scale.set(13.5, 1.7, 1);
  underglow.position.set(0, -6.72, 0.36);
  underglow.renderOrder = 2;
  scene.add(underglow);

  // THE SPARKLE TRAIL: a ring of sparkles shared by every falling diamond.
  const sparks = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: sparkTexture(),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
    SPARKS
  );
  sparks.name = 'Plinko Sparkle Trail';
  sparks.frustumCulled = false;
  sparks.renderOrder = 3;
  scene.add(sparks);
  const sparkX = new Float32Array(SPARKS),
    sparkY = new Float32Array(SPARKS),
    sparkZ = new Float32Array(SPARKS),
    sparkBorn = new Float32Array(SPARKS).fill(-1e9),
    sparkSize = new Float32Array(SPARKS),
    sparkSpin = new Float32Array(SPARKS);
  for (let i = 0; i < SPARKS; i++) {
    place(sparks, i, 0, 0, 0, 0);
    sparks.setColorAt(i, tint.setRGB(0, 0, 0));
  }
  let sparkCursor = 0,
    sparkSerial = 0,
    sparksAlive = true;

  // Per-bucket state the board hands over: its tint, whether it pays 5x, and
  // how hard it is flashing this frame.
  const bucketTints = Array.from({ length: SLOTS }, () => new THREE.Color(0x1877f2));
  const bucketBig = new Array<boolean>(SLOTS).fill(false);
  const bucketFlash = new Float32Array(SLOTS);
  /** When each peg was last struck, on the cabinet clock. */
  const pegStruck = new Float32Array(PEG_COUNT).fill(-1e9);

  const LIGHT_BLUE = new THREE.Color(0x45adff);
  const ICE = new THREE.Color(0xbfe6ff);
  const GOLD = new THREE.Color(0xffd700);
  const WARM = new THREE.Color(0xffb300);

  let last = -1,
    clock = 0,
    attract = 0,
    idleMix = 1;

  return {
    /** The buckets' own colours, read when the table is painted. */
    paintBuckets(tints: readonly THREE.Color[], big: readonly boolean[]) {
      for (let i = 0; i < SLOTS; i++) {
        if (tints[i]) bucketTints[i].copy(tints[i]);
        bucketBig[i] = !!big[i];
      }
    },
    /** How brightly a bucket is flashing this frame, 0 to 1. */
    flashBucket(slot: number, level: number) {
      if (slot >= 0 && slot < SLOTS) bucketFlash[slot] = level;
    },
    frame(f: CabinetFrame) {
      const dt = last < 0 ? 0 : Math.max(0, Math.min(120, f.now - last));
      last = f.now;
      clock += dt;
      // The attract eases in and out rather than snapping when a drop starts.
      const ease = Math.min(1, dt / (380 * f.speed));
      idleMix += ((f.idle ? 1 : 0) - idleMix) * ease;
      if (!f.reduced && f.idle) attract += dt / f.speed;
      const still = f.reduced;
      // THE LEDS BREATHE: 2.4 s a breath at normal speed, as the Crash corners do.
      const breath = still ? 0.8 : 0.5 + 0.5 * Math.sin((attract / 2400) * Math.PI * 2);
      const ledLevel = still ? 0.85 : 0.85 * (1 - idleMix) + (0.45 + 0.55 * breath) * idleMix;
      led.emissiveIntensity = 0.9 + 0.9 * ledLevel;
      bloomMaterial.opacity = 0.22 + 0.5 * ledLevel;
      backdropMaterial.opacity = 0.16 + 0.08 * ledLevel;
      underglowMaterial.opacity = 0.34 + 0.3 * ledLevel;

      // THE PEG CHASE: a band of light runs down the rows, one row every 90 ms,
      // then rests; a struck peg flares and fades over 320 ms.
      for (const index of f.struck) if (index >= 0 && index < PEG_COUNT) pegStruck[index] = clock;
      const period = 2700;
      const head = (attract % period) / 90 - 2;
      const flareSpan = 320 * f.speed;
      for (let i = 0; i < PEG_COUNT; i++) {
        let level: number;
        if (still) level = 0.42;
        else {
          const d = pegRow[i] - head;
          const band = Math.exp(-(d * d) / 1.3);
          level = 0.1 + (0.12 + 0.78 * band) * idleMix * (0.75 + 0.25 * breath);
        }
        const age = clock - pegStruck[i];
        if (age >= 0 && age < flareSpan) level += 1.1 * (1 - age / flareSpan);
        tint.copy(level > 0.9 ? ICE : LIGHT_BLUE).multiplyScalar(Math.min(1.6, level));
        glows.setColorAt(PEG_GLOW + i, tint);
      }
      // THE BUCKET POOLS: every 5x-or-better bucket keeps a warm gold pool on
      // the sill; a landing throws its own colour into the pool for the flash.
      for (let i = 0; i < SLOTS; i++) {
        const flash = bucketFlash[i];
        if (bucketBig[i])
          tint
            .copy(WARM)
            .lerp(GOLD, 0.5)
            .multiplyScalar(0.36 + 0.1 * breath);
        else tint.setRGB(0, 0, 0);
        if (flash > 0)
          tint.add(
            flashTint.copy(bucketBig[i] ? GOLD : bucketTints[i]).multiplyScalar(1.2 * flash)
          );
        glows.setColorAt(BUCKET_GLOW + i, tint);
      }
      // THE DIAMOND GLOWS (the old point light, as a sprite).
      for (let i = 0; i < BALLS; i++) {
        const ball = f.balls[i];
        if (ball && ball.visible) {
          place(
            glows,
            BALL_GLOW + i,
            ball.position.x,
            ball.position.y,
            ball.position.z - 0.12,
            1.5
          );
          tint.copy(f.pulsing ? GOLD : LIGHT_BLUE).multiplyScalar(f.pulsing ? 0.85 : 0.55);
        } else {
          place(glows, BALL_GLOW + i, 0, 0, 0, 0);
          tint.setRGB(0, 0, 0);
        }
        glows.setColorAt(BALL_GLOW + i, tint);
      }
      for (let i = 0; i < 4; i++)
        glows.setColorAt(
          CORNER_GLOW + i,
          tint.copy(LIGHT_BLUE).multiplyScalar(0.35 + 0.65 * ledLevel)
        );
      glows.instanceMatrix.needsUpdate = true;
      if (glows.instanceColor) glows.instanceColor.needsUpdate = true;

      // THE RIMS FOLLOW THEIR PLATES.
      for (let i = 0; i < SLOTS && i < slots.length; i++) {
        const plate = slots[i];
        at.set(plate.position.x, plate.position.y, plate.position.z - 0.05);
        size.copy(plate.scale);
        turn.identity();
        rims.setMatrixAt(i, scratch.compose(at, turn, size));
      }
      rims.instanceMatrix.needsUpdate = true;

      // THE SPARKLE TRAIL. None under reduced motion: the diamond does not travel.
      if (!still) {
        for (let i = 0; i < f.flying && i < f.balls.length; i++) {
          const ball = f.balls[i];
          if (!ball.visible) continue;
          const n = sparkSerial++;
          const k = sparkCursor;
          sparkCursor = (sparkCursor + 1) % SPARKS;
          sparkX[k] = ball.position.x + (sparkleScatter(n) - 0.5) * 0.34;
          sparkY[k] = ball.position.y + (sparkleScatter(n + 0.5) - 0.3) * 0.3;
          sparkZ[k] = ball.position.z + 0.08;
          sparkBorn[k] = clock;
          sparkSize[k] = 0.2 + sparkleScatter(n + 0.25) * 0.22;
          sparkSpin[k] = sparkleScatter(n + 0.75) * Math.PI;
          sparksAlive = true;
        }
      }
      if (sparksAlive) {
        const life = 520 * f.speed;
        let alive = false;
        for (let k = 0; k < SPARKS; k++) {
          const age = (clock - sparkBorn[k]) / life;
          if (age < 0 || age >= 1) {
            place(sparks, k, 0, 0, 0, 0);
            sparks.setColorAt(k, tint.setRGB(0, 0, 0));
            continue;
          }
          alive = true;
          const fade = (1 - age) * (1 - age);
          const twinkle = 0.7 + 0.3 * Math.sin(age * 18 + sparkSpin[k] * 4);
          const w = sparkSize[k] * (0.55 + 0.45 * (1 - age)) * twinkle;
          at.set(sparkX[k], sparkY[k] - age * 0.18, sparkZ[k]);
          size.set(w, w, 1);
          turn.setFromAxisAngle(FACING, sparkSpin[k] + age);
          sparks.setMatrixAt(k, scratch.compose(at, turn, size));
          sparks.setColorAt(
            k,
            tint
              .copy(ICE)
              .lerp(LIGHT_BLUE, age)
              .multiplyScalar(1.3 * fade)
          );
        }
        sparks.instanceMatrix.needsUpdate = true;
        if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;
        sparksAlive = alive;
      }
    },
    dispose() {
      disposed = true;
      rims.dispose();
      glows.dispose();
      sparks.dispose();
    },
  };
}
