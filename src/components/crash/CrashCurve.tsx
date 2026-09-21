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
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { gameRenderer, metal, solid } from '../games/sceneKit';
import { prefersReducedMotion, getAnimationSpeed } from '../../utils/animationSpeed';
import { crashMultiplierCents } from '../../utils/diamondGamesFairness';
import { gameChips } from '../../utils/bonusGameBudget';
import { reportError } from '../../utils/errorReporter';
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
/** The multiplier lines the glass can print; the ones inside the axis are shown. */
const MULTIPLIER_TICKS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
/** Seconds tick spacing candidates: the smallest that keeps the axis to a handful of ticks. */
const SECOND_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300];
const SECOND_TICKS = 8;
/** The red wash on a crash, before Animation Speed. */
export const CRASH_FLASH_MS = 420;
/** How closely the axis follows the flight: a time constant, before Animation Speed. */
const AXIS_FOLLOW_MS = 180;
/** The flight path in scene units, by progress 0..1 along it. */
const point = (v: number) => new THREE.Vector3(-3.8 + v * 7.1, -1.55 + v * v * 3.5, 0);
const SVG = 'http://www.w3.org/2000/svg';

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
  for (const side of [-1, 1]) {
    const engine = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.95, 24), chrome);
    engine.rotation.z = -Math.PI / 2;
    engine.position.set(-0.35, -0.18, side * 0.65);
    group.add(engine);
    const nozzle = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.025, 8, 24), dark);
    nozzle.rotation.y = Math.PI / 2;
    nozzle.position.set(-0.83, -0.18, side * 0.65);
    group.add(nozzle);
    for (let i = 0; i < 4; i++)
      solid(group, dark, [0.09, 0.025, 0.1], [0.05 - i * 0.25, 0.325, side * 0.17], 0.009);
    const wingLight = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 8),
      new THREE.MeshBasicMaterial({ color: side < 0 ? 0xff536a : 0x7cffe1 })
    );
    wingLight.position.set(-0.85, 0.08, side * 1.53);
    group.add(wingLight);
  }
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

