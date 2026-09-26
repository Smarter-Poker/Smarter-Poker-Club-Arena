/**
 * A rendered flight follows the server clock, then reveals the sealed crash.
 *
 * THE GLASS OVER THE FLIGHT (2026-09-19, Dan's directive 3: look at how the
 * leading crash games are displayed and animated, and upgrade ours). Aviator,
 * Stake Crash and Roobet Crash agree on one grammar, and this component now
 * speaks it over the 3D flight it already had:
 *
 *   - THE MULTIPLIER IS THE HERO. One large tabular figure centred over the
 *     flight, two decimals always so the digits hold still, calm white to 2x,
 *     gold to 5x, hot orange past it. Lost, it turns red and reads the crash
 *     point; won, it turns green and reads the booked multiplier.
 *   - THE AXES FOLLOW THE FLIGHT. Light multiplier lines (1.00x, 2.00x, 5.00x
 *     ...) and seconds ticks slide as the scale grows instead of jumping to
 *     it, and the head of the curve carries a marker.
 *   - WHAT THE PLAYER SET IS DRAWN WHERE IT HAPPENS. The auto cash-out is a
 *     gold line at its multiplier; the guaranteed floor is a blue line at its
 *     payout equivalent (the floor over the stake, L/B) whenever that maps
 *     onto the axis.
 *   - THE TWO MOMENTS ARE MARKED. A crash flashes red once and the curve
 *     freezes at the crash point. A cash-out pins a green marker at the booked
 *     multiplier while the flight goes on to show where it would have crashed.
 *
 * The glass is DOM and SVG placed by the same camera the scene renders with,
 * so a line drawn at 2.00x is crossed by the jet at exactly 2.00x, and it
 * stays up when WebGL cannot draw the flight. Under reduced motion every mark
 * is static and every meaning is kept; every timed effect scales with the
 * player's Animation Speed the way the flight itself does.
 *
 * THE FIGURE SEEN IS THE FIGURE BOOKED. While a round is open this loop is the
 * one clock: each drawn frame computes the multiplier once, hands it to the
 * page through `onTick` (what a tap on Book The Win sends) and prints the same
 * number into the hero. Neither side re-renders for it (Dan 2026-09-21, R20:
 * mobile is choppy; a setState per frame re-rendered the whole page). A page
 * that must freeze the figure, while its cash-out request is pending, hands
 * the frozen number back through `tickerCents` and the hero prints exactly
 * that. Replays, which book nothing, let the hero follow the clock. The loop
 * stops while the tab is hidden and resumes when it is shown.
 *
 * THE SCENE (2026-09-25, Dan: "the graphics are very crude, basic and boring,
 * instead of dynamic, and high def. the back round is terrible"). The flight
 * now climbs through a sky in the house palette instead of past a cartoon
 * planet: an obsidian-to-navy gradient sky with a faint royal-blue nebula
 * wash, two starfields on different depths that drift against the flight (the
 * nearer one brighter, larger and faster, so the climb reads as speed), a
 * thin horizon glow under the launch line and a small dark world in the lower
 * corner that the curve never reaches. The curve is a glowing ribbon (a light
 * core inside a royal-blue halo, gold past 2x, white-gold past 5x, red once
 * crashed) over a soft fill down to the launch line, with wake particles that
 * fade behind a chrome-and-blue jet whose afterburners flicker and whose
 * canopy catches the room. A crash is a real burst: a flash, a shockwave ring
 * and sparks flung along the curve's tangent while the ribbon reddens from
 * the head backwards. The camera pushes in very gently as the multiplier
 * climbs, along its line to the launch point so the launch line never moves
 * and the glass, placed by the same camera, stays on the curve. Every glow is
 * an additive sprite or shader plane (no post-processing), every geometry is
 * built once and only its buffers are rewritten per frame.
 *
 * THE CAP IS SAID (Dan: "the multiplier should be 25x max and that should be
 * displayed to the user"). `capCents` is printed as a permanent "Max 25.00x"
 * chip in the corner, drawn as a gold dashed line on the axis once the scale
 * reaches it, and a round that settles AT the cap is told so on its plate.
 *
 * HOW HIGH IT WOULD HAVE GONE (Dan: "if a user books the win it should show
 * them how high it would have gone"). Once a booked round's replay reaches
 * the sealed crash point, a plate in the lower third of the frame says "It
 * Would Have Gone To 4.62x" over "You Booked 2.57x" (or that it crashed right
 * after the booking, or that it would have booked at the max first). It is
 * shown by the frame loop, like the hero, so nothing re-renders for it.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { gameRenderer, metal, solid } from '../games/sceneKit';
import { prefersReducedMotion, getAnimationSpeed } from '../../utils/animationSpeed';
import { crashMultiplierCents } from '../../utils/diamondGamesFairness';
import { gameChips } from '../../utils/bonusGameBudget';
import { reportError } from '../../utils/errorReporter';
import { soundService } from '../../services/SoundService';
import styles from './CrashCurve.module.css';
export type CrashPhase = 'idle' | 'open' | 'cashed' | 'crashed';
export interface CrashCurveProps {
  phase: CrashPhase;
  growthK: number;
  capCents: number;
  startedAtLocalMs: number | null;
  /** Read-only replay clock. Live play always follows startedAtLocalMs. */
  replayElapsedMs?: number;
  finalCents: number | null;
  cashoutCents: number | null;
  crashCents?: number | null;
  autoCashoutCents: number | null;
  /**
   * A multiplier the page holds still while the round is open (its cash-out
   * request is pending). The hero prints exactly this. Absent, the hero prints
   * the scene clock's figure, the same one `onTick` hands the page each frame.
   */
  tickerCents?: number | null;
  /** The sealed floor in chips and the stake it sits under: the floor line is drawn at L/B. */
  minimumPayoutChips?: number | null;
  betChips?: number | null;
  width?: number;
  height?: number;
  onTick?: (cents: number) => void;
  onSettled?: () => void;
}
/** The hero always prints two decimals (2.50x, never 2.5x) so its digits do not jitter. */
export function tickerLabel(cents: number): string {
  return `${(Math.max(0, cents) / 100).toFixed(2)}x`;
}
/** Calm to 2x, warm to 5x, hot past it. */
export function tickerHeat(cents: number): 'calm' | 'warm' | 'hot' {
  return cents >= 500 ? 'hot' : cents >= 200 ? 'warm' : 'calm';
}
/** What the hero prints in each phase; `clock` is the open round's live figure. */
function heroFigure(p: CrashCurveProps, clock: number): number {
  return p.phase === 'idle'
    ? 100
    : p.phase === 'crashed'
      ? (p.finalCents ?? 100)
      : p.phase === 'cashed'
        ? (p.cashoutCents ?? p.finalCents ?? 100)
        : (p.tickerCents ?? clock);
}
/** The multiplier equivalent of a guaranteed floor, in cents, or null when there is none to draw. */
export function floorCents(
  minimumPayoutChips: number | null | undefined,
  betChips: number | null | undefined
) {
  if (!minimumPayoutChips || !betChips || minimumPayoutChips <= 0 || betChips <= 0) return null;
  return Math.round((minimumPayoutChips / betChips) * 100);
}
/** What the plate over a booked flight says once the replay has reached the crash point. */
function wouldHaveGone(
  cashoutCents: number,
  crashCents: number,
  capCents: number
): { title: string; figure: string; sub: string } {
  if (cashoutCents >= capCents)
    return {
      title: `Booked At The ${tickerLabel(capCents)} Max`,
      figure: tickerLabel(capCents),
      sub: 'The Most Any Round Pays',
    };
  const booked = `You Booked ${tickerLabel(cashoutCents)}`;
  if (crashCents > capCents)
    return {
      title: `It Would Have Gone To The ${tickerLabel(capCents)} Max`,
      figure: tickerLabel(capCents),
      sub: booked,
    };
  if (crashCents <= cashoutCents + 1)
    return {
      title: 'It Crashed Right After You Booked',
      figure: tickerLabel(crashCents),
      sub: booked,
    };
  return { title: 'It Would Have Gone To', figure: tickerLabel(crashCents), sub: booked };
}
/** The multiplier lines the glass can print; the ones inside the axis are shown. */
const MULTIPLIER_TICKS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
/** Two tick labels closer than this, in glass pixels, would overprint; the lower one gives way. */
const TICK_LABEL_GAP = 14;
/** Seconds tick spacing candidates: the smallest that keeps the axis to a handful of ticks. */
const SECOND_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300];
const SECOND_TICKS = 8;
/** The red wash on a crash, before Animation Speed. */
export const CRASH_FLASH_MS = 420;
/** The plate's entrance once the replay reaches the crash point, before Animation Speed. */
export const REVEAL_IN_MS = 520;
/** How closely the axis follows the flight: a time constant, before Animation Speed. */
const AXIS_FOLLOW_MS = 180;
/** How closely the camera follows the climb: a time constant, before Animation Speed. */
const CAMERA_FOLLOW_MS = 420;
/** The furthest the camera pushes in, as a fraction of its distance to the launch point. */
const CAMERA_PUSH = 0.07;
const SVG = 'http://www.w3.org/2000/svg';
const RIBBON = 96;
const WAKE = 48;
const SPARKS = 80;
const NEAR_STARS = 180;
const FAR_STARS = 420;

