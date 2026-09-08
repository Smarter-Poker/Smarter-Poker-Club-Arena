import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './sloth.css';
// Dedicated recorded cues still pending: sloth_yawn.
export const spec: ThrowableSpec = {
  id: 'sloth',
  name: 'Sloth',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 4167 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 1500, marker: 'blink-one' },
    { at: 2000, marker: 'sleepy-hold' },
    { at: 2500, marker: 'yawn' },
    { at: 2700, marker: 'yawn-open' },
    { at: 3200, marker: 'yawn-settle' },
    { at: 4000, marker: 'blink-two' },
    { at: 4500, marker: 'cut' },
  ],
  audio: [{ at: 433, sample: 'pop_soft', gain: 0.25 }],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [0, 0, 627, 627],
  [627, 0, 627, 627],
  [0, 627, 627, 627],
  [627, 627, 627, 627],
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
      src="sloth"
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
      <g className="thr-sloth__pop">
        <g className="thr-sloth__drowse">
          <Tile tile={0} x={-57} y={-57} width={114} height={114} />
          <g className="thr-sloth__blink">
            <Tile tile={1} x={-57} y={-57} width={114} height={114} />
          </g>
          <g className="thr-sloth__yawn-end">
            <g className="thr-sloth__yawn">
              <Tile tile={2} x={-57} y={-57} width={114} height={114} />
            </g>
          </g>
          <g className="thr-sloth__sleepy">
            <Tile tile={3} x={-57} y={-57} width={114} height={114} />
          </g>
          <g className="thr-sloth__blink-two">
            <Tile tile={1} x={-57} y={-57} width={114} height={114} />
          </g>
        </g>
        <g className="thr-sloth__badge">
          <text x={34} y={52} fontSize={15} fontWeight={700} fill="#BCE8FF">
            Zzz
          </text>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
