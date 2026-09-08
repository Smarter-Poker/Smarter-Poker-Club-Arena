import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './surrender.css';
// Dedicated recorded cues still pending: flag_flap_loop, sad_trombone_short.
export const spec: ThrowableSpec = {
  id: 'surrender',
  name: 'Surrender',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 600, marker: 'flag-rise' },
    { at: 1000, marker: 'flag-held' },
    { at: 1200, marker: 'eyes-droop' },
    { at: 1700, marker: 'sweat-drop' },
    { at: 2800, marker: 'flag-wave' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [{ at: 600, sample: 'whoosh_low', gain: 0.17 }],
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
      src="surrender"
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
      <g className="thr-surrender__pop">
        <g className="thr-surrender__flag-rise">
          <g className="thr-surrender__flag-wave">
            <Tile tile={2} x={20} y={-125} width={100} height={150} />
          </g>
        </g>
        <g className="thr-surrender__base">
          <Tile tile={0} x={-65} y={-65} width={130} height={130} />
        </g>
        <g className="thr-surrender__droop">
          <Tile tile={1} x={-65} y={-65} width={130} height={130} />
        </g>
        <g className="thr-surrender__sweat">
          <Tile tile={3} x={25} y={-25} width={35} height={35} />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
