/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HandReplay3D — Three.js 3D Hand Replay Viewer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Renders a 3D poker table with animated card dealing, chip movement, and
 * player actions using Three.js and GSAP.
 */

import React, { useRef, useEffect, useState, memo } from 'react';
import * as THREE from 'three';
import gsap from 'gsap';
import type { ReplaySnapshot, ReplaySpeed } from '../../types/engine/handReplay';

export interface HandReplay3DProps {
  active: boolean;
  seatCount: number;
  feltColor?: string;
  orbitControls?: boolean;
  speed?: ReplaySpeed;
  onReady?: () => void;
  snapshot?: ReplaySnapshot;
}

const TABLE_RADIUS = 4;
const TABLE_HEIGHT = 0.15;
const RAIL_HEIGHT = 0.3;
const CARD_WIDTH = 0.4;
const CARD_HEIGHT = 0.56;
const CHIP_RADIUS = 0.12;
const CHIP_HEIGHT = 0.04;

const DEFAULT_FELT_COLOR = '#0d5f2f';
const RAIL_COLOR = '#111111';

// Cache for loaded textures
const textureCache = new Map<string, THREE.Texture>();
const textureLoader = new THREE.TextureLoader();

function getTexture(path: string): THREE.Texture {
  if (textureCache.has(path)) {
    return textureCache.get(path)!;
  }
  const tex = textureLoader.load(path);
  tex.colorSpace = THREE.SRGBColorSpace;
  textureCache.set(path, tex);
  return tex;
}

function getCardTexturePath(cardStr: string): string {
  if (!cardStr || cardStr === '??') return '/cards/backs/carbon.webp';

  const rankChar = cardStr[0].toLowerCase();
  const suitChar = cardStr[1].toLowerCase();

  let rank = rankChar;
  if (rank === 't') rank = '10';

  let suit = 'spades';
  if (suitChar === 'c') suit = 'clubs';
  else if (suitChar === 'd') suit = 'diamonds';
  else if (suitChar === 'h') suit = 'hearts';
  else if (suitChar === 's') suit = 'spades';

  return `/cards/${suit}_${rank}.png`;
}

function getSeatPosition(seatIndex: number, totalSeats: number): THREE.Vector3 {
  const angle = (seatIndex / totalSeats) * Math.PI * 2 - Math.PI / 2;
  const rx = TABLE_RADIUS * 1.3;
  const rz = TABLE_RADIUS * 0.85;
  return new THREE.Vector3(Math.cos(angle) * rx, TABLE_HEIGHT + 0.01, Math.sin(angle) * rz);
}

class PokerTable3D {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  animationId: number | null = null;

  cards: Map<string, THREE.Mesh> = new Map();
  chipStacks: Map<string, THREE.Group> = new Map();

  seatCount: number;
  isDisposed = false;