/**
 * The flight path in scene units, by progress 0..1 along it. A wide frame
 * stretches it sideways (the 1.2 aspect of a phone leaves it as it was) so a
 * desktop flight fills its glass instead of climbing up the middle third.
 */
function flightPath(aspect: number) {
  const s = THREE.MathUtils.clamp(aspect / 1.25, 1, 1.55);
  const at = (v: number, out: THREE.Vector3) =>
    out.set((-3.8 + v * 7.1) * s, -1.55 + v * v * 3.5, 0);
  const tangent = (v: number, out: THREE.Vector3) => out.set(7.1 * s, 7 * v, 0).normalize();
  return { at, tangent, launch: at(0, new THREE.Vector3()) };
}
type FlightPath = ReturnType<typeof flightPath>;

const COLOR_INCLUDES = `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`;

/** A soft round texture built in memory: no 2D canvas, so it exists wherever three does. */
function softTexture(size: number, alphaAt: (d: number) => number) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1,
        dy = ((y + 0.5) / size) * 2 - 1;
      const d = Math.min(1, Math.hypot(dx, dy));
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * THREE.MathUtils.clamp(alphaAt(d), 0, 1));
    }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
function glowSprite(map: THREE.Texture, color: number, scale: number, opacity: number) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map,
      color,
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  sprite.scale.setScalar(scale);
  return sprite;
}
/** Additive round points whose size and brightness follow a per-point life. */
function pointsMaterial(scale: number, bright: number, dim: number) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uScale: { value: scale },
      uBright: { value: new THREE.Color(bright) },
      uDim: { value: new THREE.Color(dim) },
    },
    vertexShader: `
      uniform float uScale; attribute float aLife; attribute float aSize; varying float vLife;
      void main(){ vLife=aLife; vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_PointSize=aSize*uScale*(0.35+0.65*aLife)/-mv.z; gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `
      uniform vec3 uBright; uniform vec3 uDim; varying float vLife;
      void main(){ vec2 q=gl_PointCoord-0.5; float d=length(q)*2.0; float a=smoothstep(1.0,0.1,d);
        gl_FragColor=vec4(mix(uDim,uBright,vLife)*a*vLife,1.0);${COLOR_INCLUDES} }`,
  });
}
function lifePoints(count: number, material: THREE.ShaderMaterial, size: (i: number) => number) {
  const geometry = new THREE.BufferGeometry();
  const position = new THREE.BufferAttribute(new Float32Array(count * 3), 3);
  const life = new THREE.BufferAttribute(new Float32Array(count), 1);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = size(i);
  position.setUsage(THREE.DynamicDrawUsage);
  life.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', position);
  geometry.setAttribute('aLife', life);
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, position, life };
}
/** A deterministic 0..1 for a point and a channel, so the burst is the same shape every crash. */
const hash = (i: number, k: number) => {
  const v = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return v - Math.floor(v);
};

/** A starfield that wraps as it drifts, twinkling in the vertex shader; one draw call, no CPU work. */
function starfield(
  count: number,
  period: [number, number],
  depth: [number, number],
  size: [number, number],
  color: number,
  scale: number
) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = hash(i, 1) * period[0];
    positions[i * 3 + 1] = hash(i, 2) * period[1];
    positions[i * 3 + 2] = -(depth[0] + hash(i, 3) * (depth[1] - depth[0]));
    sizes[i] = size[0] + hash(i, 4) ** 2 * (size[1] - size[0]);
    phases[i] = hash(i, 5);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uDrift: { value: new THREE.Vector2() },
      uPeriod: { value: new THREE.Vector2(period[0], period[1]) },
      uScale: { value: scale },
      uColor: { value: new THREE.Color(color) },
    },
    vertexShader: `
      uniform float uTime; uniform vec2 uDrift; uniform vec2 uPeriod; uniform float uScale;
      attribute float aSize; attribute float aPhase; varying float vA;
      void main(){ vec3 p=position;
        p.x=mod(p.x+uDrift.x,uPeriod.x)-uPeriod.x*0.5; p.y=mod(p.y+uDrift.y,uPeriod.y)-uPeriod.y*0.5;
        vec4 mv=modelViewMatrix*vec4(p,1.0); gl_PointSize=aSize*uScale/-mv.z;
        vA=0.6+0.4*sin(uTime*(1.2+aPhase*2.4)+aPhase*31.0); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vA;
      void main(){ vec2 q=gl_PointCoord-0.5; float d=length(q)*2.0; float a=smoothstep(1.0,0.12,d); a*=a;
        gl_FragColor=vec4(uColor*a*vA,1.0);${COLOR_INCLUDES} }`,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, material };
}

/** The jet: a lathed chrome fuselage, a canopy that catches the room, swept wings, canted fins, twin afterburners. */
function jet(disc: THREE.Texture) {
  const group = new THREE.Group();
  const chrome = metal(0xd9e1ea, 0.12),
    blue = metal(0x1877f2, 0.18),
    livery = metal(0x1a5fd0, 0.24),
    dark = metal(0x141d2b, 0.22);
  const canopyGlass = new THREE.MeshPhysicalMaterial({
    color: 0x0b1c3a,
    metalness: 0.6,
    roughness: 0.04,
    clearcoat: 1,
    clearcoatRoughness: 0.03,
    envMapIntensity: 1.6,
  });
  // The hull sits ahead of the group origin, so the head of the curve (and the
  // glass marker on it) is under the wing root and the ribbon leaves the engines.
  const hull = new THREE.Group();
  hull.position.x = 0.55;
  group.add(hull);
  const profile = (
    [
      [0, -1.55],
      [0.09, -1.45],
      [0.16, -1.1],
      [0.22, -0.5],
      [0.235, 0.15],
      [0.2, 0.65],
      [0.12, 0.98],
      [0, 1.18],
    ] as [number, number][]
  ).map(([r, y]) => new THREE.Vector2(r, y));
  const fuselage = new THREE.Mesh(new THREE.LatheGeometry(profile, 32), chrome);
  fuselage.rotation.z = -Math.PI / 2;
  hull.add(fuselage);
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), canopyGlass);
  canopy.scale.set(0.5, 0.17, 0.17);
  canopy.position.set(0.35, 0.16, 0);
  hull.add(canopy);
  solid(hull, blue, [1.5, 0.035, 0.46], [-0.35, 0, 0], 0.01);
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.45, 0.15);
  wingShape.lineTo(-0.85, 1.2);
  wingShape.lineTo(-1.1, 1.16);
  wingShape.lineTo(-1.1, 0.15);
  wingShape.closePath();
  const wingGeometry = new THREE.ExtrudeGeometry(wingShape, {
    depth: 0.05,
    bevelEnabled: true,
    bevelThickness: 0.015,
    bevelSize: 0.02,
    bevelSegments: 2,
    steps: 1,
  });
  const finShape = new THREE.Shape();
  finShape.moveTo(-0.75, 0);
  finShape.lineTo(-1.15, 0.58);
  finShape.lineTo(-1.4, 0.55);
  finShape.lineTo(-1.45, 0);
  finShape.closePath();
  const finGeometry = new THREE.ExtrudeGeometry(finShape, { depth: 0.035, bevelEnabled: false });
  const tailShape = new THREE.Shape();
  tailShape.moveTo(-0.9, 0.1);
  tailShape.lineTo(-1.35, 0.75);
  tailShape.lineTo(-1.5, 0.72);
  tailShape.lineTo(-1.5, 0.1);
  tailShape.closePath();
  const tailGeometry = new THREE.ExtrudeGeometry(tailShape, { depth: 0.03, bevelEnabled: false });
  const engineGeometry = new THREE.CylinderGeometry(0.11, 0.14, 1.05, 24);
  const nozzleGeometry = new THREE.TorusGeometry(0.135, 0.03, 8, 24);
  const outerCone = new THREE.ConeGeometry(0.13, 1.2, 20, 1, true);
  outerCone.translate(0, 0.6, 0);
  const innerCone = new THREE.ConeGeometry(0.06, 0.75, 16, 1, true);
  innerCone.translate(0, 0.375, 0);
  const afterburners: { outer: THREE.Mesh; inner: THREE.Mesh; glow: THREE.Sprite }[] = [];
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry, livery);
    wing.rotation.x = Math.PI / 2;
    wing.scale.z = side;
    wing.position.y = -0.06;
    hull.add(wing);
    solid(hull, chrome, [0.3, 0.07, 0.1], [-0.95, -0.06, side * 1.16], 0.02);
    const wingLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.04, 10, 8),
      new THREE.MeshBasicMaterial({ color: side < 0 ? 0xff5b6e : 0x45adff })
    );
    wingLight.position.set(-1.0, -0.02, side * 1.22);
    hull.add(wingLight);
    const wingGlow = glowSprite(disc, side < 0 ? 0xff5b6e : 0x45adff, 0.42, 0.75);
    wingGlow.position.copy(wingLight.position);
    hull.add(wingGlow);
    const fin = new THREE.Mesh(finGeometry, livery);
    fin.position.z = side * 0.16;
    fin.rotation.x = -side * 0.3;
    hull.add(fin);
    const tail = new THREE.Mesh(tailGeometry, chrome);
    tail.rotation.x = Math.PI / 2;
    tail.scale.z = side;
    tail.position.y = -0.02;
    hull.add(tail);
    const engine = new THREE.Mesh(engineGeometry, chrome);
    engine.rotation.z = -Math.PI / 2;
    engine.position.set(-0.85, -0.13, side * 0.4);
    hull.add(engine);
    const nozzle = new THREE.Mesh(nozzleGeometry, dark);
    nozzle.rotation.y = Math.PI / 2;
    nozzle.position.set(-1.38, -0.13, side * 0.4);
    hull.add(nozzle);
    const outer = new THREE.Mesh(
      outerCone,
      new THREE.MeshBasicMaterial({
        color: 0x45adff,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    outer.rotation.z = Math.PI / 2;
    outer.position.set(-1.38, -0.13, side * 0.4);
    hull.add(outer);
    const inner = new THREE.Mesh(
      innerCone,
      new THREE.MeshBasicMaterial({
        color: 0xeaf6ff,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    inner.rotation.z = Math.PI / 2;
    inner.position.copy(outer.position);
    hull.add(inner);
    const glow = glowSprite(disc, 0x9fd8ff, 0.6, 0.85);
    glow.position.set(-1.42, -0.13, side * 0.4);
    hull.add(glow);
    afterburners.push({ outer, inner, glow });
  }
  group.rotation.order = 'ZYX';
  return { group, afterburners };
}

/** The sky, the stars, the horizon, the jet, its ribbon and fill, the wake, the cash-out ring and the burst. */
function dressScene(scene: THREE.Scene, path: FlightPath, height: number) {
  scene.fog = new THREE.FogExp2(0x070b10, 0.006);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pointScale = dpr * height * 0.35;
  const disc = softTexture(64, (d) => (1 - d) ** 1.8);
  const ring = softTexture(64, (d) => Math.exp(-(((d - 0.74) / 0.07) ** 2)));
  // The sky: one far plane, obsidian at the top through deep navy, with a
  // royal-blue nebula wash breathing very slowly through its middle band.
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 130),
    new THREE.ShaderMaterial({
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uTop: { value: new THREE.Color(0x050607) },
        uMid: { value: new THREE.Color(0x06101f) },
        uLow: { value: new THREE.Color(0x0a1424) },
        uNebula: { value: new THREE.Color(0x1877f2) },
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uTime; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uLow; uniform vec3 uNebula; varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
        float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
          return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y); }
        void main(){
          float y=clamp((vUv.y-0.22)/0.56,0.0,1.0);
          vec3 c=mix(uLow,uMid,smoothstep(0.0,0.5,y)); c=mix(c,uTop,smoothstep(0.5,1.0,y));
          vec2 q=vUv*vec2(5.0,3.0)+vec2(uTime*0.006,-uTime*0.003);
          float n=noise(q)*0.55+noise(q*2.7+3.1)*0.3+noise(q*6.1+7.7)*0.15;
          float band=smoothstep(0.08,0.5,y)*(1.0-smoothstep(0.6,1.0,y));
          c+=uNebula*pow(n,3.0)*0.2*band;
          gl_FragColor=vec4(c,1.0);${COLOR_INCLUDES} }`,
    })
  );
  sky.position.set(0, -16, -70);
  sky.renderOrder = -3;
  scene.add(sky);
  const far = starfield(FAR_STARS, [90, 46], [30, 52], [0.45, 1.1], 0x9fc6ff, pointScale);
  far.points.position.set(0, -7, 0);
  far.points.renderOrder = -2;
  scene.add(far.points);
  const near = starfield(NEAR_STARS, [56, 30], [12, 24], [0.8, 1.7], 0xe4f1ff, pointScale);
  near.points.position.set(0, -3, 0);
  near.points.renderOrder = -2;
  scene.add(near.points);
  const nebula: THREE.Sprite[] = [];
  const nebulaColors = [0x1877f2, 0x0d3f8a, 0x1355c0, 0x1877f2, 0x0b2f6b];
  for (let i = 0; i < 5; i++) {
    const wash = glowSprite(disc, nebulaColors[i], 16 + hash(i, 6) * 12, 0.02 + hash(i, 7) * 0.018);
    wash.position.set(-14 + hash(i, 8) * 30, -9 + hash(i, 9) * 12, -20 - hash(i, 10) * 8);
    wash.renderOrder = -1;
    nebula.push(wash);
    scene.add(wash);
  }
  // A thin horizon glow under the launch line, and a small dark world in the
  // lower corner: depth cues that the curve never touches.
  const horizon = new THREE.Mesh(
    new THREE.PlaneGeometry(44, 0.8),
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uColor: { value: new THREE.Color(0x45adff) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 uColor; varying vec2 vUv;
        void main(){ float dy=abs(vUv.y-0.5); float line=exp(-dy*dy*900.0); float haze=exp(-dy*dy*40.0)*0.08;
          float ends=smoothstep(0.0,0.3,vUv.x)*smoothstep(1.0,0.7,vUv.x);
          gl_FragColor=vec4(uColor*(line*0.55+haze)*ends,1.0);${COLOR_INCLUDES} }`,
    })
  );
  horizon.position.set(0, -4.15, 0);
  scene.add(horizon);
  const world = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 40, 28),
    new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(0x0a1424) },
        uRim: { value: new THREE.Color(0x1877f2) },
      },
      vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 p=modelViewMatrix*vec4(position,1.0); vN=normalize(normalMatrix*normal); vV=normalize(-p.xyz); gl_Position=projectionMatrix*p; }`,
      fragmentShader: `
        uniform vec3 uColor; uniform vec3 uRim; varying vec3 vN; varying vec3 vV;
        void main(){ float f=dot(vN,vV); float rim=pow(1.0-max(0.0,f),3.0);
          float lit=max(0.0,dot(vN,normalize(vec3(-0.6,0.5,0.6))));
          gl_FragColor=vec4(uColor*(0.35+lit*0.8)+uRim*rim*0.7,1.0);${COLOR_INCLUDES} }`,
    })
  );
  world.position.set(path.launch.x * -1.2, -4.45, -3);
  scene.add(world);
  const worldGlow = glowSprite(disc, 0x1877f2, 2.4, 0.12);
  worldGlow.position.copy(world.position);
  scene.add(worldGlow);
  const sun = new THREE.DirectionalLight(0xdfe9ff, 1.6);
  sun.position.set(-8, 6, 5);
  scene.add(sun);
  const flight = jet(disc);
  flight.group.scale.setScalar(0.95);
  scene.add(flight.group);
  const headGlow = glowSprite(disc, 0x7fd0ff, 1.7, 0.55);
  scene.add(headGlow);
  // The ribbon and the fill: one strip each, rewritten in place every frame.
  const strip = (halfWidthAcross: boolean) => {
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(RIBBON * 2 * 3), 3);
    position.setUsage(THREE.DynamicDrawUsage);
    const uv = new Float32Array(RIBBON * 2 * 2);
    const index: number[] = [];
    for (let i = 0; i < RIBBON; i++) {
      const along = i / (RIBBON - 1);
      uv.set(halfWidthAcross ? [-1, along, 1, along] : [0, along, 1, along], i * 4);
      if (i < RIBBON - 1) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    geometry.setAttribute('position', position);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setIndex(index);
    return { geometry, position };
  };
  const ribbon = strip(true);
  const ribbonMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uCore: { value: new THREE.Color(0xbfe6ff) },
      uHalo: { value: new THREE.Color(0x1877f2) },
      uRedCore: { value: new THREE.Color(0xff8a99) },
      uRedHalo: { value: new THREE.Color(0xff2d4a) },
      uRed: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uCore; uniform vec3 uHalo; uniform vec3 uRedCore; uniform vec3 uRedHalo; uniform float uRed; varying vec2 vUv;
      void main(){ float a=abs(vUv.x); float core=1.0-smoothstep(0.0,0.2,a); float halo=pow(1.0-a,2.2)*0.6;
        float red=step(1.0-uRed,vUv.y); vec3 c=mix(uCore,uRedCore,red); vec3 h=mix(uHalo,uRedHalo,red);
        gl_FragColor=vec4(c*core+h*halo,1.0);${COLOR_INCLUDES} }`,
  });
  const ribbonMesh = new THREE.Mesh(ribbon.geometry, ribbonMaterial);
  ribbonMesh.frustumCulled = false;
  ribbonMesh.position.z = 0.03;
  scene.add(ribbonMesh);
  const fill = strip(false);
  const fillMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: new THREE.Color(0x1877f2) } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uColor; varying vec2 vUv;
      void main(){ float up=pow(vUv.x,1.7); gl_FragColor=vec4(uColor*up*0.42,1.0);${COLOR_INCLUDES} }`,
  });
  const fillMesh = new THREE.Mesh(fill.geometry, fillMaterial);
  fillMesh.frustumCulled = false;
  fillMesh.position.z = -0.05;
  scene.add(fillMesh);
  const wake = lifePoints(
    WAKE,
    pointsMaterial(pointScale, 0x9fd8ff, 0x1877f2),
    (i) => 0.45 + hash(i, 11) * 0.7
  );
  wake.points.renderOrder = 1;
  scene.add(wake.points);
  const wakeVelocity = new Float32Array(WAKE * 3);
  // The cash-out ring stays where the win was booked while the flight goes on.
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(0.22, 0.035, 8, 24),
    new THREE.MeshBasicMaterial({ color: 0x5df2a0 })
  );
  marker.visible = false;
  scene.add(marker);
  const markerGlow = glowSprite(disc, 0x5df2a0, 1.1, 0.5);
  markerGlow.visible = false;
  scene.add(markerGlow);
  // The burst: a flash, a shockwave and sparks flung along the tangent.
  const flash = glowSprite(disc, 0xfff1c9, 1, 0);
  const fire = glowSprite(disc, 0xff5b3a, 1, 0);
  const shock = glowSprite(ring, 0xff5b6e, 1, 0);
  // Additive sprites can carry more than white: the burst is meant to blow out.
  fire.material.color.multiplyScalar(1.6);
  shock.material.color.multiplyScalar(1.6);
  for (const sprite of [flash, fire, shock]) {
    sprite.visible = false;
    sprite.renderOrder = 2;
    scene.add(sprite);
  }
  const sparks = lifePoints(
    SPARKS,
    pointsMaterial(pointScale, 0xfff1c9, 0xff5b6e),
    (i) => 0.3 + hash(i, 12) * 0.6
  );
  sparks.points.visible = false;
  sparks.points.renderOrder = 2;
  scene.add(sparks.points);
  // Each spark's direction (along the tangent, fanned out) and speed, fixed at build.
  const sparkFan = new Float32Array(SPARKS * 4);
  for (let i = 0; i < SPARKS; i++) {
    sparkFan[i * 4] = 0.5 + hash(i, 13) * 1.1;
    sparkFan[i * 4 + 1] = (hash(i, 14) * 2 - 1) * 0.6;
    sparkFan[i * 4 + 2] = (hash(i, 15) * 2 - 1) * 0.4;
    sparkFan[i * 4 + 3] = 1.2 + hash(i, 16) * 2.4;
  }
  return {
    sky,
    far,
    near,
    nebula,
    flight,
    headGlow,
    ribbon,
    ribbonMaterial,
    fill,
    fillMaterial,
    wake,
    wakeVelocity,
    marker,
    markerGlow,
    flash,
    fire,
    shock,
    sparks,
    sparkFan,
  };
}
type Art = ReturnType<typeof dressScene>;
/** The ribbon's colours by heat: calm light blue in royal, gold past 2x, white-gold past 5x. */
const RIBBON_HEAT = {
  calm: {
    core: new THREE.Color(0xbfe6ff),
    halo: new THREE.Color(0x1877f2),
    glow: new THREE.Color(0x7fd0ff),
  },
  warm: {
    core: new THREE.Color(0xffe27a),
    halo: new THREE.Color(0xd9a500),
    glow: new THREE.Color(0xffd700),
  },
  hot: {
    core: new THREE.Color(0xfff8e1),
    halo: new THREE.Color(0xffd700),
    glow: new THREE.Color(0xfff2c4),
  },
};

