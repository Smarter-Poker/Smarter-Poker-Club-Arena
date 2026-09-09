import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './energy_ball.css';
// Dedicated recorded cues still pending: plasma_hum_loop.
export const spec: ThrowableSpec = {
  id: 'energy_ball',
  name: 'Energy Ball',
  tier: 'premium',
  category: 'special',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 2, anchor: 'face', coversAvatar: true, ms: 3067 },
  beats: [
    { at: 333, marker: 'engulf' },
    { at: 700, marker: 'sphere-grown' },
    { at: 1600, marker: 'arc-crawl' },
    { at: 2800, marker: 'collapse-start' },
    { at: 3050, marker: 'collapse-point' },
    { at: 3100, marker: 'flash' },
    { at: 3175, marker: 'flash-peak' },
    { at: 3400, marker: 'cut' },
  ],
  audio: [
    { at: 333, sample: 'zap_short', gain: 0.25 },
    { at: 700, sample: 'magnet_hum', gain: 0.2 },
    { at: 3100, sample: 'zap_short', gain: 0.5 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [0, 0, 663, 593],
  [663, 0, 664, 593],
  [0, 593, 663, 593],
  [663, 593, 664, 593],
];
function Tile({
  tile,
  x = -65,
  y = -65,
  width = 130,
  height = 130,
}: {
  tile: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  return (
    <AtlasSprite
      src="energy_ball"
      rect={RECTS[tile]}
      sheetSize={[1327, 1186]}
      x={x}
      y={y}
      width={width}
      height={height}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Tile tile={2} x={-135} y={-45} width={120} height={95} />
      <Tile tile={0} x={-65} y={-65} width={130} height={130} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-energy_ball__pop">
        <g className="thr-energy_ball__collapse">
          <g className="thr-energy_ball__sphere-grow">
            <Tile tile={1} x={-175} y={-175} width={350} height={350} />
            <g className="thr-energy_ball__pulse">
              <g className="thr-energy_ball__arcs">
                <Tile tile={1} x={-175} y={-175} width={350} height={350} />
              </g>
            </g>
          </g>
        </g>
        <g className="thr-energy_ball__flash">
          <Tile tile={3} x={-120} y={-120} width={240} height={240} />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
