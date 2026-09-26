/** A physical Plinko cabinet. The server supplies every turn of each diamond. */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';
import { gameRenderer, metal, solid } from '../games/sceneKit';
import { pegIndexAt, plinkoPegField } from './plinkoPegField';
import { plinkoCabinet, type CabinetFrame } from './plinkoCabinet';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { multiplierLabel } from '../../utils/diamondGamesFairness';
import { reportError } from '../../utils/errorReporter';
import { PLINKO_PEG_GAP_MS, soundService } from '../../services/SoundService';
import styles from './PlinkoBoard.module.css';
export const PLINKO_ROWS = 16;
/** Sixteen rows of pegs drop into seventeen buckets. */
export const PLINKO_SLOTS = PLINKO_ROWS + 1;
/**
 * Five times the drop or better. Dan played twenty games without seeing one, so
 * a landing at or above this gets a celebration of its own rather than a number
 * appearing in a list after the fact.
 */
export const BIG_WIN_CENTS = 500;
/** The y the bucket row rests on, so a bounce always settles back to it. */
const SLOT_REST_Y = -4.55;

/**
 * Where a multiplier sits on the board's cool-to-hot scale: 0 for the coldest
 * bucket a player will meet, 1 for the hottest.
 *
 * The scale is ABSOLUTE - anchored on the multiplier itself rather than on the
 * table's own smallest and largest - so it works for the Diamond table, the
 * Super table and any table opened later, and so 20x is the same gold wherever
 * it appears. It also makes the difference between the tables legible: the
 * Super table's 0.52x floor correctly reads warmer than the Diamond table's
 * 0.08x, because it genuinely pays more. Logarithmic, because 0.08x to 0.60x
 * is the same size of step in a player's head as 5x to 20x.
 */
const HEAT_FLOOR_CENTS = 5;
const HEAT_CEILING_CENTS = 2500;
export function bucketHeat(multiplierCents: number): number {
  const cents = Number.isFinite(multiplierCents) ? multiplierCents : 0;
  if (cents <= HEAT_FLOOR_CENTS) return 0;
  if (cents >= HEAT_CEILING_CENTS) return 1;
  return Math.log(cents / HEAT_FLOOR_CENTS) / Math.log(HEAT_CEILING_CENTS / HEAT_FLOOR_CENTS);
}

/**
 * The smarter.poker schema, cold to hot (Dan, 2026-09-21: "the bottom is
 * rainbow colored instead of smarter.poker color schema"): deep navy through
 * royal blue and light blue for the middle buckets, chrome white at the
 * threshold, and gold, the one colour that means money everywhere else on the
 * platform, for the buckets worth chasing. No green, no orange, no red: the
 * loud end reads as gold on black, exactly like a win.
 */
const TINT_RAMP: Array<[heat: number, r: number, g: number, b: number]> = [
  [0, 0x1c, 0x3d, 0x74],
  [0.25, 0x18, 0x77, 0xf2],
  [0.48, 0x45, 0xad, 0xff],
  [0.64, 0x9f, 0xd3, 0xff],
  [0.78, 0xe4, 0xe7, 0xec],
  [0.9, 0xff, 0xd7, 0x00],
  [1, 0xff, 0xb3, 0x00],
];
const channel = (value: number) =>
  Math.round(Math.max(0, Math.min(255, value)))
    .toString(16)
    .padStart(2, '0');

/** The bucket's colour, read straight off its multiplier so value is visible at a glance. */
export function bucketTint(multiplierCents: number): string {
  const heat = bucketHeat(multiplierCents);
  let lower = TINT_RAMP[0];
  let upper = TINT_RAMP[TINT_RAMP.length - 1];
  for (let i = 1; i < TINT_RAMP.length; i++) {
    if (heat <= TINT_RAMP[i][0]) {
      lower = TINT_RAMP[i - 1];
      upper = TINT_RAMP[i];
      break;
    }
  }
  const span = upper[0] - lower[0];
  const t = span <= 0 ? 0 : (heat - lower[0]) / span;
  return `#${channel(lower[1] + (upper[1] - lower[1]) * t)}${channel(
    lower[2] + (upper[2] - lower[2]) * t
  )}${channel(lower[3] + (upper[3] - lower[3]) * t)}`;
}