/** A line with a label on the glass: placed each frame, hidden when off the axis. */
interface Mark {
  line: SVGLineElement;
  text: SVGTextElement;
  shown: boolean;
  label: string;
}
function markIn(parent: SVGElement, attrs: Record<string, string>): Mark {
  const line = document.createElementNS(SVG, 'line');
  const text = document.createElementNS(SVG, 'text');
  for (const [k, v] of Object.entries(attrs)) {
    line.setAttribute(k, v);
    text.setAttribute(`${k}-label`, v);
  }
  line.setAttribute('visibility', 'hidden');
  text.setAttribute('visibility', 'hidden');
  parent.append(line, text);
  return { line, text, shown: false, label: '' };
}
function place(
  mark: Mark,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  tx: number,
  ty: number,
  label: string
) {
  const at = (v: number) => v.toFixed(1);
  mark.line.setAttribute('x1', at(x1));
  mark.line.setAttribute('y1', at(y1));
  mark.line.setAttribute('x2', at(x2));
  mark.line.setAttribute('y2', at(y2));
  mark.text.setAttribute('x', at(tx));
  mark.text.setAttribute('y', at(ty));
  if (mark.label !== label) {
    mark.label = label;
    mark.text.textContent = label;
  }
  if (!mark.shown) {
    mark.shown = true;
    mark.line.removeAttribute('visibility');
    mark.text.removeAttribute('visibility');
  }
}
function hide(mark: Mark) {
  if (!mark.shown) return;
  mark.shown = false;
  mark.line.setAttribute('visibility', 'hidden');
  mark.text.setAttribute('visibility', 'hidden');
}
/** A ring with a label on the glass, for the head, the cash-out and the crash. */
interface Spot {
  ring: SVGCircleElement;
  text: SVGTextElement;
  shown: boolean;
  label: string;
}
function spotIn(parent: SVGElement, name: string, radius: number): Spot {
  const ring = document.createElementNS(SVG, 'circle');
  const text = document.createElementNS(SVG, 'text');
  ring.setAttribute('data-marker', name);
  ring.setAttribute('r', String(radius));
  ring.setAttribute('visibility', 'hidden');
  text.setAttribute('data-marker-label', name);
  text.setAttribute('visibility', 'hidden');
  parent.append(ring, text);
  return { ring, text, shown: false, label: '' };
}
function pin(spot: Spot, x: number, y: number, label: string, tx: number, ty: number) {
  spot.ring.setAttribute('cx', x.toFixed(1));
  spot.ring.setAttribute('cy', y.toFixed(1));
  spot.text.setAttribute('x', tx.toFixed(1));
  spot.text.setAttribute('y', ty.toFixed(1));
  if (spot.label !== label) {
    spot.label = label;
    spot.text.textContent = label;
  }
  if (!spot.shown) {
    spot.shown = true;
    spot.ring.removeAttribute('visibility');
  }
  if (label) spot.text.removeAttribute('visibility');
  else spot.text.setAttribute('visibility', 'hidden');
}
function unpin(spot: Spot) {
  if (!spot.shown) return;
  spot.shown = false;
  spot.ring.setAttribute('visibility', 'hidden');
  spot.text.setAttribute('visibility', 'hidden');
}

