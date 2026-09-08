import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './ok_smug.css';
// Dedicated recorded cues still pending: click_tongue.
export const spec: ThrowableSpec = {
  id: 'ok_smug',
  name: 'Smug OK',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 600, marker: 'OK-rise' },
    { at: 900, marker: 'OK-held' },
    { at: 1500, marker: 'wink' },
    { at: 1600, marker: 'wink-held' },
    { at: 1800, marker: 'wink-settle' },
    { at: 2600, marker: 'hand-pulse' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [{ at: 600, sample: 'chime_shimmer', gain: 0.22 }],
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
      src="ok_smug"
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
      <g className="thr-ok_smug__pop">
        <Tile tile={0} x={-65} y={-65} width={130} height={130} />
        <g className="thr-ok_smug__wink">
          <Tile tile={1} x={-65} y={-65} width={130} height={130} />
        </g>
        <g className="thr-ok_smug__hand-rise">
          <g className="thr-ok_smug__pulse">
            <Tile tile={2} x={28} y={-25} width={82} height={82} />
          </g>
        </g>
        <g className="thr-ok_smug__sparkle">
          <Tile tile={3} x={48} y={-42} width={35} height={35} />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
