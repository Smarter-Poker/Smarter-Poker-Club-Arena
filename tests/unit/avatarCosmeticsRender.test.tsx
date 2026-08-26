/**
 * AvatarCosmetics — what actually reaches the DOM.
 *
 * The catalog tests prove the resolver is right. These prove the component
 * cannot leak an unresolved token into a class attribute, which is the only way
 * a "frame that resolves to nothing" could still ship.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import AvatarCosmetics from '../../src/components/avatars/AvatarCosmetics';

describe('<AvatarCosmetics />', () => {
  it('renders nothing at all when nothing is equipped', () => {
    const { container } = render(<AvatarCosmetics frame={null} aura={null} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for a token this build does not know', () => {
    // The defect this guards: a row holding `frame-unicorn` emitting
    // `class="sp-cosmetic sp-cosmetic--frame frame-unicorn"` and inheriting
    // whatever some unrelated stylesheet happens to define for that name.
    const { container } = render(<AvatarCosmetics frame="frame-unicorn" aura="aura-void" />);
    expect(container.innerHTML).toBe('');
  });

  it('renders the frame layer with the canonical class', () => {
    const { container } = render(<AvatarCosmetics frame="frame-gold" aura={null} />);
    const frame = container.querySelector('.sp-cosmetic--frame');
    expect(frame).not.toBeNull();
    expect(frame?.className).toContain('frame-gold');
    expect(container.querySelector('.sp-cosmetic--aura')).toBeNull();
  });

  it('normalises the stored spelling onto the canonical class', () => {
    const { container } = render(<AvatarCosmetics frame="FRAME_GOLD" aura={null} />);
    expect(container.querySelector('.frame-gold')).not.toBeNull();
    // The raw stored value must not survive into the DOM.
    expect(container.innerHTML).not.toContain('FRAME_GOLD');
  });

  it('draws the aura BEFORE the frame so the frame stays on top', () => {
    const { container } = render(<AvatarCosmetics frame="frame-cyber" aura="aura-fire" />);
    const layers = Array.from(container.querySelectorAll('.sp-cosmetic'));
    expect(layers).toHaveLength(2);
    expect(layers[0]?.className).toContain('sp-cosmetic--aura');
    expect(layers[1]?.className).toContain('sp-cosmetic--frame');
  });

  it('drops a frame token handed in as an aura', () => {
    const { container } = render(<AvatarCosmetics frame={null} aura="frame-gold" />);
    expect(container.innerHTML).toBe('');
  });

  it('marks both layers aria-hidden', () => {
    // They are decoration. A screen reader announcing "image" twice per seat on
    // a nine-handed felt is nine-fold noise carrying no information.
    const { container } = render(<AvatarCosmetics frame="frame-gold" aura="aura-fire" />);
    for (const layer of Array.from(container.querySelectorAll('.sp-cosmetic'))) {
      expect(layer.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('adds the still modifier only to the aura', () => {
    const { container } = render(<AvatarCosmetics frame="frame-gold" aura="aura-glitch" still />);
    expect(container.querySelector('.sp-cosmetic--aura')?.className).toContain(
      'sp-cosmetic--still'
    );
    expect(container.querySelector('.sp-cosmetic--frame')?.className).not.toContain(
      'sp-cosmetic--still'
    );
  });
});
