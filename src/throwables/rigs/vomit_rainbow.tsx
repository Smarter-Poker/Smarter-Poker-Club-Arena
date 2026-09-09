import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './vomit_rainbow.css';
// Dedicated recorded cues still pending: gag, splash_rainbow.
export const spec: ThrowableSpec = {
  id: 'vomit_rainbow',
  name: 'Rainbow Reaction',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 433, marker: 'pop' },
    { at: 600, marker: 'green-spread' },
    { at: 1200, marker: 'green-face' },
    { at: 1300, marker: 'cheeks-puff' },
    { at: 1600, marker: 'rainbow-pour' },
    { at: 2600, marker: 'rainbow-flow' },
    { at: 3600, marker: 'flow-stops' },
    { at: 3800, marker: 'mouth-wipe' },
    { at: 3867, marker: 'wipe-complete' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 1600, sample: 'squirt_start', gain: 0.3 },
    { at: 1800, sample: 'sparkle_bed', gain: 0.18 },
  ],
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
      src="vomit_rainbow"
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
      <g className="thr-vomit_rainbow__pop">
        <g className="thr-vomit_rainbow__base">
          <Tile tile={0} x={-65} y={-65} width={130} height={130} />
        </g>
        <g className="thr-vomit_rainbow__green-end">
          <g className="thr-vomit_rainbow__green">
            <g className="thr-vomit_rainbow__puff">
              <Tile tile={1} x={-65} y={-65} width={130} height={130} />
            </g>
          </g>
        </g>
        <g className="thr-vomit_rainbow__wipe">
          <Tile tile={3} x={-65} y={-65} width={130} height={130} />
        </g>
        <g className="thr-vomit_rainbow__pour-end">
          <g className="thr-vomit_rainbow__pour">
            <g className="thr-vomit_rainbow__flow">
              <Tile tile={2} x={-27} y={18} width={100} height={115} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
