/** Premium alien character: independently timed expression poses and sound cues.
 * All visual delays are from landing (333 ms); the player owns the clock.
 */
import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './alien.css';
export const alienSpec: ThrowableSpec = {
  id: 'alien',
  name: 'Alien',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 3667 },
  beats: [
    { at: 333, marker: 'neutral' },
    { at: 900, marker: 'blink' },
    { at: 1200, marker: 'speak' },
    { at: 2400, marker: 'scan' },
    { at: 2600, marker: 'scan-ring' },
    { at: 3400, marker: 'scan-complete' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 1200, sample: 'alien_blip' },
    { at: 1560, sample: 'alien_blip' },
    { at: 2600, sample: 'scan_sweep' },
  ],
};
preloadThrowableCues(alienSpec.audio.map((c) => c.sample));
const RECTS = [
  [125, 12, 480, 618],
  [700, 12, 480, 618],
  [125, 635, 480, 610],
  [700, 635, 480, 610],
] as const;
function Face({ pose }: { pose: 0 | 1 | 2 | 3 }) {
  return <AtlasSprite src="alien" rect={RECTS[pose]} x={-72} y={-75} width={144} height={150} />;
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
      <g className="thr-alien__neutral">
        <Face pose={0} />
      </g>
      <g className="thr-alien__blink">
        <Face pose={1} />
      </g>
      <g className="thr-alien__speak">
        <Face pose={2} />
      </g>
      <g className="thr-alien__scan">
        <Face pose={3} />
      </g>
      <g className="thr-alien__speech">
        <AtlasSprite
          src="alien-effects"
          rect={[175, 60, 920, 640]}
          x={10}
          y={-105}
          width={100}
          height={65}
        />
      </g>
      <g className="thr-alien__ring">
        <AtlasSprite
          src="alien-effects"
          rect={[30, 755, 1190, 450]}
          x={-82}
          y={-18}
          width={164}
          height={62}
        />
      </g>
    </svg>
  );
}
export const alienRig: ThrowableRig = { Projectile, Payload };