/** The axes, the reference lines and the markers, built once per glass. */
function dressGlass(svg: SVGSVGElement) {
  const group = (name: string, className: string) => {
    const g = document.createElementNS(SVG, 'g');
    g.setAttribute('class', className);
    g.setAttribute('data-glass', name);
    svg.appendChild(g);
    return g;
  };
  const axis = group('axis', styles.axis);
  const grid = MULTIPLIER_TICKS.map((cents) => markIn(axis, { 'data-tick': String(cents) }));
  const seconds = Array.from({ length: SECOND_TICKS }, (_, i) =>
    markIn(axis, { 'data-second': String(i) })
  );
  const cap = markIn(group('cap', styles.capLine), { 'data-line': 'cap' });
  const auto = markIn(group('auto', styles.autoLine), { 'data-line': 'auto' });
  const floor = markIn(group('floor', styles.floorLine), { 'data-line': 'floor' });
  const head = spotIn(group('head', styles.headMark), 'head', 7);
  const cash = spotIn(group('cash', styles.cashMark), 'cash', 5.5);
  const crash = spotIn(group('crash', styles.crashMark), 'crash', 9);
  return { grid, seconds, cap, auto, floor, head, cash, crash };
}

/** The scene's per-frame inputs, gathered by the loop so the flight and the burst read one state. */
interface FrameState {
  now: number;
  dt: number;
  phase: CrashPhase;
  progress: number;
  shownCents: number;
  finished: boolean;
  burst: number;
  cashProgress: number | null;
  /** A round booked at the ceiling: the flight is crowned in gold, nothing crashes. */
  atCap: boolean;
  reduced: boolean;
  speed: number;
}
/** The burst's two palettes: the crash in red, the ceiling in gold. */
const BURST_PALETTE = {
  crash: {
    flash: new THREE.Color(0xfff1c9),
    fire: new THREE.Color(0xff5b3a).multiplyScalar(1.6),
    shock: new THREE.Color(0xff5b6e).multiplyScalar(1.6),
    bright: new THREE.Color(0xfff1c9),
    dim: new THREE.Color(0xff5b6e),
  },
  max: {
    flash: new THREE.Color(0xfff6d0),
    fire: new THREE.Color(0xffd700).multiplyScalar(1.5),
    shock: new THREE.Color(0xffd700).multiplyScalar(1.4),
    bright: new THREE.Color(0xfff6d0),
    dim: new THREE.Color(0xffb300),
  },
} as const;
/** Writes the flight, the ribbon, the wake, the sky and the burst for one frame. Allocates nothing. */
function paintScene(art: Art, path: FlightPath, s: FrameState, v: THREE.Vector3[]) {
  const [head, tangent, normal, scratch] = v;
  path.at(s.progress, head);
  path.tangent(s.progress, tangent);
  normal.set(-tangent.y, tangent.x, 0);
  const heat = RIBBON_HEAT[tickerHeat(s.shownCents)];
  const mix = s.reduced ? 1 : 1 - Math.exp(-s.dt / (260 * s.speed));
  art.ribbonMaterial.uniforms.uCore.value.lerp(heat.core, mix);
  art.ribbonMaterial.uniforms.uHalo.value.lerp(heat.halo, mix);
  art.fillMaterial.uniforms.uColor.value.lerp(
    s.finished && !s.atCap ? art.ribbonMaterial.uniforms.uRedHalo.value : heat.halo,
    mix
  );
  art.headGlow.material.color.lerp(heat.glow, mix);
  art.ribbonMaterial.uniforms.uRed.value =
    s.finished && !s.atCap ? (s.reduced ? 1 : Math.min(1, s.burst * 1.6)) : 0;
  // The jet: on the head, along the tangent, banking harder as the curve steepens.
  const flight = art.flight.group;
  flight.position.copy(head);
  // Between rounds the jet hovers on the launch line instead of sitting on it.
  if (s.phase === 'idle' && !s.reduced) flight.position.y += Math.sin(s.now / 700) * 0.06;
  flight.rotation.set(
    0.04 + s.progress * 0.14,
    0.06,
    Math.atan2(tangent.y, tangent.x) +
      (s.phase === 'idle' && !s.reduced ? Math.sin(s.now / 900) * 0.035 : 0)
  );
  // A crash removes the jet; a booking at the ceiling keeps it flying under the crown.
  flight.visible = !s.finished || s.atCap;
  art.headGlow.visible = !s.finished || s.atCap;
  art.headGlow.position.copy(flight.position);
  art.headGlow.material.opacity = s.reduced ? 0.55 : 0.45 + Math.sin(s.now / 160) * 0.12;
  art.flight.afterburners.forEach(({ outer, inner, glow }, i) => {
    const flicker = s.reduced
      ? 1
      : 0.82 + Math.sin(s.now / 41 + i * 2.1) * 0.12 + Math.sin(s.now / 97 + i) * 0.08;
    outer.scale.y = flicker;
    inner.scale.y = flicker * (s.reduced ? 1 : 0.9 + Math.sin(s.now / 63 + i) * 0.1);
    glow.material.opacity = 0.6 + (flicker - 0.82) * 1.2;
  });
  // The ribbon and the fill follow the curve to the head.
  const ribbon = art.ribbon.position.array as Float32Array;
  const fill = art.fill.position.array as Float32Array;
  const launchY = path.launch.y;
  for (let i = 0; i < RIBBON; i++) {
    const along = i / (RIBBON - 1);
    path.at(s.progress * along, scratch);
    path.tangent(s.progress * along, normal);
    const nx = -normal.y,
      ny = normal.x;
    const w = 0.26 * (0.7 + 0.3 * along);
    ribbon.set(
      [scratch.x - nx * w, scratch.y - ny * w, 0, scratch.x + nx * w, scratch.y + ny * w, 0],
      i * 6
    );
    fill.set([scratch.x, launchY, 0, scratch.x, scratch.y, 0], i * 6);
  }
  normal.set(-tangent.y, tangent.x, 0);
  art.ribbon.position.needsUpdate = true;
  art.fill.position.needsUpdate = true;
  // The wake: particles born at the engines, drifting back down the curve and fading.
  const wakePos = art.wake.position.array as Float32Array;
  const wakeLife = art.wake.life.array as Float32Array;
  const vel = art.wakeVelocity;
  if (s.reduced) {
    if (art.wake.points.visible) {
      wakeLife.fill(0);
      art.wake.life.needsUpdate = true;
      art.wake.points.visible = false;
    }
  } else {
    art.wake.points.visible = true;
    const dt = Math.min(0.1, s.dt / 1000);
    let emit = s.phase === 'open' ? 3 : 0;
    for (let i = 0; i < WAKE; i++) {
      wakeLife[i] -= dt / (0.75 * s.speed);
      if (wakeLife[i] <= 0) {
        wakeLife[i] = 0;
        if (emit > 0) {
          emit--;
          wakeLife[i] = 1;
          const j = i * 3;
          wakePos[j] = head.x - tangent.x * 0.7 + normal.x * (Math.random() - 0.5) * 0.2;
          wakePos[j + 1] = head.y - tangent.y * 0.7 + normal.y * (Math.random() - 0.5) * 0.2;
          wakePos[j + 2] = (Math.random() - 0.5) * 0.3;
          const push = 1.3 + Math.random() * 0.9,
            side = (Math.random() - 0.5) * 0.9;
          vel[j] = -tangent.x * push + normal.x * side;
          vel[j + 1] = -tangent.y * push + normal.y * side;
          vel[j + 2] = (Math.random() - 0.5) * 0.5;
        }
      } else {
        const j = i * 3;
        wakePos[j] += vel[j] * dt;
        wakePos[j + 1] += vel[j + 1] * dt;
        wakePos[j + 2] += vel[j + 2] * dt;
        const drag = 1 - 1.6 * dt;
        vel[j] *= drag;
        vel[j + 1] *= drag;
        vel[j + 2] *= drag;
      }
    }
    art.wake.position.needsUpdate = true;
    art.wake.life.needsUpdate = true;
  }
  // The cash-out ring, where the win was booked.
  art.marker.visible = art.markerGlow.visible = s.cashProgress !== null;
  if (s.cashProgress !== null) {
    path.at(s.cashProgress, art.marker.position);
    art.markerGlow.position.copy(art.marker.position);
    art.markerGlow.material.opacity = s.reduced ? 0.5 : 0.4 + Math.sin(s.now / 220) * 0.15;
  }
  // The burst: a flash that blows out and fades, a shockwave ring, sparks on the tangent.
  const bursting = s.finished;
  art.flash.visible = art.fire.visible = art.shock.visible = art.sparks.points.visible = bursting;
  if (bursting) {
    const palette = s.atCap ? BURST_PALETTE.max : BURST_PALETTE.crash;
    art.flash.material.color.copy(palette.flash);
    art.fire.material.color.copy(palette.fire);
    art.shock.material.color.copy(palette.shock);
    art.sparks.points.material.uniforms.uBright.value.copy(palette.bright);
    art.sparks.points.material.uniforms.uDim.value.copy(palette.dim);
    // The crown at the ceiling keeps ringing while the plate is read; a crash burns out once.
    const t = s.reduced ? 0.55 : s.atCap ? s.burst - Math.floor(s.burst) : Math.min(1, s.burst);
    const quick = Math.min(1, t * 1.8);
    art.flash.position.copy(head);
    art.flash.scale.setScalar(0.8 + quick * 3.8);
    art.flash.material.opacity = (1 - quick) ** 1.3;
    art.fire.position.copy(head);
    art.fire.scale.setScalar(0.9 + t * 2.4);
    art.fire.material.opacity = (1 - t) ** 0.9 * 0.9;
    art.shock.position.copy(head);
    art.shock.scale.setScalar(0.8 + t * 4.8);
    art.shock.material.opacity = (1 - t) ** 0.9;
    const eased = 1 - (1 - t) ** 2;
    const sparkPos = art.sparks.position.array as Float32Array;
    const sparkLife = art.sparks.life.array as Float32Array;
    const fan = art.sparkFan;
    for (let i = 0; i < SPARKS; i++) {
      const f = i * 4,
        reach = fan[f + 3] * eased;
      sparkPos[i * 3] = head.x + (tangent.x * fan[f] + normal.x * fan[f + 1]) * reach;
      sparkPos[i * 3 + 1] =
        head.y + (tangent.y * fan[f] + normal.y * fan[f + 1]) * reach - 0.8 * t * t;
      sparkPos[i * 3 + 2] = fan[f + 2] * reach;
      sparkLife[i] = Math.max(0, 1 - t * (0.85 + hash(i, 17) * 0.4));
    }
    art.sparks.position.needsUpdate = true;
    art.sparks.life.needsUpdate = true;
  }
  // The sky: stars drift against the flight, faster as it climbs; the nebula breathes.
  if (!s.reduced) {
    const seconds = s.now / 1000;
    const rush = 1 + s.progress * 2.2;
    const dtSeconds = s.dt / 1000;
    art.far.material.uniforms.uTime.value = seconds;
    art.near.material.uniforms.uTime.value = seconds;
    art.far.material.uniforms.uDrift.value.x -= 0.18 * rush * dtSeconds;
    art.far.material.uniforms.uDrift.value.y -= 0.05 * rush * dtSeconds;
    art.near.material.uniforms.uDrift.value.x -= 0.55 * rush * dtSeconds;
    art.near.material.uniforms.uDrift.value.y -= 0.16 * rush * dtSeconds;
    art.sky.material.uniforms.uTime.value = seconds;
    art.nebula.forEach((wash, i) => {
      wash.position.x += Math.sin(seconds * 0.05 + i) * 0.004;
    });
  }
}

