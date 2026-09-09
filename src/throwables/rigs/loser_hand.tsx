import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './loser_hand.css';
// Dedicated recorded cues still pending: voice_oooh, voice_loser_x3.
export const spec: ThrowableSpec = {
  id: 'loser_hand',
  name: 'Loser Hand',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3967 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 600, marker: 'oooh' },
    { at: 800, marker: 'forehead-L' },
    { at: 1800, marker: 'word-one' },
    { at: 2100, marker: 'mouth-open' },
    { at: 2600, marker: 'word-two' },
    { at: 3400, marker: 'word-three' },
    { at: 4300, marker: 'cut' },
  ],
  audio: [{ at: 433, sample: 'pop_soft', gain: 0.35 }],
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
      src="loser_hand"
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
      <g className="thr-loser_hand__pop">
        <g className="thr-loser_hand__rock">
          <g className="thr-loser_hand__base">
            <Tile tile={0} x={-60} y={-60} width={120} height={120} />
          </g>
          <g className="thr-loser_hand__oooh-end">
            <g className="thr-loser_hand__oooh">
              <Tile tile={1} x={-60} y={-60} width={120} height={120} />
            </g>
          </g>
          <g className="thr-loser_hand__talk">
            <Tile tile={1} x={-60} y={-60} width={120} height={120} />
            <g className="thr-loser_hand__mouth">
              <Tile tile={2} x={-60} y={-60} width={120} height={120} />
            </g>
          </g>
          <g className="thr-loser_hand__hand">
            <Tile tile={3} x={-55} y={-102} width={100} height={100} />
          </g>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
