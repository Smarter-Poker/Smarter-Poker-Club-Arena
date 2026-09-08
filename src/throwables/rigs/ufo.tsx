import { AtlasSprite } from '../AtlasSprite';
import { AvatarCopy } from '../AvatarCopy';
import { preloadThrowableCues } from '../cues';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import './ufo.css';

export const spec: ThrowableSpec = {
  id: 'ufo',
  name: 'UFO',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 400, mode: 'straight', upright: true },
  arrival: 'none',
  payload: { sizeU: 1.6, anchor: 'face', coversAvatar: false, ms: 3200 },
  beats: [
    { at: 400, marker: 'hover-beam' },
    { at: 1400, marker: 'abduct' },
    { at: 2400, marker: 'zip-away' },
    { at: 2600, marker: 'return-face' },
    { at: 3600, marker: 'cut' },
  ],
  audio: [
    { at: 400, sample: 'alien_blip' },
    { at: 1400, sample: 'magnet_hum', loopUntil: 2400, gain: 0.5 },
    { at: 2400, sample: 'whoosh_low' },
    { at: 2600, sample: 'pop_soft' },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
function Ship() {
  return (
    <AtlasSprite src="ufo" rect={[0, 100, 663, 480]} x={-75} y={-111} width={150} height={109} />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-ufo__swoop">
        <AtlasSprite src="ufo" rect={[0, 100, 663, 480]} x={-35} y={-25} width={70} height={51} />
      </g>
    </svg>
  );
}
function Payload({ targetAvatar }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-ufo__beam">
        <AtlasSprite
          src="ufo"
          rect={[45, 640, 565, 565]}
          x={-65}
          y={-72}
          width={130}
          height={145}
        />
      </g>
      <g className="thr-ufo__abduct">
        <AvatarCopy snapshot={targetAvatar} />
      </g>
      <g className="thr-ufo__return">
        <AvatarCopy snapshot={targetAvatar} />
      </g>
      <g className="thr-ufo__zip">
        <g className="thr-ufo__hover">
          <Ship />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload, needsTargetAvatar: true };