export default function CrashCurve(props: CrashCurveProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const glass = useRef<SVGSVGElement>(null);
  const frameNode = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  /** The hero's text node, written by the frame loop while the round is open. */
  const ticker = useRef<HTMLDivElement>(null);
  /** The plate over a booked flight, shown by the frame loop once the replay reaches the crash. */
  const plate = useRef<HTMLDivElement>(null);
  /** The last figure the loop printed, so a re-render prints the same one rather than an older one. */
  const clockCents = useRef(100);
  const [reduced] = useState(prefersReducedMotion);
  const latest = useRef(props);
  latest.current = props;
  /**
   * The beats this scene has already sounded. Held outside the frame loop so
   * a resize, which rebuilds the loop, never sounds a finished round again.
   * It starts at the phase the scene was mounted in: a round that was already
   * over when the scene appeared is not announced as if it had just happened.
   */
  const sounded = useRef(props.phase);
  /** Read by the frame loop: a scene that cannot draw still owes its beats. */
  const failedRef = useRef(false);
  const width = props.width ?? 360;
  const height = props.height ?? 300;
  failedRef.current = failed;
  useEffect(() => {
    if (failed && (props.phase === 'cashed' || props.phase === 'crashed'))
      latest.current.onSettled?.();
  }, [failed, props.phase]);
  useEffect(() => {
    if (!canvas.current || !glass.current) return;
    let kit: ReturnType<typeof gameRenderer> | null = null;
    try {
      kit = gameRenderer(canvas.current, width, height);
      setFailed(false);
    } catch (e) {
      setFailed(true);
      reportError(e, 'CrashCurve.renderer');
    }
    // The glass is placed by the camera the scene renders with. Without a
    // renderer the same camera still places the axes over a dark frame, so the
    // figure and its lines survive a lost WebGL context.
    const camera = kit?.camera ?? new THREE.PerspectiveCamera(38, width / height, 0.1, 150);
    camera.position.set(0, 3.5, 12);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const path = flightPath(width / height);
    // The camera pushes in along its line to the launch point, so the launch
    // line projects to the same pixel at every push and only the climb grows.
    const cameraHome = camera.position.clone();
    let push = 0;
    const surface = kit?.renderer.domElement ?? null;
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    const restored = () => setFailed(false);
    surface?.addEventListener('webglcontextlost', lost);
    surface?.addEventListener('webglcontextrestored', restored);
    const art = kit ? dressScene(kit.scene, path, height) : null;
    const marks = dressGlass(glass.current);
    const scratch = [
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
      new THREE.Vector3(),
    ];
    let raf = 0,
      last = 0,
      previousPhase: CrashPhase = 'idle',
      notified = false,
      plateShown = false,
      revealedFor = 0,
      axisLog = 0,
      clockShown = -1,
      engine = false;
    let lastVisibleFrame: number | null = null;
    /** The engine voice ends with the flight, the loop or the visible tab. */
    const silenceEngine = (fadeSec: number) => {
      if (!engine) return;
      engine = false;
      soundService.stopCrashEngine(fadeSec);
    };
    // Hidden: the loop is cancelled outright, not merely skipped. Shown again:
    // it resumes from the next frame with no visible time charged for the gap.
    const visibilityChanged = () => {
      lastVisibleFrame = null;
      if (document.hidden) {
        silenceEngine(0.05);
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const speed = getAnimationSpeed();
    const toScreen = (progress: number): [number, number] => {
      const s = path.at(progress, scratch[4]).project(camera);
      return [((s.x + 1) / 2) * width, ((1 - s.y) / 2) * height];
    };
    const draw = (now: number) => {
      if (document.hidden) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(draw);
      if (now - last < (reduced ? 180 : 30)) return;
      last = now;
      const visibleDelta = lastVisibleFrame === null ? 0 : now - lastVisibleFrame;
      lastVisibleFrame = now;
      const p = latest.current;
      if (p.phase !== previousPhase) {
        previousPhase = p.phase;
        revealedFor = 0;
        notified = false;
        plateShown = false;
      } else revealedFor += visibleDelta;
      const elapsed =
        p.replayElapsedMs ??
        (p.startedAtLocalMs === null ? 0 : Math.max(0, performance.now() - p.startedAtLocalMs));
      const current =
        p.phase === 'open'
          ? crashMultiplierCents(p.growthK, elapsed, p.capCents)
          : (p.finalCents ?? 100);
      if (p.phase === 'open') p.onTick?.(current);
      // The hero is written here every time its figure moves, in every phase,
      // so the text node always agrees with what React last rendered for it.
      const printed = heroFigure(p, current);
      if (printed !== clockShown) {
        clockShown = printed;
        if (p.phase === 'open') clockCents.current = printed;
        if (ticker.current) {
          ticker.current.textContent = tickerLabel(printed);
          ticker.current.dataset.heat = tickerHeat(printed);
        }
      }
      // Booked at the ceiling: there is nothing above it to reveal, so the
      // replay ends at the cap and the flight is crowned instead of crashed.
      const atCap = p.phase === 'cashed' && (p.cashoutCents ?? 0) >= p.capCents;
      const target =
        p.phase === 'cashed'
          ? Math.min(p.crashCents ?? p.finalCents ?? 100, atCap ? p.capCents : Infinity)
          : (p.finalCents ?? current);
      const replay =
        p.phase === 'cashed'
          ? reduced
            ? 1
            : Math.max(0, Math.min(1, (revealedFor - 800) / (2600 * speed)))
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
      // The axis follows the flight instead of jumping to it: a short glide
      // whenever the scale has to grow, immediate under reduced motion and
      // between rounds.
      const wantLog = Math.max(Math.log(4), Math.log(Math.max(shown, target) / 100) * 1.12);
      if (reduced || axisLog === 0 || wantLog < axisLog || p.phase === 'idle') axisLog = wantLog;
      else
        axisLog += (wantLog - axisLog) * (1 - Math.exp(-visibleDelta / (AXIS_FOLLOW_MS * speed)));
      const maxLog = axisLog;
      const progressOf = (cents: number) => Math.log(Math.max(100, cents) / 100) / maxLog;
      const progress = p.phase === 'idle' ? 0.14 : Math.min(0.92, progressOf(shown));
      const finished = p.phase === 'crashed' || (p.phase === 'cashed' && replay === 1);
      // The camera: a gentle push-in with the multiplier, glided like the
      // axis while it is far from its goal and walked the last of the way at
      // a steady pace, so it arrives exactly and then holds still. Snapped
      // under reduced motion and between rounds.
      const wantPush =
        p.phase === 'idle'
          ? 0
          : CAMERA_PUSH *
            THREE.MathUtils.clamp(Math.log(Math.max(100, shown) / 100) / Math.log(20), 0, 1);
      if (reduced || p.phase === 'idle') push = wantPush;
      else {
        const gap = wantPush - push;
        const glide = gap * (1 - Math.exp(-visibleDelta / (CAMERA_FOLLOW_MS * speed)));
        const pace = (CAMERA_PUSH / (1400 * speed)) * visibleDelta;
        push += Math.abs(glide) > pace ? glide : Math.sign(gap) * Math.min(Math.abs(gap), pace);
      }
      camera.position.copy(path.launch).sub(cameraHome).multiplyScalar(push).add(cameraHome);
      camera.updateMatrixWorld();
      if (art) {
        const burstAfter = p.phase === 'cashed' ? 800 + 2600 * speed : 0;
        paintScene(
          art,
          path,
          {
            now,
            dt: visibleDelta,
            phase: p.phase,
            progress,
            shownCents: shown,
            finished,
            burst: (revealedFor - burstAfter) / (1200 * speed),
            cashProgress:
              p.phase === 'cashed' ? Math.min(0.92, progressOf(p.cashoutCents ?? 100)) : null,
            atCap,
            reduced,
            speed,
          },
          scratch
        );
      }
      // ── The glass ──────────────────────────────────────────────────────
      const [, y0] = toScreen(0),
        [, y1] = toScreen(1);
      // Lines for every tick inside the axis. Labels: 1.00x always prints (it
      // is the launch line), and going up from it a label prints only where it
      // has room under the one below, so the low ticks never overprint once
      // the axis is large.
      let labelCeiling = Infinity;
      for (let i = 0; i < MULTIPLIER_TICKS.length; i++) {
        const cents = MULTIPLIER_TICKS[i];
        const q = progressOf(cents);
        if (q > 1) {
          hide(marks.grid[i]);
          continue;
        }
        const [, y] = toScreen(q);
        place(marks.grid[i], 6, y, width - 6, y, 8, y - 4, tickerLabel(cents));
        const crowded = labelCeiling - y < TICK_LABEL_GAP;
        marks.grid[i].text.setAttribute('visibility', crowded ? 'hidden' : 'visible');
        if (!crowded) labelCeiling = y;
      }
      const span = maxLog / Math.max(1e-6, p.growthK);
      const step =
        SECOND_STEPS.find((s) => span / s <= SECOND_TICKS - 2) ??
        SECOND_STEPS[SECOND_STEPS.length - 1];
      marks.seconds.forEach((mark, i) => {
        const t = (i + 1) * step;
        const q = (p.growthK * t) / maxLog;
        if (q > 1) hide(mark);
        else {
          const [x] = toScreen(q);
          place(mark, x, height - 15, x, height - 10, x, height - 3, `${t}s`);
        }
      });
      // The cap, drawn where the flight would stop, once the axis reaches it.
      if (p.capCents > 100 && progressOf(p.capCents) <= 1) {
        const [, y] = toScreen(progressOf(p.capCents));
        // The label sits at the right edge like the auto line, clear of the hero
        // and of the tick labels on the left; once a round has booked at the
        // cap the cash mark says Max and the line needs no label.
        place(marks.cap, 6, y, width - 6, y, width - 8, y - 4, `Max ${tickerLabel(p.capCents)}`);
        marks.cap.text.setAttribute('visibility', atCap ? 'hidden' : 'visible');
      } else hide(marks.cap);
      const auto = p.autoCashoutCents;
      if (auto && auto > 100 && progressOf(auto) <= 1) {
        const [, y] = toScreen(progressOf(auto));
        place(marks.auto, 6, y, width - 6, y, width - 8, y - 4, `Auto ${tickerLabel(auto)}`);
      } else hide(marks.auto);
      const floor = floorCents(p.minimumPayoutChips, p.betChips);
      let floorY: number | null = null;
      if (floor !== null) {
        if (floor >= 100) {
          const q = progressOf(floor);
          if (q <= 1) floorY = toScreen(q)[1];
        } else {
          // Below the launch line the axis is extended at its own scale; the
          // floor is drawn only while that puts it inside the frame.
          const y = y0 + (Math.log(100 / floor) / maxLog) * (y0 - y1);
          if (y <= height - 20) floorY = y;
        }
      }
      if (floorY !== null && p.minimumPayoutChips)
        place(
          marks.floor,
          6,
          floorY,
          width - 6,
          floorY,
          width - 8,
          floorY - 4,
          `Guaranteed ${gameChips(p.minimumPayoutChips)} Chips`
        );
      else hide(marks.floor);
      const [hx, hy] = toScreen(progress);
      if (p.phase === 'open') pin(marks.head, hx, hy, '', hx, hy);
      else unpin(marks.head);
      if (p.phase === 'cashed') {
        const cashed = p.cashoutCents ?? 100;
        const [cx, cy] = toScreen(Math.min(0.92, progressOf(cashed)));
        pin(
          marks.cash,
          cx,
          cy,
          atCap ? `Max ${tickerLabel(p.capCents)}` : `Cashed ${tickerLabel(cashed)}`,
          cx,
          cy - 12
        );
      } else unpin(marks.cash);
      if (finished && !atCap)
        pin(
          marks.crash,
          hx,
          hy,
          p.phase === 'cashed' ? `Crashed ${tickerLabel(target)}` : '',
          hx,
          hy - 16
        );
      else unpin(marks.crash);
      if (frameNode.current && frameNode.current.dataset.max !== String(atCap && finished))
        frameNode.current.dataset.max = String(atCap && finished);
      // The plate over a booked flight comes up the moment the replay reaches
      // the crash point, once per round, without a render.
      if (p.phase === 'cashed' && finished && !plateShown && plate.current) {
        plateShown = true;
        plate.current.dataset.shown = 'true';
      }
      const submitted = kit ? kit.render() : false;
      /* THE SOUND IS ON THIS FRAME'S CLOCK (2026-09-26). The engine is one
         voice for the whole flight, steered to the figure this frame printed;
         it stops on the frame the round stops. A terminal beat sounds on the
         frame that shows it (the red flash, or the cash marker, which reads
         "Max" for a round booked at the cap, so that booking gets the gold
         fanfare instead of the ordinary sting), and a scene that cannot draw
         still owes it on the same frame. */
      if (p.phase === 'open') {
        engine = true;
        soundService.driveCrashEngine(current);
      } else silenceEngine(p.phase === 'crashed' ? 0.03 : 0.25);
      if (sounded.current !== p.phase && (submitted || !kit || failedRef.current)) {
        sounded.current = p.phase;
        if (p.phase === 'crashed') soundService.playCrashExplosion(speed);
        else if (p.phase === 'cashed' && atCap) soundService.playCrashMax(speed);
        else if (p.phase === 'cashed')
          soundService.playBonusBooked((p.cashoutCents ?? p.finalCents ?? 100) / 100);
      }
      const terminalComplete =
        finished &&
        (reduced || revealedFor >= (p.phase === 'cashed' ? 800 + 2600 * speed : 1200 * speed));
      if (submitted && terminalComplete && !notified) {
        notified = true;
        p.onSettled?.();
      }
    };
    raf = requestAnimationFrame(draw);
    const glassNode = glass.current;
    return () => {
      cancelAnimationFrame(raf);
      silenceEngine(0.05);
      document.removeEventListener('visibilitychange', visibilityChanged);
      surface?.removeEventListener('webglcontextlost', lost);
      surface?.removeEventListener('webglcontextrestored', restored);
      kit?.cleanup();
      while (glassNode.firstChild) glassNode.removeChild(glassNode.firstChild);
    };
  }, [width, height, reduced]);
  const heroCents = heroFigure(props, clockCents.current);
  const reveal =
    props.phase === 'cashed'
      ? wouldHaveGone(
          props.cashoutCents ?? 100,
          props.crashCents ?? props.finalCents ?? 100,
          props.capCents
        )
      : null;
  return (
    <div className={styles.wrap} data-motion="keep">
      <div
        ref={frameNode}
        className={styles.frame}
        data-phase={props.phase}
        data-reduced={reduced ? 'true' : undefined}
        data-compact={height < 360 ? 'true' : undefined}
        style={{ width, height }}
      >
        <canvas
          ref={canvas}
          className={styles.canvas}
          style={{ width, height, display: failed ? 'none' : undefined }}
          role="img"
          aria-label="Crash Curve"
        />
        <svg
          ref={glass}
          className={styles.glass}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
        />
        <div
          ref={ticker}
          className={styles.ticker}
          data-phase={props.phase}
          data-heat={tickerHeat(heroCents)}
          style={{ fontSize: Math.round(Math.max(40, Math.min(112, width * 0.17))) }}
        >
          {tickerLabel(heroCents)}
        </div>
        <div className={styles.cap} data-cap={props.capCents}>
          Max <b>{tickerLabel(props.capCents)}</b>
        </div>
        <div className={styles.launchLine} data-attract="launch-line" aria-hidden="true" />
        {reveal ? (
          <div
            ref={plate}
            className={styles.reveal}
            data-reveal="would-have-gone"
            data-reduced={reduced ? 'true' : undefined}
            style={
              reduced
                ? undefined
                : { animationDuration: `${Math.round(REVEAL_IN_MS * getAnimationSpeed())}ms` }
            }
          >
            <span className={styles.revealTitle}>{reveal.title}</span>{' '}
            <strong className={styles.revealFigure}>{reveal.figure}</strong>{' '}
            <span className={styles.revealSub}>{reveal.sub}</span>
          </div>
        ) : null}
        {props.phase === 'crashed' ? (
          <div
            className={styles.flash}
            data-reduced={reduced ? 'true' : undefined}
            style={
              reduced
                ? undefined
                : { animationDuration: `${Math.round(CRASH_FLASH_MS * getAnimationSpeed())}ms` }
            }
          />
        ) : null}
        {failed ? (
          <p className={`sc-copy ${styles.notice}`}>
            The 3D Scene Is Unavailable. Your Live Multiplier And Cash Out Controls Still Work.
          </p>
        ) : null}
      </div>
    </div>
  );
}