/** The same tint lifted toward white, so an engraved multiplier stays readable on the slot face. */
export function bucketInk(multiplierCents: number): string {
  const tint = bucketTint(multiplierCents);
  const lifted = (at: number) => Number.parseInt(tint.slice(at, at + 2), 16) * 0.42 + 255 * 0.58;
  return `#${channel(lifted(1))}${channel(lifted(3))}${channel(lifted(5))}`;
}

/** True for a landing worth its own celebration: five times the drop or more. */
export function isBigWin(multiplierCents: number): boolean {
  return Number.isFinite(multiplierCents) && multiplierCents >= BIG_WIN_CENTS;
}

/**
 * The slot a sealed drop lands in. This is the server's own arithmetic,
 * `slot = popcount(path_bits)`, and both the ball's x position and the peg
 * trail are derived from the same bits, so the board can never paint a landing
 * the page would refuse when it verifies the drop.
 */
export function pathBitsSlot(bits: number, rows = PLINKO_ROWS): number {
  let slot = 0;
  for (let i = 0; i < rows; i++) slot += (bits >> i) & 1;
  return slot;
}

/** The sealed drop's turn on each row, one bit a row, lowest bit first. */
export function pathBitsSteps(bits: number, rows = PLINKO_ROWS): number[] {
  return Array.from({ length: rows }, (_, i) => (bits >> i) & 1);
}

/** The running tally a player reads while the ten drops land. */
export function tallyLine(landed: number, total: number, bestCents: number): string {
  if (landed <= 0 || total <= 0) return '';
  const best = bestCents >= 0 ? ` Best ${multiplierLabel(bestCents)}.` : '';
  return `${landed} Of ${total} Landed.${best}`;
}

