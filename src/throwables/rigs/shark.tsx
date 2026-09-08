import { preloadThrowableCues } from '../cues';
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import './shark.css';
export const spec: ThrowableSpec = {
  id: 'shark',
  name: 'Shark',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 267, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: true, ms: 4033 },
  beats: [
    { at: 267, marker: 'arrive' },
    { at: 433, marker: 'overshoot' },
    { at: 500, marker: 'chew' },
    { at: 1700, marker: 'cutlery-bob' },
    { at: 3000, marker: 'final-chews' },
    { at: 3833, marker: 'settle' },
    { at: 4300, marker: 'cut' },
  ],
  // Organic voice recordings are tracked separately from visual coverage.
  audio: [{ at: 267, sample: 'thump_soft' }],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite src="shark" rect={[8, 20, 638, 590]} x={-30} y={-30} width={60} height={60} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-shark__pop">
        <g className="thr-shark__bite-window">
          <g className="thr-shark__pose0">
            <AtlasSprite
              src="shark"
              rect={[8, 20, 638, 590]}
              x={-60}
              y={-60}
              width={120}
              height={120}
            />
          </g>
          <g className="thr-shark__pose1">
            <AtlasSprite
              src="shark"
              rect={[653, 20, 601, 590]}
              x={-60}
              y={-60}
              width={120}
              height={120}
            />
          </g>
          <g className="thr-shark__pose2">
            <AtlasSprite
              src="shark"
              rect={[8, 620, 638, 620]}
              x={-60}
              y={-60}
              width={120}
              height={120}
            />
          </g>
          <g className="thr-shark__pose3">
            <AtlasSprite
              src="shark"
              rect={[653, 650, 601, 604]}
              x={-60}
              y={-60}
              width={120}
              height={120}
            />
          </g>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
