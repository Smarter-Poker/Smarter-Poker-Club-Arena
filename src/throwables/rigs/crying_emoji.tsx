import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './crying_emoji.css';
export const spec: ThrowableSpec = {
  id: 'crying_emoji',
  name: 'Loudly Crying',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.3, anchor: 'face', coversAvatar: true, ms: 3900 },
  beats: [
    { at: 300, marker: 'sad' },
    { at: 900, marker: 'lip-tremble' },
    { at: 1200, marker: 'cry' },
    { at: 1600, marker: 'puddle-spreads' },
    { at: 2300, marker: 'puddle-full' },
    { at: 3300, marker: 'sob-swell' },
    { at: 4200, marker: 'cut' },
  ],
  audio: [
    { at: 1200, sample: 'water_lap' },
    { at: 1600, sample: 'drip' },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="crying_emoji"
        rect={[40, 45, 570, 565]}
        x={-60}
        y={-60}
        width={120}
        height={120}
      />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-crying_emoji__sad">
        <AtlasSprite
          src="crying_emoji"
          rect={[40, 45, 570, 565]}
          x={-60}
          y={-60}
          width={120}
          height={120}
        />
      </g>
      <g className="thr-crying_emoji__tremble">
        <AtlasSprite
          src="crying_emoji"
          rect={[650, 45, 570, 565]}
          x={-60}
          y={-60}
          width={120}
          height={120}
        />
      </g>
      <g className="thr-crying_emoji__puddle">
        <AtlasSprite
          src="rubber_duck"
          rect={[655, 810, 550, 350]}
          x={-80}
          y={40}
          width={160}
          height={48}
        />
      </g>
      <g className="thr-crying_emoji__sob">
        <AtlasSprite
          src="crying_emoji"
          rect={[40, 645, 565, 545]}
          x={-60}
          y={-60}
          width={120}
          height={120}
        />
      </g>
      <g className="thr-crying_emoji__left">
        <AtlasSprite
          src="crying_emoji"
          rect={[1154, 1032, 35, 52]}
          x={-45}
          y={-4}
          width={12}
          height={16}
        />
      </g>
      <g className="thr-crying_emoji__right">
        <AtlasSprite
          src="crying_emoji"
          rect={[1154, 1032, 35, 52]}
          x={45}
          y={-4}
          width={12}
          height={16}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
