import { jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';
import { arenaDisplayProps } from './text';
export { Fragment } from 'react/jsx-runtime';
export type { JSX } from 'react/jsx-runtime';
export const jsx: typeof reactJsx = (type, props, key) =>
  reactJsx(type, arenaDisplayProps(type, props), key);
export const jsxs: typeof reactJsxs = (type, props, key) =>
  reactJsxs(type, arenaDisplayProps(type, props), key);
