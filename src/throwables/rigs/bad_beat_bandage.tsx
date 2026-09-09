import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './bad_beat_bandage.css';
export const spec: ThrowableSpec = {
  id: 'bad_beat_bandage',
  name: 'Bad Beat Bandage',
  tier: 'premium',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: false, ms: 3667 },
  beats: [
    { at: 333, marker: 'arrival' },
    { at: 900, marker: 'wrap-one' },
    { at: 1200, marker: 'wrap-two' },
    { at: 1500, marker: 'wrap-three' },
    { at: 1800, marker: 'ice-lands' },
    { at: 2800, marker: 'ambulance-passes' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 600, sample: 'whoosh_low', gain: 0.18 },
    { at: 900, sample: 'whoosh_low', gain: 0.18 },
    { at: 1200, sample: 'whoosh_low', gain: 0.18 },
    { at: 1800, sample: 'thump_soft', gain: 0.35 },
    { at: 2200, sample: 'ambulance_siren_small', gain: 0.55 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
const RECTS: [number, number, number, number][] = [
  [260, 390, 310, 100],
  [720, 107, 434, 459],
  [82, 706, 545, 419],
  [627, 776, 469, 317],
];
function Tile({
  tile,
  x,
  y,
  width,
  height,
}: {
  tile: number;
  x: number;
  y: number;
  width: number;
  height: number;
}) {
  return (
    <AtlasSprite
      src="bad_beat_bandage"
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
      <Tile tile={0} x={-55} y={-55} width={110} height={110} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-bad_beat_bandage__wrap0">
        <Tile tile={0} x={-65} y={-45} width={130} height={45} />
      </g>
      <g className="thr-bad_beat_bandage__wrap1">
        <Tile tile={0} x={-65} y={-20} width={130} height={45} />
      </g>
      <g className="thr-bad_beat_bandage__wrap2">
        <Tile tile={0} x={-65} y={5} width={130} height={45} />
      </g>
      <g className="thr-bad_beat_bandage__ice">
        <Tile tile={1} x={-35} y={-90} width={70} height={65} />
      </g>
      <g className="thr-bad_beat_bandage__ambulance">
        <Tile tile={2} x={-45} y={40} width={90} height={60} />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