/** The space, the planet, the jet, its trail, the cash-out ring and the burst. */
function dressScene(scene: THREE.Scene) {
  scene.fog = new THREE.FogExp2(0x070b10, 0.006);
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
    new THREE.PointsMaterial({ color: 0xc9e8ff, size: 0.085, transparent: true, opacity: 0.7 })
  );
  scene.add(stars);
  // A lit planet, atmosphere and distant orbital rings give the flight depth.
  const planet = new THREE.Group();
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(12, 64, 40),
    new THREE.ShaderMaterial({
      vertexShader: `varying vec3 surface; varying vec3 worldNormal; void main(){surface=position;worldNormal=normalize(mat3(modelMatrix)*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `
          varying vec3 surface; varying vec3 worldNormal;
          float hash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
          float noise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);}
          float terrain(vec3 p){float n=0.0,a=0.5;for(int i=0;i<5;i++){n+=a*noise(p);p=p*2.03+vec3(1.7,9.2,4.1);a*=0.5;}return n;}
          void main(){
            vec3 n=normalize(surface);float land=terrain(n*4.0);float coast=smoothstep(.49,.54,land);
            vec3 ocean=mix(vec3(.008,.04,.11),vec3(.015,.21,.35),smoothstep(.34,.53,land));
            vec3 ground=mix(vec3(.04,.13,.11),vec3(.27,.31,.19),smoothstep(.55,.68,land));
            vec3 color=mix(ocean,ground,coast);
            float clouds=smoothstep(.57,.69,terrain(n*10.0+vec3(terrain(n*3.0)*2.0)));
            color=mix(color,vec3(.8,.89,.96),clouds*.86);
            float light=max(0.0,dot(normalize(worldNormal),normalize(vec3(-.65,.6,.9))));
            color*=.12+light*1.15;
            float rim=pow(1.0-max(0.0,dot(normalize(worldNormal),vec3(0,0,1))),4.0);
            color+=vec3(.01,.12,.3)*rim;
            gl_FragColor=vec4(color,1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
          }`,
    })
  );
  planet.add(globe);
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(12.18, 64, 40),
    new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.BackSide,
      depthWrite: false,
      vertexShader: `varying vec3 normalView; varying vec3 viewDirection; void main(){ vec4 p=modelViewMatrix*vec4(position,1.0); normalView=normalize(normalMatrix*normal); viewDirection=normalize(-p.xyz); gl_Position=projectionMatrix*p; }`,
      fragmentShader: `varying vec3 normalView; varying vec3 viewDirection; void main(){ float rim=pow(1.0-abs(dot(normalView,viewDirection)),2.5); gl_FragColor=vec4(0.12,0.6,1.0,rim*0.85); }`,
      blending: THREE.AdditiveBlending,
    })
  );
  planet.add(atmosphere);
  planet.position.set(2, -15, -16);
  scene.add(planet);
  const orbit = new THREE.Mesh(
    new THREE.TorusGeometry(18, 0.025, 8, 160),
    new THREE.MeshBasicMaterial({ color: 0x57b9ff, transparent: true, opacity: 0.4 })
  );
  orbit.position.copy(planet.position);
  orbit.rotation.x = 1.15;
  scene.add(orbit);
  const sun = new THREE.DirectionalLight(0xffd6a0, 2.5);
  sun.position.set(-8, 4, 5);
  scene.add(sun);
  const flight = jet();
  scene.add(flight.group);
  flight.group.scale.setScalar(1.05);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(96 * 3), 3));
  const trailMat = new THREE.LineBasicMaterial({
    color: 0x39b6ff,
    transparent: true,
    opacity: 0.85,
  });
  const trail = new THREE.Line(trailGeo, trailMat);
  const wake = new THREE.Points(
    trailGeo,
    new THREE.PointsMaterial({
      color: 0x5ad5ff,
      size: 0.1,
      transparent: true,
      opacity: 0.65,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  scene.add(wake);
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
  return { stars, planet, orbit, flight, trailGeo, trailMat, marker, burstGeometry, burst };
}

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
  const auto = markIn(group('auto', styles.autoLine), { 'data-line': 'auto' });
  const floor = markIn(group('floor', styles.floorLine), { 'data-line': 'floor' });
  const head = spotIn(group('head', styles.headMark), 'head', 7);
  const cash = spotIn(group('cash', styles.cashMark), 'cash', 5.5);
  const crash = spotIn(group('crash', styles.crashMark), 'crash', 9);
  return { grid, seconds, auto, floor, head, cash, crash };
}

export default function CrashCurve(props: CrashCurveProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const glass = useRef<SVGSVGElement>(null);
  const [failed, setFailed] = useState(false);
  /** The hero's text node, written by the frame loop while the round is open. */
  const ticker = useRef<HTMLDivElement>(null);
  /** The last figure the loop printed, so a re-render prints the same one rather than an older one. */
  const clockCents = useRef(100);
  const [reduced] = useState(prefersReducedMotion);
  const latest = useRef(props);
  latest.current = props;
  const width = props.width ?? 360;
  const height = props.height ?? 300;
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
    const surface = kit?.renderer.domElement ?? null;
    const lost = (event: Event) => {
      event.preventDefault();
      setFailed(true);
    };
    const restored = () => setFailed(false);
    surface?.addEventListener('webglcontextlost', lost);
    surface?.addEventListener('webglcontextrestored', restored);
    const art = kit ? dressScene(kit.scene) : null;
    const marks = dressGlass(glass.current);
    let raf = 0,
      last = 0,
      previousPhase: CrashPhase = 'idle',
      notified = false,
      revealedFor = 0,
      axisLog = 0,
      clockShown = -1;
    let lastVisibleFrame: number | null = null;
    // Hidden: the loop is cancelled outright, not merely skipped. Shown again:
    // it resumes from the next frame with no visible time charged for the gap.
    const visibilityChanged = () => {
      lastVisibleFrame = null;
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const speed = getAnimationSpeed();
    const toScreen = (progress: number): [number, number] => {
      const s = point(progress).project(camera);
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
      const target =
        p.phase === 'cashed' ? (p.crashCents ?? p.finalCents ?? 100) : (p.finalCents ?? current);
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
      const head = point(progress);
      const finished = p.phase === 'crashed' || (p.phase === 'cashed' && replay === 1);
      if (art) {
        art.flight.group.position.copy(head);
        art.flight.group.rotation.set(
          0.08,
          0.08,
          Math.atan(progress * 0.85) +
            (p.phase === 'idle' && !reduced ? Math.sin(now / 900) * 0.035 : 0)
        );
        art.flight.exhaust.scale.y = reduced ? 1 : 0.8 + Math.sin(now / 75) * 0.2;
        art.flight.group.visible = !finished;
        art.burst.visible = finished;
        const values = art.trailGeo.attributes.position.array as Float32Array;
        for (let i = 0; i < 96; i++) {
          const v = point((progress * i) / 95);
          values.set([v.x, v.y, v.z], i * 3);
        }
        art.trailGeo.attributes.position.needsUpdate = true;
        art.trailMat.color.setHex(finished ? 0xff6152 : 0x39b6ff);
        art.marker.visible = p.phase === 'cashed';
        if (art.marker.visible)
          art.marker.position.copy(point(Math.min(0.92, progressOf(p.cashoutCents ?? 100))));
        if (finished) {
          const positions = art.burstGeometry.attributes.position.array as Float32Array;
          const t = reduced ? 0.55 : Math.min(1, revealedFor / (1200 * speed));
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
          art.burstGeometry.attributes.position.needsUpdate = true;
        }
        if (!reduced) {
          art.stars.position.z = (now / 800) % 6;
          art.planet.rotation.y = now / 70000;
          art.orbit.rotation.z = now / 16000;
        }
      }
      // ── The glass ──────────────────────────────────────────────────────
      const [, y0] = toScreen(0),
        [, y1] = toScreen(1);
      MULTIPLIER_TICKS.forEach((cents, i) => {
        const q = progressOf(cents);
        if (q > 1) hide(marks.grid[i]);
        else {
          const [, y] = toScreen(q);
          place(marks.grid[i], 6, y, width - 6, y, 8, y - 4, tickerLabel(cents));
        }
      });
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
        pin(marks.cash, cx, cy, `Cashed ${tickerLabel(cashed)}`, cx, cy - 12);
      } else unpin(marks.cash);
      if (finished)
        pin(
          marks.crash,
          hx,
          hy,
          p.phase === 'cashed' ? `Crashed ${tickerLabel(target)}` : '',
          hx,
          hy - 16
        );
      else unpin(marks.crash);
      const submitted = kit ? kit.render() : false;
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
      document.removeEventListener('visibilitychange', visibilityChanged);
      surface?.removeEventListener('webglcontextlost', lost);
      surface?.removeEventListener('webglcontextrestored', restored);
      kit?.cleanup();
      while (glassNode.firstChild) glassNode.removeChild(glassNode.firstChild);
    };
  }, [width, height, reduced]);
  const heroCents = heroFigure(props, clockCents.current);
  return (
    <div className={styles.wrap} data-motion="keep">
      <div
        className={styles.frame}
        data-phase={props.phase}
        data-reduced={reduced ? 'true' : undefined}
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
