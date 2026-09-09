import { AtlasSprite } from '../AtlasSprite';
import { RIG_VIEWBOX, type RigProps, type ThrowableRig } from '../rig';
import type { ThrowableSpec } from '../spec';
import { preloadThrowableCues } from '../cues';
import './angry_emoji.css';
export const spec: ThrowableSpec = {
  id: 'angry_emoji',
  name: 'Rage',
  tier: 'free',
  category: 'emoticons',
  spawn: 'avatar-face',
  spawnMs: 167,
  flight: { ms: 300, mode: 'straight', upright: true },
  arrival: 'blink-pop',
  payload: { sizeU: 1.2, anchor: 'face', coversAvatar: true, ms: 3900 },
  beats: [
    { at: 300, marker: 'orange' },
    { at: 1600, marker: 'deep-red' },
    { at: 1667, marker: 'shout' },
    { at: 1933, marker: 'flames' },
    { at: 2067, marker: 'rage-one' },
    { at: 2767, marker: 'rage-two' },
    { at: 3467, marker: 'rage-three' },
    { at: 4200, marker: 'cut' },
  ],
  audio: [
    { at: 700, sample: 'swell_low' },
    { at: 1933, sample: 'whoosh_low' },
    { at: 2067, sample: 'fw_crackle' },
    { at: 2767, sample: 'fw_crackle' },
    { at: 3467, sample: 'fw_crackle' },
  ],
};
preloadThrowableCues(spec.audio.map((c) => c.sample));
function Projectile(_props: RigProps) {
  return (
    <svg viewBox={RIG_VIEWBOX} aria-hidden="true" focusable="false">
      <AtlasSprite
        src="angry_emoji"
        rect={[35, 30, 575, 560]}
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
      <g className="thr-angry_emoji__rage">
        <g className="thr-angry_emoji__orange">
          <AtlasSprite
            src="angry_emoji"
            rect={[35, 30, 575, 560]}
            x={-60}
            y={-60}
            width={120}
            height={120}
          />
        </g>
        <g className="thr-angry_emoji__red">
          <AtlasSprite
            src="angry_emoji"
            rect={[650, 30, 570, 560]}
            x={-60}
            y={-60}
            width={120}
            height={120}
          />
        </g>
        <g className="thr-angry_emoji__shout">
          <AtlasSprite
            src="angry_emoji"
            rect={[35, 650, 575, 575]}
            x={-60}
            y={-60}
            width={120}
            height={120}
          />
        </g>
        <g className="thr-angry_emoji__fire">
          <AtlasSprite
            src="angry_emoji"
            rect={[625, 580, 615, 650]}
            x={-64}
            y={-87}
            width={128}
            height={135}
          />
        </g>
      </g>
    </svg>
  );
}
export const rig: ThrowableRig = { Projectile, Payload };
