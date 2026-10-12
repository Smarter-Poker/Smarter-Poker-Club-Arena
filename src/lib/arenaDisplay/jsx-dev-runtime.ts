import { jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime';
import { arenaDisplayProps } from './text';
export { Fragment } from 'react/jsx-dev-runtime';
export type { JSX } from 'react/jsx-dev-runtime';
export const jsxDEV: typeof reactJsxDEV = (type, props, key, isStaticChildren, source, self) =>
  reactJsxDEV(type, arenaDisplayProps(type, props), key, isStaticChildren, source, self);
