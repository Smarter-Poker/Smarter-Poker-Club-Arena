import { createElement as reactCreateElement } from 'react';
import { arenaDisplayProps } from './text';

// JSX with a key after a spread uses createElement rather than jsx.
// Preserve React's overloaded public signature; only its display props change.
export const createElement = ((...args: Parameters<typeof reactCreateElement>) => {
  const [type, props, ...children] = args;
  const normalized = arenaDisplayProps(
    type,
    children.length ? { ...props, children: children.length === 1 ? children[0] : children } : props
  ) as typeof props;
  return reactCreateElement(type, normalized);
}) as typeof reactCreateElement;
