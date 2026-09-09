import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './fish.css';
export const spec: ThrowableSpec = {
  id: 'fish',
  name: 'Fish',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.35, anchor: 'face', coversAvatar: true, ms: 3100 },
  beats: [
    { at: 300, marker: 'silent-impact' },
    { at: 333, marker: 'diagonal-rest' },
    { at: 700, marker: 'flop' },
    { at: 1700, marker: 'first-slash' },
    { at: 1967, marker: 'second-slash' },
    { at: 2167, marker: 'red-mark' },
    { at: 2567, marker: 'slide' },
    { at: 3000, marker: 'last-fade' },
    { at: 3400, marker: 'cut' },
  ],
  // Recorded fish flops remain pending; the impact flash is deliberately silent.
  audio: [
    { at: 1700, sample: 'whoosh_low', gain: 0.3 },
    { at: 1967, sample: 'whoosh_low', gain: 0.3 },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function FishPose({ open = false }: { open?: boolean }) {
  return (
    <AtlasSprite
      src="fish"
      rect={open ? [627, 0, 627, 627] : [0, 0, 627, 627]}
      x={-75}
      y={-75}
      width={150}
      height={150}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="scale(.65)">
        <FishPose />
      </g>
    </svg>
  );
}
function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${uid}mark`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#612c28" />
          <stop offset=".5" stopColor="#c65b45" />
          <stop offset="1" stopColor="#6b3029" />
        </linearGradient>
      </defs>
      <g className="thr-fish__face-mark">
        <path d="M-10 -24L15 20L9 16L-14 -18Z" fill={`url(#${uid}mark)`} />
      </g>
      <g className="thr-fish__drop">
        <g className="thr-fish__rest">
          <g transform="translate(0 -18) rotate(-24)">
            <g className="thr-fish__closed">
              <FishPose />
            </g>
            <g className="thr-fish__open">
              <FishPose open />
            </g>
            <g className="thr-fish__gash">
              <path d="M-12 -13L6 10L1 10L-16 -10Z" fill={`url(#${uid}mark)`} />
            </g>
          </g>
        </g>
      </g>
      <g className="thr-fish__flash">
        <AtlasSprite
          src="fish"
          rect={[0, 627, 627, 627]}
          x={-76}
          y={-76}
          width={152}
          height={152}
        />
      </g>
      <g className="thr-fish__slash thr-fish__slash--one">
        <AtlasSprite
          src="fish"
          rect={[627, 627, 627, 627]}
          x={-65}
          y={-65}
          width={130}
          height={130}
        />
      </g>
      <g className="thr-fish__slash thr-fish__slash--two">
        <AtlasSprite
          src="fish"
          rect={[627, 627, 627, 627]}
          x={-65}
          y={-65}
          width={130}
          height={130}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
