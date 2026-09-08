/** Premium robot character: independently timed expression poses and sound cues.
 * All visual delays are from landing (333 ms); the player owns the clock.
 */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './robot.css';
export const robotSpec: ThrowableSpec = {
  id: 'robot',
  name: 'Robot',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 333, marker: 'neutral' },
    { at: 700, marker: 'scan' },
    { at: 2200, marker: 'short' },
    { at: 2600, marker: 'off' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 700, sample: 'servo_whir' },
    { at: 2200, sample: 'zap_short' },
    { at: 2600, sample: 'power_down' },
  ],
};
preloadThrowableCues(robotSpec.audio.map((c) => c.sample));
const RECTS = [
  [0, 0, 627, 625],
  [627, 0, 627, 625],
  [0, 630, 627, 624],
  [627, 615, 627, 639],
] as const;
function Face({ pose }: { pose: 0 | 1 | 2 | 3 }) {
  return <AtlasSprite src="robot" rect={RECTS[pose]} x={-72} y={-75} width={144} height={150} />;
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <Face pose={0} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-robot__neutral">
        <Face pose={0} />
      </g>
      <g className="thr-robot__scan">
        <Face pose={1} />
      </g>
      <g className="thr-robot__short">
        <Face pose={2} />
      </g>
      <g className="thr-robot__off">
        <Face pose={3} />
      </g>
    </svg>
  );
}
export const robotRig: ThrowableRig = { Projectile, Payload };
