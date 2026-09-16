import type { Plugin } from 'vite';
import type { PreRenderedAsset } from 'rollup';

export function viteMediaIdentity(): {
  assetFileNames(asset: PreRenderedAsset): string;
  plugin: Plugin;
};
