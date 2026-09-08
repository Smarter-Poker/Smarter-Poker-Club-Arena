import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './sleeping.css';
// Dedicated recorded cues still pending: snore_loop.
export const spec: ThrowableSpec = {
  id: 'sleeping',
  name: 'Sleeping',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 600, marker: 'eyes-close-and-cap' },
    { at: 1200, marker: 'nod-forward' },
    { at: 1500, marker: 'jerk-back' },
    { at: 2000, marker: 'sleep-bubble' },
    { at: 2800, marker: 'bubble-pop' },
    { at: 3500, marker: 'snore-hold' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [{ at: 2800, sample: 'bubble_tick', gain: 0.4 }],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [0, 0, 627, 627],
  [627, 0, 627, 627],
  [0, 627, 700, 627],
  [700, 627, 554, 627],
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
      src="sleeping"
      rect={RECTS[tile]}
      sheetSize={[1254, 1254]}
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
      <Tile tile={0} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-sleeping__pop">
        <g className="thr-sleeping__nod">
          <g className="thr-sleeping__base">
            <Tile tile={0} x={-65} y={-65} width={130} height={130} />
          </g>
          <g className="thr-sleeping__closed">
            <Tile tile={1} x={-65} y={-65} width={130} height={130} />
          </g>
          <g className="thr-sleeping__cap">
            <Tile tile={2} x={-78} y={-112} width={155} height={115} />
          </g>
          <g className="thr-sleeping__bubble">
            <Tile tile={3} x={4} y={-5} width={45} height={45} />
          </g>
        </g>
        <g className="thr-sleeping__zzz">
          <text x={48} y={-48} fill="#BCE8FF" fontSize={20} fontWeight={700}>
            Zzz
          </text>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
