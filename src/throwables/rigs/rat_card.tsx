import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './rat_card.css';
export const spec: ThrowableSpec = {
  id: 'rat_card',
  name: 'Cheating Rat',
  tier: 'premium',
  category: 'characters',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 333, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.05, anchor: 'face', coversAvatar: true, ms: 3967 },
  beats: [
    { at: 333, marker: 'pop' },
    { at: 833, marker: 'wink' },
    { at: 967, marker: 'card-emerges' },
    { at: 1300, marker: 'card-held' },
    { at: 1367, marker: 'chew' },
    { at: 2167, marker: 'chew-settle' },
    { at: 2300, marker: 'flip' },
    { at: 2433, marker: 'ace-reveal' },
    { at: 3000, marker: 'laugh' },
    { at: 4300, marker: 'cut' },
  ],
  // Rat squeaks, gulp and laugh recordings remain pending. This is the real card cue.
  audio: [{ at: 2433, sample: 'card_slap', gain: 0.45 }],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Neutral() {
  return (
    <AtlasSprite src="rat_card" rect={[0, 0, 627, 627]} x={-65} y={-65} width={130} height={130} />
  );
}
function Laugh() {
  return (
    <AtlasSprite
      src="rat_card"
      rect={[0, 627, 627, 627]}
      x={-65}
      y={-65}
      width={130}
      height={130}
    />
  );
}
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g transform="scale(.6)">
        <Neutral />
      </g>
    </svg>
  );
}
function Payload({ uid }: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`${uid}mouth`}>
          <rect x={-65} y={20} width={150} height={120} />
        </clipPath>
      </defs>
      <g className="thr-rat_card__pop">
        <g className="thr-rat_card__bob">
          <g className="thr-rat_card__idle">
            <g className="thr-rat_card__closed">
              <Neutral />
            </g>
            <g className="thr-rat_card__chew">
              <Laugh />
            </g>
          </g>
          <g className="thr-rat_card__wink">
            <AtlasSprite
              src="rat_card"
              rect={[627, 0, 627, 627]}
              x={-65}
              y={-65}
              width={130}
              height={130}
            />
          </g>
          <g className="thr-rat_card__laugh">
            <Laugh />
          </g>
          <g clipPath={`url(#${uid}mouth)`}>
            <g className="thr-rat_card__card-slide">
              <g className="thr-rat_card__back">
                <AtlasSprite
                  src="rat_card"
                  rect={[627, 627, 313, 627]}
                  x={6}
                  y={17}
                  width={39}
                  height={78}
                />
              </g>
              <g className="thr-rat_card__ace">
                <AtlasSprite
                  src="rat_card"
                  rect={[940, 627, 314, 627]}
                  x={6}
                  y={17}
                  width={39}
                  height={78}
                />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
