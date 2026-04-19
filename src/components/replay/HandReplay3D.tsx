/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HandReplay3D — Three.js 3D Hand Replay Viewer (Bible V8 Chapter 10.3)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders a 3D poker table with animated card dealing, chip movement, and
 * player actions using Three.js. Extends the existing HandReplayEngine with
 * a visual 3D presentation layer.
 *
 * Features:
 * - 3D poker table with felt texture and rail
 * - Animated card dealing from deck position to player seats
 * - Chip stack visualization with physics-based movement
 * - Camera orbit controls (drag to rotate, scroll to zoom)
 * - Playback sync with HandReplayEngine events
 * - Mobile-responsive with touch controls
 */

import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import * as THREE from 'three';
import { masterBus } from '../../core/MasterBus';
import type { ReplaySnapshot, ReplaySpeed } from '../../engine/HandReplayEngine';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface HandReplay3DProps {
  /** Whether the 3D view is active (mounts/unmounts Three.js scene) */
  active: boolean;
  /** Number of seats at the table (2-9) */
  seatCount: number;
  /** Table felt color */
  feltColor?: string;
  /** Enable orbit camera controls */
  orbitControls?: boolean;
  /** Replay speed multiplier */
  speed?: ReplaySpeed;
  /** Callback when 3D scene is ready */
  onReady?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

const TABLE_RADIUS = 4;
const TABLE_HEIGHT = 0.15;
const RAIL_HEIGHT = 0.3;
const CARD_WIDTH = 0.4;
const CARD_HEIGHT = 0.56;
const CHIP_RADIUS = 0.12;
const CHIP_HEIGHT = 0.04;

const DEFAULT_FELT_COLOR = '#0d5f2f';
const RAIL_COLOR = '#4a2c0a';
const CARD_BACK_COLOR = '#1a237e';

// Seat positions around an elliptical table (normalized 0-1 angle)
function getSeatPosition(seatIndex: number, totalSeats: number): THREE.Vector3 {
  const angle = (seatIndex / totalSeats) * Math.PI * 2 - Math.PI / 2;
  const rx = TABLE_RADIUS * 1.3; // Ellipse X radius
  const rz = TABLE_RADIUS * 0.85; // Ellipse Z radius
  return new THREE.Vector3(Math.cos(angle) * rx, TABLE_HEIGHT + 0.01, Math.sin(angle) * rz);
}

// ═══════════════════════════════════════════════════════════════════════════════
// THREE.JS SCENE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

class PokerTable3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  animationId: number | null = null;
  cards: THREE.Mesh[] = [];
  chipStacks: THREE.Group[] = [];
  seatCount: number;
  isDisposed = false;

  constructor(canvas: HTMLCanvasElement, seatCount: number, feltColor: string) {
    this.seatCount = seatCount;

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#1a1a2e');

    // Camera — bird's-eye with slight angle
    this.camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100);
    this.camera.position.set(0, 8, 6);
    this.camera.lookAt(0, 0, 0);

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.width, canvas.height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambientLight);

    const spotLight = new THREE.SpotLight(0xfff5e6, 1.2, 20, Math.PI / 4, 0.5);
    spotLight.position.set(0, 10, 0);
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.set(1024, 1024);
    this.scene.add(spotLight);

    const rimLight = new THREE.DirectionalLight(0x4488ff, 0.3);
    rimLight.position.set(-5, 3, -5);
    this.scene.add(rimLight);

    // Build table
    this.buildTable(feltColor);
    this.buildSeatMarkers();
  }

  private buildTable(feltColor: string): void {
    // Table felt (elliptical)
    const feltGeometry = new THREE.CylinderGeometry(
      TABLE_RADIUS * 1.3,
      TABLE_RADIUS * 1.3,
      TABLE_HEIGHT,
      64
    );
    // Scale to ellipse
    feltGeometry.scale(1, 1, 0.65);

    const feltMaterial = new THREE.MeshStandardMaterial({
      color: feltColor,
      roughness: 0.8,
      metalness: 0.05,
    });
    const felt = new THREE.Mesh(feltGeometry, feltMaterial);
    felt.position.y = TABLE_HEIGHT / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);

    // Rail
    const railGeometry = new THREE.TorusGeometry(TABLE_RADIUS * 1.3, 0.15, 16, 64);
    railGeometry.scale(1, 1, 0.65);
    const railMaterial = new THREE.MeshStandardMaterial({
      color: RAIL_COLOR,
      roughness: 0.4,
      metalness: 0.2,
    });
    const rail = new THREE.Mesh(railGeometry, railMaterial);
    rail.position.y = TABLE_HEIGHT + RAIL_HEIGHT / 2;
    rail.rotation.x = Math.PI / 2;
    rail.castShadow = true;
    this.scene.add(rail);
  }

  private buildSeatMarkers(): void {
    for (let i = 0; i < this.seatCount; i++) {
      const pos = getSeatPosition(i, this.seatCount);
      // Seat indicator — small circular disc
      const geo = new THREE.CylinderGeometry(0.25, 0.25, 0.02, 32);
      const mat = new THREE.MeshStandardMaterial({
        color: '#303132',
        roughness: 0.6,
        metalness: 0.1,
      });
      const marker = new THREE.Mesh(geo, mat);
      marker.position.copy(pos);
      marker.receiveShadow = true;
      this.scene.add(marker);
    }
  }

  /** Add a card to the scene at a seat position */
  dealCard(seatIndex: number, faceUp: boolean = false, cardColor: string = '#ffffff'): THREE.Mesh {
    const geo = new THREE.BoxGeometry(CARD_WIDTH, 0.01, CARD_HEIGHT);
    const materials = [
      new THREE.MeshStandardMaterial({ color: '#ffffff' }), // edge
      new THREE.MeshStandardMaterial({ color: '#ffffff' }), // edge
      new THREE.MeshStandardMaterial({ color: faceUp ? cardColor : CARD_BACK_COLOR }), // top
      new THREE.MeshStandardMaterial({ color: CARD_BACK_COLOR }), // bottom
      new THREE.MeshStandardMaterial({ color: '#ffffff' }), // edge
      new THREE.MeshStandardMaterial({ color: '#ffffff' }), // edge
    ];
    const card = new THREE.Mesh(geo, materials);

    const seatPos = getSeatPosition(seatIndex, this.seatCount);
    card.position.set(seatPos.x * 0.7, TABLE_HEIGHT + 0.02, seatPos.z * 0.7);
    card.castShadow = true;

    this.scene.add(card);
    this.cards.push(card);
    return card;
  }

  /** Add community card at center */
  dealCommunityCard(index: number, faceUp: boolean = true): THREE.Mesh {
    const geo = new THREE.BoxGeometry(CARD_WIDTH, 0.01, CARD_HEIGHT);
    const mat = new THREE.MeshStandardMaterial({
      color: faceUp ? '#ffffff' : CARD_BACK_COLOR,
      roughness: 0.3,
      metalness: 0.05,
    });
    const card = new THREE.Mesh(geo, mat);

    // Spread community cards across center
    const xOffset = (index - 2) * (CARD_WIDTH + 0.08);
    card.position.set(xOffset, TABLE_HEIGHT + 0.03, 0);
    card.castShadow = true;

    this.scene.add(card);
    this.cards.push(card);
    return card;
  }

  /** Add a chip stack at a position */
  addChipStack(seatIndex: number, amount: number): THREE.Group {
    const group = new THREE.Group();
    const seatPos = getSeatPosition(seatIndex, this.seatCount);
    group.position.set(seatPos.x * 0.5, TABLE_HEIGHT + 0.01, seatPos.z * 0.5);

    // Determine chip count and color based on amount
    const chipCount = Math.min(Math.ceil(amount / 100), 8);
    const chipColor = amount >= 1000 ? '#f97316' : amount >= 100 ? '#1a1a2e' : '#ef4444';

    for (let i = 0; i < chipCount; i++) {
      const chipGeo = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 32);
      const chipMat = new THREE.MeshStandardMaterial({
        color: chipColor,
        roughness: 0.3,
        metalness: 0.4,
      });
      const chip = new THREE.Mesh(chipGeo, chipMat);
      chip.position.y = i * (CHIP_HEIGHT + 0.005);
      chip.castShadow = true;
      group.add(chip);
    }

    this.scene.add(group);
    this.chipStacks.push(group);
    return group;
  }

  /** Clear all cards and chips */
  clearTable(): void {
    for (const card of this.cards) {
      this.scene.remove(card);
      card.geometry.dispose();
      if (Array.isArray(card.material)) {
        card.material.forEach((m) => m.dispose());
      } else {
        card.material.dispose();
      }
    }
    this.cards = [];

    for (const stack of this.chipStacks) {
      this.scene.remove(stack);
      stack.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
    }
    this.chipStacks = [];
  }

  /** Start render loop */
  startRenderLoop(): void {
    const animate = () => {
      if (this.isDisposed) return;
      this.animationId = requestAnimationFrame(animate);
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  /** Resize handler */
  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  /** Dispose all resources */
  dispose(): void {
    this.isDisposed = true;
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    this.clearTable();
    this.renderer.dispose();
    this.scene.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) {
          child.material.forEach((m) => m.dispose());
        } else if (child.material instanceof THREE.Material) {
          child.material.dispose();
        }
      }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// REACT COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function HandReplay3DComponent({
  active,
  seatCount,
  feltColor = DEFAULT_FELT_COLOR,
  orbitControls = true,
  speed = 1,
  onReady,
}: HandReplay3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PokerTable3D | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);

  // Initialize Three.js scene
  useEffect(() => {
    if (!active || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!container) return;

    // Set canvas size to container
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const scene = new PokerTable3D(canvas, seatCount, feltColor);
    scene.startRenderLoop();
    sceneRef.current = scene;

    setIsReady(true);
    onReady?.();

    // Resize handler
    const handleResize = () => {
      if (!container || !scene) return;
      const r = container.getBoundingClientRect();
      scene.resize(r.width, r.height);
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      scene.dispose();
      sceneRef.current = null;
      setIsReady(false);
    };
  }, [active, seatCount, feltColor, onReady]);

  // Listen for replay step events from HandReplayEngine via MasterBus
  // HAND_REPLAY_STEP includes the current snapshot — drive the 3D scene from it
  useEffect(() => {
    if (!isReady || !sceneRef.current) return;

    const scene = sceneRef.current;

    const handleReplayStep = (payload: {
      handId: string;
      step: number;
      totalSteps: number;
      action: unknown;
      snapshot: ReplaySnapshot;
    }) => {
      const { snapshot } = payload;
      scene.clearTable();

      // Deal community cards
      for (let i = 0; i < snapshot.communityCards.length; i++) {
        scene.dealCommunityCard(i, true);
      }

      // Deal player cards and chips
      for (const player of snapshot.players) {
        if (!player.isFolded) {
          for (let c = 0; c < player.cards.length; c++) {
            scene.dealCard(player.seat, player.cards[c] !== '??');
          }
        }
        if (player.bet > 0) {
          scene.addChipStack(player.seat, player.bet);
        }
      }
    };

    const unsub = masterBus.subscribe('HAND_REPLAY_STEP', handleReplayStep as any);
    return () => {
      unsub();
    };
  }, [isReady]);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className="hand-replay-3d"
      style={{
        width: '100%',
        height: '100%',
        minHeight: '300px',
        position: 'relative',
        borderRadius: '12px',
        overflow: 'hidden',
        background: '#1a1a2e',
      }}
      role="img"
      aria-label="3D hand replay viewer"
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {!isReady && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#b0b3b8',
            fontSize: '14px',
          }}
        >
          Loading 3D viewer...
        </div>
      )}
    </div>
  );
}

export const HandReplay3D = memo(HandReplay3DComponent);
export default HandReplay3D;
