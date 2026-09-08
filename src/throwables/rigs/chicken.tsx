import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './chicken.css';

export const spec: ThrowableSpec = {
  id: 'chicken',
  name: 'Chicken',
  tier: 'free',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.3, anchor: 'face', coversAvatar: true, ms: 3967 },
  beats: [
    { at: 333, marker: 'pop' },
    { at: 467, marker: 'settle' },
    { at: 867, marker: 'peck' },
    { at: 1267, marker: 'head-up-bobs' },
    { at: 2333, marker: 'wide-cluck' },
    { at: 3000, marker: 'half-open-bobs' },
    { at: 4300, marker: 'cut' },
  ],
  // Organic cluck and bawk recordings remain an explicit sound signoff item.
  audio: [{ at: 500, sample: 'pop_soft' }],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite src="chicken" rect={[65, 8, 540, 610]} x={-45} y={-55} width={90} height={110} />
    </svg>
  );
}
function Payload(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-chicken__pop">
        <g className="thr-chicken__idle">
          <AtlasSprite
            src="chicken"
            rect={[65, 8, 540, 610]}
            x={-60}
            y={-70}
            width={120}
            height={140}
          />
        </g>
        <g className="thr-chicken__peck">
          <AtlasSprite
            src="chicken"
            rect={[676, 89, 550, 535]}
            x={-59}
            y={-56}
            width={130}
            height={127}
          />
        </g>
        <g className="thr-chicken__bobs">
          <AtlasSprite
            src="chicken"
            rect={[65, 8, 540, 610]}
            x={-60}
            y={-70}
            width={120}
            height={140}
          />
        </g>
        <g className="thr-chicken__cluck">
          <AtlasSprite
            src="chicken"
            rect={[697, 622, 510, 608]}
            x={-60}
            y={-72}
            width={120}
            height={143}
          />
        </g>
        <g className="thr-chicken__tail">
          <AtlasSprite
            src="chicken"
            rect={[68, 631, 526, 600]}
            x={-62}
            y={-70}
            width={123}
            height={140}
          />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
