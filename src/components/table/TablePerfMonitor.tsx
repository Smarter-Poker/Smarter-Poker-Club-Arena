/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TablePerfMonitor — Dev-Only Performance Overlay
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * FPS counter, render tracker, and memory usage display.
 * Only activates in development mode via:
 *   - `?perf=1` query parameter
 *   - Keyboard shortcut `P` (when not typing)
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import './TablePerfMonitor.css';

interface PerfMetrics {
  fps: number;
  frameTime: number;
  renderCount: number;
  memoryUsed: number; // MB
}

export interface TablePerfMonitorProps {
  enabled?: boolean;
}

export function TablePerfMonitor({ enabled = false }: TablePerfMonitorProps) {
  const [isVisible, setIsVisible] = useState(false);
  const [metrics, setMetrics] = useState<PerfMetrics>({
    fps: 0,
    frameTime: 0,
    renderCount: 0,
    memoryUsed: 0,
  });

  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const renderCountRef = useRef(0);
  const rafRef = useRef<number>(0);

  // Track render count
  renderCountRef.current++;

  // Check URL param and dev mode
  useEffect(() => {
    const isDev = import.meta.env.DEV;
    const hasParam = new URLSearchParams(window.location.search).get('perf') === '1';
    if ((isDev && hasParam) || enabled) {
      setIsVisible(true);
    }
  }, [enabled]);

  // Keyboard toggle
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === 'p' &&
        !e.ctrlKey &&
        !e.metaKey &&
        (e.target as HTMLElement).tagName !== 'INPUT' &&
        (e.target as HTMLElement).tagName !== 'TEXTAREA'
      ) {
        if (import.meta.env.DEV) {
          setIsVisible((v) => !v);
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // FPS measurement loop
  useEffect(() => {
    if (!isVisible) return;

    const measureFPS = (now: number) => {
      frameCountRef.current++;
      const elapsed = now - lastTimeRef.current;

      if (elapsed >= 1000) {
        const fps = Math.round((frameCountRef.current * 1000) / elapsed);
        const frameTime = Math.round((elapsed / frameCountRef.current) * 100) / 100;

        // Memory (Chrome only)
        let memoryUsed = 0;
        const perf = performance as any;
        if (perf.memory) {
          memoryUsed = Math.round(perf.memory.usedJSHeapSize / 1024 / 1024);
        }

        setMetrics({
          fps,
          frameTime,
          renderCount: renderCountRef.current,
          memoryUsed,
        });

        frameCountRef.current = 0;
        lastTimeRef.current = now;
      }

      rafRef.current = requestAnimationFrame(measureFPS);
    };

    rafRef.current = requestAnimationFrame(measureFPS);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isVisible]);

  if (!isVisible) return null;

  const fpsColor = metrics.fps >= 55 ? '#3fb950' : metrics.fps >= 30 ? '#f0c000' : '#f85149';

  return (
    <div className="perf-monitor" aria-label="Performance Monitor">
      <div className="pm-row">
        <span className="pm-label">FPS</span>
        <span className="pm-value" style={{ color: fpsColor }}>
          {metrics.fps}
        </span>
      </div>
      <div className="pm-row">
        <span className="pm-label">Frame</span>
        <span className="pm-value">{metrics.frameTime}ms</span>
      </div>
      <div className="pm-row">
        <span className="pm-label">Renders</span>
        <span className="pm-value">{metrics.renderCount}</span>
      </div>
      {metrics.memoryUsed > 0 && (
        <div className="pm-row">
          <span className="pm-label">Heap</span>
          <span className="pm-value">{metrics.memoryUsed}MB</span>
        </div>
      )}
      <button className="pm-close" onClick={() => setIsVisible(false)} title="Close">
        ×
      </button>
    </div>
  );
}

export default TablePerfMonitor;
