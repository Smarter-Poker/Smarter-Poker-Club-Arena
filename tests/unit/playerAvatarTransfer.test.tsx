import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PlayerAvatar, type AvatarSize } from '../../src/components/avatars/PlayerAvatar';

const original = 'https://project.supabase.co/storage/v1/object/public/avatars/portrait.jpg?v=7';
afterEach(cleanup);

describe('PlayerAvatar transfer size', () => {
  it.each<[AvatarSize, number]>([
    ['xs', 56],
    ['sm', 72],
    ['md', 96],
    ['lg', 128],
    ['xl', 168],
  ])('requests a retina-sized JPEG for the %s portrait', (size, pixels) => {
    const { getByRole } = render(<PlayerAvatar src={original} size={size} />);
    const url = new URL(getByRole('img').getAttribute('src')!);
    expect(url.pathname).toBe('/storage/v1/render/image/public/avatars/portrait.jpg');
    expect(url.searchParams.get('width')).toBe(String(pixels));
    expect(url.searchParams.get('height')).toBe(String(pixels));
    expect(url.searchParams.get('resize')).toBe('cover');
    expect(url.searchParams.get('quality')).toBe('80');
    expect(url.searchParams.get('v')).toBe('7');
  });

  it.each([
    '/avatars/table/free_shark.webp',
    'https://images.example.com/photo.jpg',
    'https://project.supabase.co/storage/v1/object/sign/avatars/photo.jpg?token=fixture',
    'data:image/svg+xml,%3Csvg%2F%3E',
    'https://project.supabase.co/storage/v1/object/public/avatars/moving.gif',
    'https://project.supabase.co/storage/v1/object/public/avatars/moving.webp',
    'https://project.supabase.co/storage/v1/object/public/avatars/moving.png',
  ])('preserves an existing or potentially animated image: %s', (src) => {
    const { getByRole } = render(<PlayerAvatar src={src} />);
    expect(getByRole('img').getAttribute('src')).toBe(src);
  });

  it('falls back to the original once if resizing fails, then to the existing default', () => {
    const { getByRole } = render(<PlayerAvatar src={original} />);
    const img = getByRole('img');
    fireEvent.error(img);
    expect(img.getAttribute('src')).toBe(original);
    fireEvent.error(img);
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml,/);
  });

  it('updates the image when a player changes their portrait after a failure', () => {
    const { getByRole, rerender } = render(<PlayerAvatar src={original} />);
    fireEvent.error(getByRole('img'));
    const replacement = original.replace('portrait.jpg', 'replacement.jpeg');
    rerender(<PlayerAvatar src={replacement} size="xl" />);
    expect(getByRole('img').getAttribute('src')).toContain('/replacement.jpeg?v=7&width=168');
  });

  it('retains initials when the player has no image', () => {
    const { queryByRole, getByText } = render(<PlayerAvatar name="Two Words" />);
    expect(queryByRole('img')).toBeNull();
    expect(getByText('TW')).toBeTruthy();
  });
});