  constructor(canvas: HTMLCanvasElement, seatCount: number, feltColor: string) {
    this.seatCount = seatCount;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a0a14'); // Dark premium background

    this.camera = new THREE.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 100);
    this.camera.position.set(0, 8, 7);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(canvas.width, canvas.height);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambientLight);

    const spotLight = new THREE.SpotLight(0xfff5e6, 1.5, 20, Math.PI / 4, 0.5);
    spotLight.position.set(0, 10, 0);
    spotLight.castShadow = true;
    spotLight.shadow.mapSize.set(2048, 2048);
    spotLight.shadow.bias = -0.0001;
    this.scene.add(spotLight);

    const rimLight = new THREE.DirectionalLight(0x00d4ff, 0.5); // Cyan premium rim light
    rimLight.position.set(-5, 3, -5);
    this.scene.add(rimLight);

    this.buildTable(feltColor);
    this.buildSeatMarkers();
  }

  private buildTable(feltColor: string): void {
    const feltGeometry = new THREE.CylinderGeometry(
      TABLE_RADIUS * 1.3,
      TABLE_RADIUS * 1.3,
      TABLE_HEIGHT,
      64
    );
    feltGeometry.scale(1, 1, 0.65);

    // Subtle noise bump map could be added here, using roughness for now
    const feltMaterial = new THREE.MeshStandardMaterial({
      color: feltColor,
      roughness: 0.9,
      metalness: 0.1,
    });
    const felt = new THREE.Mesh(feltGeometry, feltMaterial);
    felt.position.y = TABLE_HEIGHT / 2;
    felt.receiveShadow = true;
    this.scene.add(felt);

    const railGeometry = new THREE.TorusGeometry(TABLE_RADIUS * 1.3, 0.2, 32, 64);
    railGeometry.scale(1, 1, 0.65);
    const railMaterial = new THREE.MeshStandardMaterial({
      color: RAIL_COLOR,
      roughness: 0.2,
      metalness: 0.8, // Premium leather/metallic look
    });
    const rail = new THREE.Mesh(railGeometry, railMaterial);
    rail.position.y = TABLE_HEIGHT + RAIL_HEIGHT / 2 - 0.05;
    rail.rotation.x = Math.PI / 2;
    rail.castShadow = true;
    this.scene.add(rail);
  }

  private buildSeatMarkers(): void {
    for (let i = 0; i < this.seatCount; i++) {
      const pos = getSeatPosition(i, this.seatCount);
      const geo = new THREE.RingGeometry(0.3, 0.35, 32);
      const mat = new THREE.MeshBasicMaterial({
        color: 0x00d4ff,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
      });
      const marker = new THREE.Mesh(geo, mat);
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(pos.x, pos.y + 0.01, pos.z);
      this.scene.add(marker);
    }
  }

  private createCardMesh(cardStr: string): THREE.Mesh {
    const geo = new THREE.BoxGeometry(CARD_WIDTH, 0.005, CARD_HEIGHT);
    const backTex = getTexture('/cards/backs/carbon.webp');
    let frontTex = backTex;

    if (cardStr !== '??') {
      frontTex = getTexture(getCardTexturePath(cardStr));
    }

    const whiteEdge = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
    const frontMat = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.3 });
    const backMat = new THREE.MeshStandardMaterial({ map: backTex, roughness: 0.4 });

    // Materials order for BoxGeometry: right, left, top, bottom, front, back
    const materials = [whiteEdge, whiteEdge, frontMat, backMat, whiteEdge, whiteEdge];
    const card = new THREE.Mesh(geo, materials);
    card.castShadow = true;
    return card;
  }

  public syncSnapshot(snapshot: ReplaySnapshot) {
    const activeCardKeys = new Set<string>();
    const activeChipKeys = new Set<string>();

    // 1. Community Cards
    snapshot.communityCards.forEach((cardStr, index) => {
      const key = `comm_${index}`;
      activeCardKeys.add(key);
      if (!this.cards.has(key)) {
        const card = this.createCardMesh(cardStr);
        // Start from dealer (center-ish or top)
        card.position.set(0, TABLE_HEIGHT + 2, -2);
        card.rotation.x = Math.PI; // Face down initially
        this.scene.add(card);
        this.cards.set(key, card);

        const xOffset = (index - 2) * (CARD_WIDTH + 0.08);

        // GSAP Animation dealing to center
        gsap.to(card.position, {
          x: xOffset,
          y: TABLE_HEIGHT + 0.02,
          z: 0,
          duration: 0.6,
          delay: index * 0.1,
          ease: 'power2.out',
        });

        // Flip over
        gsap.to(card.rotation, {
          x: 0,
          duration: 0.5,
          delay: index * 0.1 + 0.2,
          ease: 'back.out(1.5)',
        });
      }
    });

    // 2. Player Cards & Bets
    snapshot.players.forEach((player) => {
      if (!player.isFolded) {
        player.cards.forEach((cardStr, idx) => {
          const key = `p_${player.seat}_c_${idx}`;
          activeCardKeys.add(key);

          if (!this.cards.has(key)) {
            const card = this.createCardMesh(cardStr);
            // Start from dealer
            card.position.set(0, TABLE_HEIGHT + 2, -2);
            card.rotation.x = Math.PI; // Face down
            this.scene.add(card);
            this.cards.set(key, card);

            const seatPos = getSeatPosition(player.seat, this.seatCount);
            const xOffset = (idx - 0.5) * 0.15;

            // GSAP Deal to player
            gsap.to(card.position, {
              x: seatPos.x * 0.8 + xOffset,
              y: TABLE_HEIGHT + 0.02,
              z: seatPos.z * 0.8,
              duration: 0.5,
              delay: player.seat * 0.05 + idx * 0.1,
              ease: 'power2.out',
            });

            // If it's a known card, flip it
            if (cardStr !== '??') {
              gsap.to(card.rotation, {
                x: 0,
                z: (Math.random() - 0.5) * 0.1, // slight rotation for realism
                duration: 0.4,
                delay: player.seat * 0.05 + idx * 0.1 + 0.3,
                ease: 'power2.out',
              });
            }
          } else {
            // Check if card changed from ?? to known (showdown flip)
            const existingCard = this.cards.get(key)!;
            if (cardStr !== '??' && existingCard.rotation.x >= Math.PI - 0.1) {
              const tex = getTexture(getCardTexturePath(cardStr));
              if (Array.isArray(existingCard.material)) {
                (existingCard.material[2] as THREE.MeshStandardMaterial).map = tex;
                (existingCard.material[2] as THREE.MeshStandardMaterial).needsUpdate = true;
              }
              gsap.to(existingCard.rotation, {
                x: 0,
                duration: 0.5,
                ease: 'back.out(1.5)',
              });
            }
          }
        });
      }

      // Chips
      if (player.bet > 0) {
        const key = `chip_${player.seat}`;
        activeChipKeys.add(key);
        if (!this.chipStacks.has(key)) {
          const group = this.createChipStack(player.bet);
          const seatPos = getSeatPosition(player.seat, this.seatCount);
          group.position.set(seatPos.x * 0.7, TABLE_HEIGHT + 0.5, seatPos.z * 0.7);
          this.scene.add(group);
          this.chipStacks.set(key, group);

          gsap.to(group.position, {
            y: TABLE_HEIGHT + 0.01,
            duration: 0.4,
            ease: 'bounce.out',
          });
        } else {
          // If the bet changed, update the chips? For simplicity, we can just replace it.
          // But GSAP makes it tricky. We'll just leave it for now unless they bet more.
        }
      }
    });

    // 3. Remove old cards/chips
    for (const [key, card] of this.cards.entries()) {
      if (!activeCardKeys.has(key)) {
        gsap.to(card.position, {
          x: 0,
          y: TABLE_HEIGHT + 0.05,
          z: 0,
          duration: 0.4,
          ease: 'power2.in',
          onComplete: () => {
            this.scene.remove(card);
            this.cards.delete(key);
          },
        });
        gsap.to(card.rotation, { x: Math.PI, duration: 0.4 });
      }
    }

    for (const [key, stack] of this.chipStacks.entries()) {
      if (!activeChipKeys.has(key)) {
        gsap.to(stack.position, {
          x: (Math.random() - 0.5) * 1,
          z: (Math.random() - 0.5) * 1,
          duration: 0.5,
          ease: 'power2.inOut',
          onComplete: () => {
            this.scene.remove(stack);
            this.chipStacks.delete(key);
          },
        });
      }
    }
  }

  private createChipStack(amount: number): THREE.Group {
    const group = new THREE.Group();
    const chipCount = Math.min(Math.ceil(amount / 100), 10);
    const chipColor = amount >= 1000 ? '#f97316' : amount >= 100 ? '#00d4ff' : '#ef4444';

    for (let i = 0; i < chipCount; i++) {
      const chipGeo = new THREE.CylinderGeometry(CHIP_RADIUS, CHIP_RADIUS, CHIP_HEIGHT, 32);
      const chipMat = new THREE.MeshStandardMaterial({
        color: chipColor,
        roughness: 0.3,
        metalness: 0.6,
      });
      const chip = new THREE.Mesh(chipGeo, chipMat);
      chip.position.y = i * (CHIP_HEIGHT + 0.002);
      chip.castShadow = true;
      group.add(chip);
    }
    return group;
  }

  startRenderLoop(): void {
    const animate = () => {
      if (this.isDisposed) return;
      this.animationId = requestAnimationFrame(animate);
      this.renderer.render(this.scene, this.camera);
    };
    animate();
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.animationId !== null) cancelAnimationFrame(this.animationId);

    gsap.killTweensOf(this.camera.position);
    for (const card of this.cards.values()) gsap.killTweensOf(card.position);
    for (const stack of this.chipStacks.values()) gsap.killTweensOf(stack.position);

    this.renderer.dispose();
  }
}

