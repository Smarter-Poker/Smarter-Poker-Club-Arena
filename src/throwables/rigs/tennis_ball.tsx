/** Bespoke Tennis Ball payload. All CSS times are relative to landing at 200 ms. */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './tennis_ball.css';
export const spec: ThrowableSpec = {
  id: 'tennis_ball',
  name: 'Tennis Ball',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: {
    ms: 200,
    mode: 'straight',
    upright: true,
  },
  arrival: 'blink-pop',
  payload: {
    sizeU: 1.2,
    anchor: 'face',
    coversAvatar: true,
    ms: 3300,
  },
  beats: [
    {
      at: 200,
      marker: 'arrive',
    },
    {
      at: 400,
      marker: 'hit-one',
    },
    {
      at: 700,
      marker: 'hit-two',
    },
    {
      at: 1000,
      marker: 'hit-three',
    },
    {
      at: 1100,
      marker: 'red-mark',
    },
    {
      at: 3500,
      marker: 'cut',
    },
  ],
  audio: [
    {
      at: 400,
      sample: 'tennis_pop',
    },
    {
      at: 700,
      sample: 'tennis_pop_soft',
    },
    {
      at: 1000,
      sample: 'tennis_pop_last',
    },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Ball() {
  return (
    <AtlasSprite
      src="tennis_ball"
      sheetSize={[1264, 1244]}
      rect={[85, 90, 480, 485]}
      x={-26}
      y={-26}
      width={52}
      height={52}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-tennis_ball__start">
        <Ball />
      </g>
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-tennis_ball__ball">
        <Ball />
      </g>
      <g className="thr-tennis_ball__mark">
        <AtlasSprite
          src="tennis_ball"
          sheetSize={[1264, 1244]}
          rect={[650, 660, 565, 530]}
          x={-30}
          y={-65}
          width={60}
          height={56}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
