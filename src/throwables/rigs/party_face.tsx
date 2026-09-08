import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './party_face.css';

export const spec: ThrowableSpec = {
  id: 'party_face',
  name: 'Party Face',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 500, marker: 'horn' },
    { at: 633, marker: 'mouth-opens' },
    { at: 1167, marker: 'cheer' },
    { at: 1300, marker: 'eyes-squeeze' },
    { at: 1567, marker: 'streamers' },
    { at: 2000, marker: 'streamer-hold' },
    { at: 4000, marker: 'cut' },
  ],
  // Only the supplied pop is scheduled. Dedicated horn and crowd recordings remain pending.
  audio: [{ at: 500, sample: 'pop_soft', gain: 0.35 }],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Tile({
  tile,
  x = -70,
  y = -85,
  width = 140,
  height = 140,
}: {
  tile: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}) {
  const rects: [number, number, number, number][] = [
    [0, 0, 627, 710],
    [627, 0, 627, 710],
    [0, 710, 670, 544],
    [680, 710, 574, 544],
  ];
  return (
    <AtlasSprite src="party_face" rect={rects[tile]} x={x} y={y} width={width} height={height} />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Tile tile={0} />
    </svg>
  );
}
function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`${uid}mouth`}>
          <rect x={-70} y={14} width={140} height={65} />
        </clipPath>
      </defs>
      <g className="thr-party_face__pop">
        <g className="thr-party_face__streamers">
          <g className="thr-party_face__ribbons">
            <Tile tile={3} x={-35} y={-125} width={145} height={145} />
          </g>
        </g>
        <g className="thr-party_face__neutral">
          <Tile tile={0} />
        </g>
        <g className="thr-party_face__mouth">
          <g className="thr-party_face__mouth-open" clipPath={`url(#${uid}mouth)`}>
            <Tile tile={1} />
          </g>
        </g>
        <g className="thr-party_face__cheer">
          <Tile tile={1} />
        </g>
        <g className="thr-party_face__horn">
          <Tile tile={2} x={-7} y={-24} width={80} height={80} />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
