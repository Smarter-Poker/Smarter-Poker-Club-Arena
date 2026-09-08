import { AtlasSprite } from '../AtlasSprite';
import { magicEightBallAnswer } from '../identity';
import { preloadThrowableCues } from '../cues';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import './magic_8_ball.css';

export const spec: ThrowableSpec = {
  id: 'magic_8_ball',
  name: 'Magic 8 Ball',
  tier: 'free',
  category: 'objects',
  spawn: 'avatar-corner',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'land',
  payload: { sizeU: 1.5, anchor: 'face', coversAvatar: true, ms: 3700 },
  beats: [
    { at: 300, marker: 'land' },
    { at: 400, marker: 'shake' },
    { at: 900, marker: 'flip-window' },
    { at: 1100, marker: 'answer' },
    { at: 1400, marker: 'answer-hold' },
    { at: 4000, marker: 'cut' },
  ],
  audio: [
    { at: 400, sample: 'water_lap', gain: 0.4 },
    { at: 1100, sample: 'chime_shimmer' },
  ],
};
preloadThrowableCues(spec.audio.map((cue) => cue.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="magic_8_ball"
        rect={[0, 0, 627, 627]}
        x={-30}
        y={-30}
        width={60}
        height={60}
      />
    </svg>
  );
}
function Payload({ throwId }: RigProps) {
  const answer = magicEightBallAnswer(throwId ?? 'preview');
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <g className="thr-magic_8_ball__rattle">
        <g className="thr-magic_8_ball__front">
          <AtlasSprite
            src="magic_8_ball"
            rect={[0, 0, 627, 627]}
            x={-75}
            y={-75}
            width={150}
            height={150}
          />
        </g>
        <g className="thr-magic_8_ball__back">
          <AtlasSprite
            src="magic_8_ball"
            rect={[627, 0, 627, 627]}
            x={-75}
            y={-75}
            width={150}
            height={150}
          />
          <g className="thr-magic_8_ball__answer">
            <text
              x={5}
              y={-3}
              textAnchor="middle"
              fill="#e4f7ff"
              fontFamily="system-ui"
              fontWeight={800}
              fontSize={7}
            >
              {answer.map((line, index) => (
                <tspan key={line} x={5} dy={index === 0 ? 0 : 10}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
