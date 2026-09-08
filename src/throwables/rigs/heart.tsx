import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './heart.css';
export const spec: ThrowableSpec = {
  id: 'heart',
  name: 'Heart',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 3900 },
  beats: [
    { at: 300, marker: 'heart' },
    { at: 807, marker: 'heartbeat-one' },
    { at: 1500, marker: 'small-heart-one' },
    { at: 1857, marker: 'heartbeat-two' },
    { at: 1900, marker: 'small-heart-two' },
    { at: 2300, marker: 'small-heart-three' },
    { at: 2907, marker: 'heartbeat-three' },
    { at: 4200, marker: 'cut' },
  ],
  audio: [
    { at: 807, sample: 'thump_soft' },
    { at: 1857, sample: 'thump_soft' },
    { at: 2907, sample: 'thump_soft' },
    { at: 1500, sample: 'chime_shimmer' },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite src="heart" rect={[50, 85, 570, 510]} x={-60} y={-55} width={120} height={108} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-heart__beat">
        <AtlasSprite
          src="heart"
          rect={[50, 85, 570, 510]}
          x={-60}
          y={-55}
          width={120}
          height={108}
        />
      </g>
      <g className="thr-heart__child0">
        <AtlasSprite
          src="heart"
          rect={[1055, 650, 125, 125]}
          x={-12}
          y={-12}
          width={24}
          height={24}
        />
      </g>
      <g className="thr-heart__child1">
        <AtlasSprite
          src="heart"
          rect={[1055, 650, 125, 125]}
          x={-12}
          y={-12}
          width={24}
          height={24}
        />
      </g>
      <g className="thr-heart__child2">
        <AtlasSprite
          src="heart"
          rect={[1055, 650, 125, 125]}
          x={-12}
          y={-12}
          width={24}
          height={24}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
