import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './facepalm.css';
// Dedicated recorded cues still pending: sigh.
export const spec: ThrowableSpec = {
  id: 'facepalm',
  name: 'Facepalm',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 467, marker: 'wide-eyes' },
    { at: 600, marker: 'hand-rise' },
    { at: 900, marker: 'face-slap' },
    { at: 1400, marker: 'covered-face' },
    { at: 2000, marker: 'eye-peek' },
    { at: 2800, marker: 'head-shake' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [{ at: 900, sample: 'card_slap', gain: 0.3 }],
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
      src="facepalm"
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
      <g className="thr-facepalm__pop">
        <g className="thr-facepalm__shake">
          <g className="thr-facepalm__base">
            <Tile tile={0} x={-65} y={-65} width={130} height={130} />
          </g>
          <g className="thr-facepalm__closed">
            <Tile tile={1} x={-65} y={-65} width={130} height={130} />
          </g>
          <g className="thr-facepalm__peek">
            <Tile tile={3} x={-65} y={-65} width={130} height={130} />
          </g>
          <g className="thr-facepalm__hand">
            <g className="thr-facepalm__peek-hand">
              <Tile tile={2} x={-48} y={-60} width={110} height={140} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