function HandReplay3DComponent({
  active,
  seatCount,
  feltColor = DEFAULT_FELT_COLOR,
  orbitControls = true,
  speed = 1,
  onReady,
  snapshot,
}: HandReplay3DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PokerTable3D | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (!active || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;

    const scene = new PokerTable3D(canvas, seatCount, feltColor);
    scene.startRenderLoop();
    sceneRef.current = scene;

    setIsReady(true);
    onReadyRef.current?.();

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
  }, [active, seatCount, feltColor]);

  useEffect(() => {
    if (!isReady || !sceneRef.current || !snapshot) return;
    const scene = sceneRef.current;
    scene.syncSnapshot(snapshot);

    if (snapshot.communityCards.length === 5) {
      gsap.to(scene.camera.position, {
        y: 5,
        z: 8,
        duration: 2,
        ease: 'power2.out',
      });
      gsap.to(scene.camera.rotation, {
        x: -Math.PI / 6,
        duration: 2,
        ease: 'power2.out',
      });
    } else {
      gsap.to(scene.camera.position, {
        y: 8,
        z: 7,
        duration: 1,
        ease: 'power2.out',
      });
      gsap.to(scene.camera.rotation, {
        x: -0.7,
        duration: 1,
        ease: 'power2.out',
      });
    }
  }, [isReady, snapshot]);

  if (!active) return null;

  return (
    <div
      ref={containerRef}
      className="hand-replay-3d"
      style={{
        width: '100%',
        height: '100%',
        minHeight: '400px',
        position: 'relative',
        borderRadius: '16px',
        overflow: 'hidden',
        background: '#0a0a14',
        boxShadow: 'inset 0 0 40px rgba(0,0,0,0.8)',
      }}
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
            color: '#00d4ff',
            fontSize: '14px',
            fontFamily: 'Orbitron, sans-serif',
          }}
        >
          INITIALIZING CINEMATIC ENGINE...
        </div>
      )}
    </div>
  );
}

export const HandReplay3D = memo(HandReplay3DComponent);
export default HandReplay3D;
