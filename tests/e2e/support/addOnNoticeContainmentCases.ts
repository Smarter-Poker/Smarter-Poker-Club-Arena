import { test, expect } from '@playwright/test';
import { build } from 'esbuild';

/** Real shared bubble and stylesheet; no network, game state or purchase fixtures. */
export function registerAddOnNoticeContainmentCases() {
  test.describe('add-on notice containment', () => {
    let script: string, css: string;
    test.beforeAll(async () => {
      const result = await build({
        stdin: {
          contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ChatBubble} from './src/components/table/ChatBubble';createRoot(document.getElementById('root')).render(React.createElement('div',{className:'table-page',style:{position:'relative',width:'100%',height:600,overflow:'hidden'}},[8,92].map(x=>React.createElement('div',{key:x,className:'seat-wrapper',style:{position:'absolute',left:x+'%',top:300,width:90,height:120,transform:'translate(-50%,-50%)'}},React.createElement(ChatBubble,{text:'Has Added On For 1,234,567.89',playerName:'Player With A Long Name',variant:'notice'})))));`,
          resolveDir: process.cwd(),
          loader: 'tsx',
        },
        bundle: true,
        write: false,
        outdir: 'fixture-output',
        format: 'iife',
        jsx: 'automatic',
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      script = result.outputFiles.find((f) => f.path.endsWith('.js'))!.text;
      css = result.outputFiles.find((f) => f.path.endsWith('.css'))!.text;
    });
    for (const width of [375, 393])
      test(`full amount stays inside each ${width}px table pane and resizes`, async ({
        page,
      }, info) => {
        await page.setViewportSize({ width, height: 812 });
        await page.setContent(
          `<style>*{box-sizing:border-box}body{margin:0;font-family:Arial;background:#000}${css}#root{width:${width}px;margin-left:0}</style><div id="root"></div>`
        );
        await page.addScriptTag({ content: script });
        const bubbles = page.locator('.chat-bubble--notice');
        await expect(bubbles).toHaveCount(2);
        const geometry = () =>
          bubbles.evaluateAll((nodes) =>
            nodes.map((n) => {
              const r = n.getBoundingClientRect(),
                pane = n.closest('.table-page')!.getBoundingClientRect();
              const text = n.querySelector('.chat-bubble__text') as HTMLElement;
              return {
                left: r.left,
                right: r.right,
                paneLeft: pane.left,
                paneRight: pane.right,
                textWidth: text.clientWidth,
                textScrollWidth: text.scrollWidth,
                textHeight: text.clientHeight,
                textScrollHeight: text.scrollHeight,
              };
            })
          );
        // Wait for the existing entrance animation to finish before measuring its settled box.
        await page.waitForTimeout(250);
        await info.attach('notice-before-resize.png', {
          body: await page.screenshot({ path: info.outputPath('notice-mobile.png') }),
          contentType: 'image/png',
        });
        for (const r of await geometry()) {
          expect(r.left).toBeGreaterThanOrEqual(r.paneLeft);
          expect(r.right).toBeLessThanOrEqual(r.paneRight);
          expect(r.textScrollWidth).toBeLessThanOrEqual(r.textWidth + 1);
          expect(r.textScrollHeight).toBeLessThanOrEqual(r.textHeight + 1);
        }
        await page.setViewportSize({ width: 1000, height: 812 });
        await page.locator('#root').evaluate((n) => {
          n.style.width = '240px';
          n.style.marginLeft = '123px';
        });
        await expect
          .poll(async () =>
            (await geometry()).every(
              (r) =>
                r.left >= r.paneLeft &&
                r.right <= r.paneRight &&
                r.textScrollWidth <= r.textWidth + 1 &&
                r.textScrollHeight <= r.textHeight + 1
            )
          )
          .toBe(true);
        await info.attach('notice-after-resize.png', {
          body: await page.screenshot({ path: info.outputPath('notice-pane.png') }),
          contentType: 'image/png',
        });
      });
  });
}
