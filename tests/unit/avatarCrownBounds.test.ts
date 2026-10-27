import { describe, expect, it } from 'vitest';
import {
  AVATAR_CROWN_TOP,
  avatarCrownTop,
  paintedAvatarTop,
} from '../../src/components/table/avatarCrownBounds';

describe('visible avatar crowns', () => {
  it('covers normal and retina library art with measured fractions', () => {
    expect(Object.keys(AVATAR_CROWN_TOP)).toHaveLength(200);
    expect(Object.values(AVATAR_CROWN_TOP).every((top) => top >= 0 && top < 0.5)).toBe(true);
  });
  it('uses the actual tech-mogul headroom seen on limplegend, including URL suffixes', () => {
    // Shipped 250x340 art: first alpha >=16 occurs at row 54, independently measured.
    expect(
      avatarCrownTop('https://smarter.poker/avatars/table/vip_tech_mogul@2x.webp?v=1#avatar')
    ).toBeCloseTo(54 / 340, 6);
  });
  it('preserves the image boundary for unknown or uploaded art', () => {
    for (const source of [
      null,
      undefined,
      '',
      '/avatars/table/vip_new.webp',
      '/uploads/avatar.png',
    ])
      expect(avatarCrownTop(source)).toBe(0);
  });
  it('projects the crown through the rendered image scale', () => {
    const image = document.createElement('img');
    image.src = '/avatars/table/vip_tech_mogul@2x.webp';
    image.getBoundingClientRect = () => ({ top: 100, height: 200 }) as DOMRect;
    expect(paintedAvatarTop(image)).toBeCloseTo(100 + 200 * (54 / 340), 3);
  });
});
