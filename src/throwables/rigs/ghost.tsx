import { AtlasSprite } from '../AtlasSprite';
import { AvatarCopy } from '../AvatarCopy';
import { preloadThrowableCues } from '../cues';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import './ghost.css';

export const spec: ThrowableSpec = {
  id: 'ghost',
  name: 'Ghost',
  tier: 'free',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 267, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.3, anchor: 'face', coversAvatar: false, ms: 3233 },
  beats: [
    { at: 267, marker: 'waft' },
    { at: 800, marker: 'first-pass' },
    { at: 1600, marker: 'second-pass' },
    { at: 1900, marker: 'pale-copy' },
    { at: 3400, marker: 'warm-again' },
    { at: 3500, marker: 'cut' },
  ],
  // A bespoke ghost voice remains part of the sound acceptance work.
  audio: [
    { at: 800, sample: 'whoosh_low', gain: 0.5 },
    { at: 1600, sample: 'whoosh_low', gain: 0.4 },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite src="ghost" rect={[0, 0, 627, 627]} x={-35} y={-35} width={70} height={70} />
    </svg>
  );
}
function Payload({ targetAvatar }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-ghost__pale">
        <AvatarCopy snapshot={targetAvatar} />
      </g>
      <g className="thr-ghost__ripple1">
        <AtlasSprite
          src="rubber_duck"
          rect={[655, 810, 550, 350]}
          x={-70}
          y={-38}
          width={140}
          height={76}
        />
      </g>
      <g className="thr-ghost__ripple2">
        <AtlasSprite
          src="rubber_duck"
          rect={[655, 810, 550, 350]}
          x={-70}
          y={-38}
          width={140}
          height={76}
        />
      </g>
      <g className="thr-ghost__pass">
        <g className="thr-ghost__right">
          <AtlasSprite
            src="ghost"
            rect={[627, 0, 627, 627]}
            x={-60}
            y={-65}
            width={120}
            height={130}
          />
        </g>
        <g className="thr-ghost__left">
          <AtlasSprite
            src="ghost"
            rect={[0, 627, 627, 627]}
            x={-60}
            y={-65}
            width={120}
            height={130}
          />
        </g>
      </g>
      <g className="thr-ghost__dissolve">
        <AtlasSprite
          src="ghost"
          rect={[627, 627, 627, 627]}
          x={-70}
          y={-60}
          width={120}
          height={120}
        />
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload, needsTargetAvatar: true };