/** One closed brilliant-cut mesh, shared by every drop and disposed by the scene. */
function dropDiamondGeometry() {
  const positions: number[] = [],
    colors: number[] = [];
  const palette = [0x45adff, 0xe4e7ec, 0x1877f2, 0xf4f7fb].map((value) => new THREE.Color(value));
  const ring = (radius: number, y: number, i: number) =>
    new THREE.Vector3(
      Math.cos((i * Math.PI) / 4) * radius,
      y,
      Math.sin((i * Math.PI) / 4) * radius
    );
  const facet = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color) => {
    for (const vertex of [a, b, c]) {
      positions.push(vertex.x, vertex.y, vertex.z);
      colors.push(color.r, color.g, color.b);
    }
  };
  for (let i = 0; i < 8; i++) {
    const table = ring(0.13, 0.16, i),
      tableNext = ring(0.13, 0.16, i + 1),
      rim = ring(0.27, 0.035, i),
      rimNext = ring(0.27, 0.035, i + 1),
      base = ring(0.255, -0.005, i),
      baseNext = ring(0.255, -0.005, i + 1);
    facet(new THREE.Vector3(0, 0.16, 0), tableNext, table, palette[1]);
    facet(table, tableNext, rim, palette[i % 4]);
    facet(tableNext, rimNext, rim, palette[(i + 1) % 4]);
    facet(rim, rimNext, base, palette[0]);
    facet(rimNext, baseNext, base, palette[0]);
    facet(base, baseNext, new THREE.Vector3(0, -0.29, 0), palette[(i + 2) % 4]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.name = 'Brilliant Cut Diamond';
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The bucket's sign plate, engraved: the multiplier in the bucket's own ink
 * (its tint lifted toward white), lit from behind in the tint itself, on a
 * transparent face so the black glass of the plate and its flash show through.
 * The same scale as the legend printed under the board, so the physical board
 * and the list can never disagree about which bucket is hot.
 */
function payoutInscription(multiplier: number) {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 272;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const tint = bucketTint(multiplier);
    const big = isBigWin(multiplier);
    // The glass sheen across the top of the plate.
    const sheen = ctx.createLinearGradient(0, 0, 0, 120);
    sheen.addColorStop(0, 'rgba(244,247,251,0.16)');
    sheen.addColorStop(1, 'rgba(244,247,251,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(6, 6, 148, 120);
    // A hairline in the tint just inside the chrome, the plate's own LED edge.
    ctx.strokeStyle = tint;
    ctx.globalAlpha = big ? 0.85 : 0.55;
    ctx.lineWidth = 3;
    ctx.strokeRect(9, 9, 142, 254);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const value = multiplierLabel(multiplier).slice(0, -1);
    ctx.font = '800 112px "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
    // The backlight: the numeral glows in the bucket's colour.
    ctx.save();
    ctx.shadowColor = tint;
    ctx.shadowBlur = big ? 30 : 18;
    ctx.fillStyle = tint;
    ctx.fillText(value, 80, 104, 140);
    ctx.restore();
    ctx.strokeStyle = '#050607';
    ctx.lineWidth = 9;
    ctx.strokeText(value, 80, 104, 140);
    ctx.fillStyle = bucketInk(multiplier);
    ctx.fillText(value, 80, 104, 140);
    ctx.font = '800 84px "Roboto Condensed", "Arial Narrow", Arial, sans-serif';
    ctx.strokeText('x', 80, 206);
    ctx.fillStyle = tint;
    ctx.fillText('x', 80, 206);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

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
  const tally = useRef<HTMLParagraphElement>(null);
  const [failed, setFailed] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const width = props.width ?? 360;
  const height = Math.round(width * 1.13);
  const initialSize = useRef({ width, height });
  const sceneRef = useRef<ReturnType<typeof gameRenderer> | null>(null);
  /** The last landing reported, by dropKey and how many balls it covered,
   * whichever path reported it. The count matters because the player releases
   * a batch a ball at a time (R6): each release is its own landing. */
  const landedKey = useRef<{ key: number; count: number } | null>(null);
  // A drop the scene cannot draw lands at once (2026-09-22). Its result is
  // already booked; only the picture is missing. Without this a renderer that
  // could not start, or a context lost mid-drop, never drew the frame that
  // reports the landing, and the page waiting on it held every exit until the
  // player pressed Show Results. CrashCurve settles an undrawable round the
  // same way.
  useEffect(() => {
    const p = latest.current;
    const count = p.batchPathBits?.length ?? 0;
    if (!failed || (!count && !p.path)) return;
    if (landedKey.current?.key === p.dropKey && landedKey.current.count === count) return;
    const from = landedKey.current?.key === p.dropKey ? landedKey.current.count : 0;
    landedKey.current = { key: p.dropKey, count };
    // The landing is still heard and felt without a picture: one clink (and
    // its buzz, the jackpot buzz on a 5x or better) at the best bucket this
    // report lands, as the drawn board gives one a frame.
    const slots = count
      ? p.batchPathBits!.slice(from).map((bits) => pathBitsSlot(bits))
      : p.path
        ? [p.path.reduce((a, b) => a + b, 0)]
        : [];
    let best = -1;
    for (const slot of slots) best = Math.max(best, p.multipliersCents[slot] ?? 0);
    if (best >= 0) soundService.playPlinkoLanding(best, isBigWin(best));
    if (count) p.onProgress?.(count);
    p.onLanded?.();
  }, [failed, props.batchPathBits, props.path, props.dropKey]);
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
    // Stood back far enough that the whole chrome frame, sign plate included,
    // sits inside the canvas with a margin on a phone.
    camera.position.set(0, 2.5, 20.9);
    camera.lookAt(0, -0.1, 0);
    // Chrome studs: a bright, low-roughness metal so every peg carries a
    // specular highlight on its dome. Two instanced draw calls preserve every
    // physical peg and its blue contact light, without 136 separate
    // material/shadow submissions on small devices.
    const chrome = metal(0xdfe6ee, 0.1);
    chrome.envMapIntensity = 1.6;
    const pegs = plinkoPegField(chrome);
    scene.add(pegs.group);
    const slots: THREE.Mesh[] = [];
    const labels: THREE.Mesh[] = [];
    // Each bucket's own colour, read off its multiplier when the table is painted.
    const tints: THREE.Color[] = [];
    // THE SIGN PLATES. Every bucket is a plate of black glass (tinted a shade
    // toward its own colour) in a chrome bezel, the multiplier engraved on its
    // face. The plate is what flashes on a landing: its emissive is the tint.
    const plateGlass = new THREE.MeshPhysicalMaterial({
      color: 0x0a0f16,
      metalness: 0.2,
      roughness: 0.12,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 0.8,
    });
    // One geometry for all seventeen, hung from the plate's centre so its top
    // stays where the old bucket's was and the plate reaches down to the sill.
    let plateGeometry: ReturnType<typeof solid>['geometry'] | null = null;
    const labelGeometry = new THREE.PlaneGeometry(0.56, 0.95);
    for (let i = 0; i < PLINKO_SLOTS; i++) {
      const x = (i - 8) * 0.65;
      const slot = solid(scene, plateGlass.clone(), [0.6, 1.0, 0.26], [x, SLOT_REST_Y, 0.08], 0.05);
      if (plateGeometry) {
        slot.geometry.dispose();
        slot.geometry = plateGeometry;
      } else {
        slot.geometry.translate(0, -0.09, 0);
        plateGeometry = slot.geometry;
      }
      slot.name = `Plinko Slot ${i + 1}`;
      slots.push(slot);
      tints.push(new THREE.Color(0x1877f2));
      const label = new THREE.Mesh(
        labelGeometry,
        new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false })
      );
      // On the plate's face, so the engraving squashes with the plate it is on.
      label.position.set(0, -0.09, 0.135);
      slot.add(label);
      labels.push(label);
    }
    plateGlass.dispose();
    const cabinet = plinkoCabinet(scene, slots);
    const ball = new THREE.Mesh(
      dropDiamondGeometry(),
      new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        metalness: 0.35,
        roughness: 0.08,
        clearcoat: 1,
        envMapIntensity: 1.8,
        flatShading: true,
      })
    );
    ball.name = 'Plinko Drop Diamond';
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
    /** Every diamond, the single drop first, for the cabinet's glows and trail. */
    const diamonds: THREE.Object3D[] = [ball, ...batchBalls];
    /** The same diamonds, those in flight first; reused every frame. */
    const falling: THREE.Object3D[] = [];
    /** Pegs struck this frame, for the cabinet's flares; reused every frame. */
    const struckNow: number[] = [];
    /** The batch's pegs lit this frame; reused every frame. */
    const batchStruck: number[] = [];
    /** The cabinet's frame description, one object rewritten every frame (no per-frame allocation). */
    const cabinetFrame: CabinetFrame = {
      now: 0,
      speed: 1,
      reduced: false,
      idle: true,
      struck: struckNow,
      balls: falling,
      flying: 0,
      pulsing: false,
    };
    // The win pulse: one ring, parked over whichever bucket just paid 5x or more.
    const winRing = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffd700,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    winRing.name = 'Plinko Win Ring';
    winRing.position.set(0, -4.22, 0.62);
    winRing.visible = false;
    scene.add(winRing);
    const GOLD = new THREE.Color(0xffd700);
    const hitAt = new Array<number>(PLINKO_SLOTS).fill(Number.NEGATIVE_INFINITY);
    const hitBig = new Array<boolean>(PLINKO_SLOTS).fill(false);
    let raf = 0,
      last = 0,
      key = -1,
      visibleElapsed = 0,
      duration = 0,
      landed = true,
      pendingLanding = false,
      pendingProgress: number | null = null,
      labelKey = '',
      ringAt = Number.NEGATIVE_INFINITY,
      ringSlot = 8,
      booked = 0,
      bestCents = -1,
      /** The single drop's last row struck, so each peg ticks once. */
      dropRow = -1,
      /** When the last peg tick sounded, on the frame clock. */
      tickedAt = Number.NEGATIVE_INFINITY,
      /** The best bucket landed on since the last drawn frame, and whether any paid 5x. */
      clinkCents = -1,
      clinkBig = false;
    /** When each ball of the batch was released, in visible milliseconds of the batch. */
    const releaseAt: number[] = [];
    /** The last row each ball of the batch has struck; grows only when a ball is released. */
    const ballRow: number[] = [];
    let lastVisibleFrame: number | null = null;
    const visibilityChanged = () => {
      lastVisibleFrame = null;
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const reduced = prefersReducedMotion();
    /** Book a landing so its bucket can bounce and, on a big win, pulse. */
    const bookLanding = (slot: number, cents: number, at: number) => {
      const index = Math.max(0, Math.min(PLINKO_SLOTS - 1, slot));
      hitAt[index] = at;
      hitBig[index] = isBigWin(cents);
      if (hitBig[index]) {
        ringAt = at;
        ringSlot = index;
      }
      if (cents > bestCents) bestCents = cents;
      // One clink a drawn frame, at the best bucket it shows landing: ten
      // diamonds landing together under reduced motion are one beat, one buzz.
      if (cents > clinkCents) clinkCents = cents;
      if (hitBig[index]) clinkBig = true;
    };
    const writeTally = (count: number, total: number) => {
      if (tally.current) tally.current.textContent = tallyLine(count, total, bestCents);
    };
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (document.hidden || now - last < (reduced ? 150 : 30)) return;
      last = now;
      visibleElapsed += lastVisibleFrame === null ? 0 : now - lastVisibleFrame;
      lastVisibleFrame = now;
      const p = latest.current;
      // Read once a frame: a setting change mid-flight must not split a timeline.
      const speed = getAnimationSpeed();
      const nextLabel = p.multipliersCents.join(',');
      if (labelKey !== nextLabel) {
        labelKey = nextLabel;
        labels.forEach((label, i) => {
          const cents = p.multipliersCents[i] ?? 0;
          const m = label.material as THREE.MeshBasicMaterial;
          m.map?.dispose();
          m.map = payoutInscription(cents);
          m.needsUpdate = true;
          tints[i].set(bucketTint(cents));
          // Black glass carrying a breath of the bucket's own colour.
          (slots[i].material as THREE.MeshPhysicalMaterial).color
            .copy(tints[i])
            .multiplyScalar(0.02);
        });
        cabinet.paintBuckets(
          tints,
          p.multipliersCents.map((cents) => isBigWin(cents))
        );
      }
      if ((p.path || p.batchPathBits?.length) && key !== p.dropKey) {
        key = p.dropKey;
        visibleElapsed = 0;
        duration = 16 * 236 * speed;
        landed = false;
        pendingLanding = false;
        pendingProgress = null;
        reported = -1;
        booked = 0;
        bestCents = -1;
        dropRow = -1;
        clinkCents = -1;
        clinkBig = false;
        releaseAt.length = 0;
        ballRow.length = 0;
        ringAt = Number.NEGATIVE_INFINITY;
        hitAt.fill(Number.NEGATIVE_INFINITY);
        hitBig.fill(false);
        writeTally(0, 0);
        pegs.reveal([], -1);
      }
      if (
        landedKey.current?.key === key &&
        landedKey.current.count >= (p.batchPathBits?.length ?? 0)
      ) {
        // Landed already, without the scene: a context that comes back never
        // flies or reports the same drop a second time. A batch the player has
        // since added to is not that drop: those balls have never been shown.
        landed = true;
        pendingLanding = false;
        pendingProgress = null;
      }
      ball.visible = !p.batchPathBits?.length;
      batchBalls.forEach((mesh) => {
        mesh.visible = false;
      });
      falling.length = 0;
      struckNow.length = 0;
      const gap = 140 * speed;
      // THE PLAYER RELEASES THE BALLS (Dan 2026-09-21, R6). A batch may grow
      // while it plays: each ball the page adds is released now, one gap after
      // the ball before it, never back-dated to the batch's start (a back-dated
      // ball would land without ever being seen). Drop All adds the rest at
      // once and they come down at the batch cadence.
      while (releaseAt.length < (p.batchPathBits?.length ?? 0)) {
        const previous = releaseAt.length
          ? releaseAt[releaseAt.length - 1]
          : Number.NEGATIVE_INFINITY;
        releaseAt.push(Math.max(visibleElapsed, previous + gap));
        ballRow.push(-1);
        landed = false;
      }
      /** Pegs newly struck this frame, and the lowest row among them, for the tick. */
      let strikes = 0,
        strikeRow = 0;
      if (p.batchPathBits?.length && !landed) {
        const count = p.batchPathBits.length;
        const progressOf = (index: number) =>
          reduced ? 16 : Math.min(16, ((visibleElapsed - releaseAt[index]) / duration) * 16);
        let finished = 0;
        while (finished < count && progressOf(finished) >= 16) finished++;
        // Every ball in flight lights the peg it is passing, so a batch shows
        // the same contact the single drop does instead of a silent board.
        const struck = batchStruck;
        struck.length = 0;
        let j = 0;
        for (let index = finished; index < count && j < 32; index++) {
          const progress = progressOf(index);
          if (progress < 0 || progress >= 16) continue;
          const row = Math.min(15, Math.floor(progress)),
            t = progress - row;
          const bits = p.batchPathBits[index];
          let rights = 0;
          for (let k = 0; k < row; k++) rights += (bits >> k) & 1;
          struck.push(pegIndexAt(row, rights));
          if (row > (ballRow[index] ?? -1)) {
            ballRow[index] = row;
            strikes++;
            strikeRow = Math.max(strikeRow, row);
          }
          const mesh = batchBalls[j++];
          mesh.visible = true;
          mesh.rotation.set(0.22, reduced ? 0.32 : visibleElapsed / 850 + index, -0.12);
          mesh.position.set(
            (rights - row / 2) * 0.65 + ((bits >> row) & 1 ? 1 : -1) * 0.325 * t,
            4.95 - progress * 0.55 + Math.sin(t * Math.PI) * 0.17,
            0.46
          );
        }
        pegs.light(struck);
        for (const index of struck) struckNow.push(index);
        for (let k = 0; k < j; k++) falling.push(batchBalls[k]);
        for (let i = booked; i < finished; i++) {
          const slot = pathBitsSlot(p.batchPathBits[i]);
          bookLanding(slot, p.multipliersCents[slot] ?? 0, visibleElapsed);
        }
        booked = finished;
        if (reported !== finished) {
          reported = finished;
          pendingProgress = finished;
          writeTally(finished, count);
        }
        if (finished === count) {
          landed = true;
          pendingLanding = true;
        }
      } else if (p.path && !landed) {
        const progress = reduced ? 16 : Math.min(16, (visibleElapsed / duration) * 16);
        const row = Math.min(15, Math.floor(progress));
        const t = progress - row;
        const rights = p.path.slice(0, row).reduce((a, b) => a + b, 0);
        const x = (rights - row / 2) * 0.65;
        const dx = (p.path[row] === 1 ? 1 : -1) * 0.325;
        ball.position.set(x + dx * t, 4.95 - progress * 0.55 + Math.sin(t * Math.PI) * 0.17, 0.46);
        pegs.reveal(p.path, row);
        if (!reduced) {
          struckNow.push(pegIndexAt(row, rights));
          falling.push(ball);
          if (row > dropRow && progress < 16) {
            dropRow = row;
            strikes++;
            strikeRow = row;
          }
        }
        if (progress >= 16) {
          landed = true;
          const slot = p.path.reduce((a, b) => a + b, 0);
          ball.position.set((slot - 8) * 0.65, -4.01, 0.4);
          bookLanding(slot, p.multipliersCents[slot] ?? 0, visibleElapsed);
          writeTally(1, 1);
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
      // The bucket takes the hit: a short squash, a settle and a flash in its
      // own colour, so each of the ten landings is felt one at a time. Reduced
      // motion drops the travel and the fade and holds the flash instead.
      const bounce = 420 * speed;
      slots.forEach((slot, i) => {
        const m = slot.material as THREE.MeshPhysicalMaterial;
        const age = visibleElapsed - hitAt[i];
        const fading = Number.isFinite(age) && age >= 0 && age < bounce ? 1 - age / bounce : 0;
        const level = reduced ? (fading > 0 ? 1 : 0) : fading;
        const big = hitBig[i] && level > 0;
        const squash =
          reduced || fading <= 0 ? 0 : Math.sin((1 - fading) * Math.PI) * (big ? 0.3 : 0.2);
        slot.scale.set(1 + squash * 0.4, 1 - squash, 1);
        slot.position.y = SLOT_REST_Y - squash * 0.14;
        const resting = i === p.restingSlot;
        if (level > 0) m.emissive.copy(big ? GOLD : tints[i]);
        else m.emissive.setHex(resting ? 0x1877f2 : 0);
        m.emissiveIntensity = level * (big ? 3.4 : 1.9) + (resting ? 1.1 : 0);
        cabinet.flashBucket(i, level);
      });
      // The win pulse: a gold ring thrown out of the bucket that paid 5x or more.
      const ringSpan = 700 * speed;
      const ringAge = visibleElapsed - ringAt;
      const pulsing = Number.isFinite(ringAge) && ringAge >= 0 && ringAge < ringSpan;
      winRing.visible = pulsing;
      if (pulsing) {
        const t = reduced ? 1 : ringAge / ringSpan;
        winRing.position.x = (ringSlot - 8) * 0.65;
        const grow = reduced ? 2.4 : 0.7 + t * 2.4;
        winRing.scale.set(grow, grow, 1);
        (winRing.material as THREE.MeshBasicMaterial).opacity = reduced ? 0.85 : Math.max(0, 1 - t);
      }
      ball.rotation.set(0.22, reduced ? 0.32 : now / 850, -0.12);
      // The machine around the board: the LEDs, the peg chase and flares, the
      // bucket pools, the diamond glows and the sparkle trail.
      const flying = falling.length;
      for (const diamond of diamonds) if (!falling.includes(diamond)) falling.push(diamond);
      cabinetFrame.now = now;
      cabinetFrame.speed = speed;
      cabinetFrame.reduced = reduced;
      cabinetFrame.idle = landed && !pendingLanding;
      cabinetFrame.flying = flying;
      cabinetFrame.pulsing = pulsing;
      cabinet.frame(cabinetFrame);
      if (kit.render(reduced ? 150 : 30)) {
        /* THE BOARD IS HEARD ON THE FRAME THAT SHOWS IT (2026-09-26). A tick
           for the pegs this frame shows being struck, at most one every
           PLINKO_PEG_GAP_MS on the frame clock, pitched by the lowest row
           struck; a clink for the best landing it shows. */
        if (strikes > 0 && now - tickedAt >= PLINKO_PEG_GAP_MS) {
          tickedAt = now;
          soundService.playPlinkoPeg(strikeRow, strikes);
        }
        if (clinkCents >= 0) {
          soundService.playPlinkoLanding(clinkCents, clinkBig);
          clinkCents = -1;
          clinkBig = false;
        }
        if (pendingProgress !== null) {
          p.onProgress?.(pendingProgress);
          pendingProgress = null;
        }
        if (pendingLanding) {
          pendingLanding = false;
          landedKey.current = { key, count: p.batchPathBits?.length ?? 0 };
          p.onLanded?.();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visibilityChanged);
      surface.removeEventListener('webglcontextlost', lost);
      surface.removeEventListener('webglcontextrestored', restored);
      sceneRef.current = null;
      pegs.dispose();
      cabinet.dispose();
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
    // Through the kit so the governor's pixel ratio survives the resize.
    if (typeof kit.setSize === 'function') kit.setSize(width, height);
    else kit.renderer.setSize(width, height, false);
  }, [width, height]);
  return (
    <div className={styles.board} data-motion="keep">
      {failed ? (
        <p className="sc-copy">
          The 3D Scene Is Unavailable. Your Saved Results Are Shown Without It.
        </p>
      ) : null}
      <canvas
        ref={canvas}
        className={styles.canvas}
        style={{ width, height, display: failed ? 'none' : undefined }}
        role="img"
        aria-label="Plinko Board"
      />
      <section
        className={styles.payouts}
        style={{ maxWidth: width }}
        aria-label="Payout Multipliers"
      >
        <h3>Slot Multipliers</h3>
        <p>Slots Run From Left To Right. Gold Pays The Most.</p>
        <p className={styles.tally} ref={tally} role="status" aria-live="polite" />
        <ol className={styles.payoutList} aria-label="Plinko Payout Slots">
          {props.multipliersCents.map((multiplier, index) => {
            const hit = props.restingSlot === index;
            const big = isBigWin(multiplier);
            return (
              <li
                key={index}
                aria-current={hit ? 'true' : undefined}
                data-hit={hit ? 'true' : undefined}
                data-big={big ? 'true' : undefined}
                data-win={hit && big ? 'big' : undefined}
                style={
                  {
                    '--slot-tint': bucketTint(multiplier),
                    '--slot-heat': bucketHeat(multiplier).toFixed(3),
                  } as CSSProperties
                }
              >
                <span>Slot {index + 1}</span>
                <strong>{multiplierLabel(multiplier)}</strong>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
