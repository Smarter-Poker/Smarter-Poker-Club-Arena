import { AtlasSprite } from '../AtlasSprite';
import { AvatarCopy } from '../AvatarCopy';
import { preloadThrowableCues } from '../cues';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import './anvil.css';

export const spec: ThrowableSpec = {
  id: 'anvil',
  name: 'Anvil',
  tier: 'vip',
  category: 'objects',
  spawn: 'none',
  spawnMs: 0,
  flight: { ms: 0, mode: 'none' },
  arrival: 'none',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: true, ms: 3800 },
  beats: [
    { at: 0, marker: 'shadow' },
    { at: 600, marker: 'slam' },
    { at: 700, marker: 'flatten' },
    { at: 2500, marker: 'lift' },
    { at: 2800, marker: 'pop-round' },
    { at: 3800, marker: 'cut' },
  ],
  caption: { text: 'Oof', at: 600 },
  // Dedicated anvil clang/whistle still need a listening review.
  audio: [
    { at: 200, sample: 'whoosh_low' },
    { at: 600, sample: 'horseshoe_clank' },
    { at: 2800, sample: 'pop_soft' },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
function Projectile(_props: RigProps) {
  return <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false" />;
}
function Payload({ targetAvatar }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <ellipse className="thr-anvil__shadow" cx={0} cy={35} rx={55} ry={13} fill="#071012" />
      <g className="thr-anvil__face">
        <AvatarCopy snapshot={targetAvatar} />
      </g>
      <g className="thr-anvil__metal">
        <AtlasSprite src="anvil" rect={[0, 0, 627, 627]} x={-68} y={-73} width={136} height={136} />
      </g>
      <g className="thr-anvil__ring">
        <AtlasSprite
          src="anvil"
          rect={[627, 0, 627, 627]}
          x={-83}
          y={-18}
          width={166}
          height={92}
        />
      </g>
      <g className="thr-anvil__dust">
        <AtlasSprite
          src="anvil"
          rect={[0, 627, 627, 627]}
          x={-55}
          y={-24}
          width={110}
          height={100}
        />
      </g>
      <g className="thr-anvil__impact">
        <AtlasSprite
          src="anvil"
          rect={[627, 627, 627, 627]}
          x={-62}
          y={-36}
          width={124}
          height={124}
        />
      </g>
      <text
        className="thr-anvil__caption"
        x={0}
        y={85}
        textAnchor="middle"
        fill="#ffdc87"
        stroke="#342117"
        strokeWidth={2}
        paintOrder="stroke"
        fontFamily="system-ui"
        fontWeight={900}
        fontSize={24}
      >
        Oof
      </text>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload, needsTargetAvatar: true };
