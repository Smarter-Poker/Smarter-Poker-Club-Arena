import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './cool_sunglasses_emoji.css';
export const spec: ThrowableSpec = {
  id: 'cool_sunglasses_emoji',
  name: 'Too Cool',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 3900 },
  beats: [
    { at: 300, marker: 'smug' },
    { at: 500, marker: 'glasses-drop' },
    { at: 700, marker: 'glasses-snap' },
    { at: 800, marker: 'glasses-settle' },
    { at: 1600, marker: 'lens-glint' },
    { at: 2100, marker: 'head-tilt' },
    { at: 4200, marker: 'cut' },
  ],
  audio: [
    { at: 700, sample: 'tick_settle' },
    { at: 1600, sample: 'chime_shimmer' },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="cool_sunglasses_emoji"
        rect={[35, 55, 570, 545]}
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
      <g className="thr-cool_sunglasses_emoji__tilt">
        <AtlasSprite
          src="cool_sunglasses_emoji"
          rect={[35, 55, 570, 545]}
          x={-60}
          y={-60}
          width={120}
          height={120}
        />
        <g className="thr-cool_sunglasses_emoji__glasses">
          <AtlasSprite
            src="cool_sunglasses_emoji"
            rect={[35, 800, 590, 300]}
            x={-66}
            y={-32}
            width={132}
            height={67}
          />
        </g>
        <g className="thr-cool_sunglasses_emoji__glint">
          <AtlasSprite
            src="star"
            rect={[755, 685, 355, 435]}
            x={25}
            y={-48}
            width={28}
            height={34}
          />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
