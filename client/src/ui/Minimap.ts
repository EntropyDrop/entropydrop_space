import { CHUNK_SIZE_X, CHUNK_SIZE_Y, CHUNK_SIZE_Z } from '@entropydrop/space-engine/voxel/Chunk.ts';
import { MICRO_DIVISIONS } from '@entropydrop/space-engine/voxel/MicroVoxelLayer.ts';
import { TORUS_SIZE_X, TORUS_SIZE_Z, wrapX, wrapZ, wrapChunkX, wrapChunkZ } from '@entropydrop/space-engine/torus/TorusWorld.ts';

type CachedChunkSurface = {
  dataVersion: number | null;
  heights: Int16Array;
  colors: Uint32Array;
};

type CachedMicroChunkSurface = {
  dataVersion: number | null;
  heights: Float32Array;
  colors: Uint32Array;
};

/**
 * Bottom-right minimap rendered on a top-down 2D canvas with seamless Torus wrap.
 * - Terrain: scans the highest standard or microblock in each loaded chunk column
 *   and draws its actual color; unloaded regions appear dark as fog of war.
 * - Entities: contraptions are dots, with the driven vehicle highlighted.
 * - Player: a white arrow points along camera yaw.
 * The terrain layer is rebuilt only after grid movement or voxel-version changes;
 * each frame redraws only the overlay.
 */
export class Minimap {
  canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  world: any;
  contraptionManager: any;

  static SIZE = 192; // CSS px
  static RANGE = 96; // Covers ±96 cells, matching the guaranteed six-chunk render radius.
  static CELLS = 192; // 192x192 world cells at 1 px per cell; integer alignment prevents shimmer.
  static VOID_COLOR = [12, 16, 24]; // Unloaded region.

  terrainCanvas: HTMLCanvasElement;
  terrainCtx: CanvasRenderingContext2D;
  size = Minimap.SIZE;
  gridCenterX = 0;
  gridCenterZ = 0;
  lastVersion = -1;
  lastGridX = 0;
  lastGridZ = 0;
  lastRecompute = 0;
  heights: Float32Array = new Float32Array(Minimap.CELLS * Minimap.CELLS);
  colors: Uint32Array = new Uint32Array(Minimap.CELLS * Minimap.CELLS);
  imageData: ImageData | null = null;
  remotePlayers: any[];
  dpr = 1;
  private enabled = true;
  private chunkSurfaceCache = new WeakMap<object, CachedChunkSurface>();
  private microSurfaceLayer: any = null;
  private microSurfaceCache = new Map<string, CachedMicroChunkSurface>();

  private readonly resizeHandler = () => this.applySize();

  constructor(world, contraptionManager) {
    this.world = world;
    this.contraptionManager = contraptionManager;

    this.terrainCanvas = document.createElement('canvas');
    this.terrainCanvas.width = Minimap.CELLS;
    this.terrainCanvas.height = Minimap.CELLS;
    this.terrainCtx = this.terrainCanvas.getContext('2d')!;
    this.imageData = this.terrainCtx.createImageData(Minimap.CELLS, Minimap.CELLS);
    this.remotePlayers = [];

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.resizeHandler);
    }
  }

  /** React owns the visible canvas and provides it through this lifecycle hook. */
  attachCanvas(canvas: HTMLCanvasElement | null) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext('2d') || null;
    if (canvas) this.applySize();
  }

  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.resizeHandler);
    this.attachCanvas(null);
  }

  applySize() {
    if (typeof window === 'undefined') return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!this.canvas) return;
    const containerWidth = this.canvas.parentElement?.clientWidth || Minimap.SIZE + 8;
    this.size = Math.max(96, Math.min(Minimap.SIZE, containerWidth - 8 || Minimap.SIZE));
    const size = this.size;
    this.canvas.width = size * this.dpr;
    this.canvas.height = size * this.dpr;
    this.canvas.style.width = `${size}px`;
    this.canvas.style.height = `${size}px`;
  }

  setRemotePlayers(players: any[]) {
    this.remotePlayers = Array.isArray(players) ? players : [];
  }

  setEnabled(enabled: boolean): boolean {
    this.enabled = Boolean(enabled);
    return this.enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Called every frame.
   * @param playerPos Player world coordinates {x, z}.
   * @param yaw Camera yaw in radians using YXZ order.
   * @param isDriving Whether the player is driving.
   * @param drivenContraption The driven entity, or null.
   */
  update(playerPos, yaw, isDriving, drivenContraption) {
    if (!this.enabled || !this.canvas || !this.ctx) return;
    const px = playerPos.x;
    const pz = playerPos.z;
    const now = performance.now();

    // Rebuild after integer-grid movement or voxel-version changes, throttled to
    // 150 ms so scripts that edit every frame cannot force continuous rebuilds.
    const gridX = Math.floor(px);
    const gridZ = Math.floor(pz);
    const version = this.world?.terrainVersion || 0;
    if ((gridX !== this.lastGridX || gridZ !== this.lastGridZ || version !== this.lastVersion || this.lastRecompute === 0) &&
        (now - this.lastRecompute >= 150 || this.lastRecompute === 0)) {
      this.recomputeTerrain(gridX, gridZ);
      this.lastGridX = gridX;
      this.lastGridZ = gridZ;
      this.lastVersion = version;
      this.lastRecompute = now;
    }

    // Composite the terrain layer, entities, and player every frame.
    const ctx = this.ctx;
    const size = this.size;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainCanvas, 0, 0, Minimap.CELLS, Minimap.CELLS, 0, 0, size, size);

    // Entity dots with toroidal shortest displacement
    const scale = size / Minimap.CELLS;
    const list = this.contraptionManager?.contraptions || [];
    for (const c of list) {
      if (!c || !c.position) continue;
      let dx = wrapX(c.position.x) - wrapX(px);
      if (dx > TORUS_SIZE_X / 2) dx -= TORUS_SIZE_X;
      else if (dx < -TORUS_SIZE_X / 2) dx += TORUS_SIZE_X;

      let dz = wrapZ(c.position.z) - wrapZ(pz);
      if (dz > TORUS_SIZE_Z / 2) dz -= TORUS_SIZE_Z;
      else if (dz < -TORUS_SIZE_Z / 2) dz += TORUS_SIZE_Z;

      const cx = (dx + Minimap.RANGE) * scale;
      const cz = (dz + Minimap.RANGE) * scale;
      if (cx < 0 || cx > size || cz < 0 || cz > size) continue;
      const driven = isDriving && drivenContraption === c;
      ctx.beginPath();
      ctx.arc(cx, cz, driven ? 3.5 : 2.6, 0, Math.PI * 2);
      ctx.fillStyle = driven ? '#ffe066' : '#f2a93b';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
      ctx.stroke();
      if (driven) {
        ctx.beginPath();
        ctx.arc(cx, cz, 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 224, 102, 0.7)';
        ctx.stroke();
      }
    }

    // Remote Players (cyan dots)
    for (const rp of this.remotePlayers) {
      if (rp.is_self) continue;
      let rdx = wrapX(rp.x) - wrapX(px);
      if (rdx > TORUS_SIZE_X / 2) rdx -= TORUS_SIZE_X;
      else if (rdx < -TORUS_SIZE_X / 2) rdx += TORUS_SIZE_X;

      let rdz = wrapZ(rp.z) - wrapZ(pz);
      if (rdz > TORUS_SIZE_Z / 2) rdz -= TORUS_SIZE_Z;
      else if (rdz < -TORUS_SIZE_Z / 2) rdz += TORUS_SIZE_Z;

      const rcx = (rdx + Minimap.RANGE) * scale;
      const rcz = (rdz + Minimap.RANGE) * scale;
      if (rcx < 0 || rcx > size || rcz < 0 || rcz > size) continue;

      ctx.beginPath();
      ctx.arc(rcx, rcz, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#00d2d3';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(10, 12, 18, 0.9)';
      ctx.stroke();

      // Heading tick
      const ryaw = Number(rp.yaw) || 0;
      const hx = -Math.sin(ryaw) * 5;
      const hz = -Math.cos(ryaw) * 5;
      ctx.beginPath();
      ctx.moveTo(rcx, rcz);
      ctx.lineTo(rcx + hx, rcz + hz);
      ctx.strokeStyle = '#00d2d3';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Player arrow: world +X is right, +Z is down; camera heading is -sin(yaw), -cos(yaw).
    const ax = -Math.sin(yaw);
    const az = -Math.cos(yaw);
    const cx = size / 2;
    const cz = size / 2;
    const len = 9;
    const half = 4.5;
    ctx.beginPath();
    ctx.moveTo(cx + ax * len, cz + az * len);
    ctx.lineTo(cx - az * half, cz + ax * half);
    ctx.lineTo(cx + az * half, cz - ax * half);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(10, 12, 18, 0.85)';
    ctx.stroke();
  }

  /** Cache the standard-block top sample until that chunk's voxel data changes. */
  private getChunkSurface(chunk: any): CachedChunkSurface {
    const dataVersion = Number.isFinite(chunk.dataVersion) ? Number(chunk.dataVersion) : null;
    const cached = dataVersion === null ? null : this.chunkSurfaceCache.get(chunk);
    if (cached?.dataVersion === dataVersion) return cached;

    const cellCount = CHUNK_SIZE_X * CHUNK_SIZE_Z;
    const heights = new Int16Array(cellCount);
    const colors = new Uint32Array(cellCount);
    heights.fill(-1);

    // Generated terrain only occupies a small vertical slice (normally
    // around y=10..20). Starting every column at y=255 used to turn one
    // minimap refresh into roughly ten million empty-block probes.
    const hasOccupiedRange = typeof chunk.getOccupiedYRange === 'function';
    const occupiedRange = hasOccupiedRange ? chunk.getOccupiedYRange() : null;
    const scanTopY = hasOccupiedRange && !occupiedRange
      ? -1
      : Math.min(CHUNK_SIZE_Y - 1, occupiedRange?.max ?? CHUNK_SIZE_Y - 1);
    const blocks = chunk.blocks instanceof Uint8Array ? chunk.blocks : null;
    const terrainColors = chunk.colors instanceof Uint32Array ? chunk.colors : null;

    if (scanTopY >= 0) {
      for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
        for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
          const surfaceIndex = lz * CHUNK_SIZE_X + lx;
          for (let y = scanTopY; y >= 0; y--) {
            const blockIndex = (y * CHUNK_SIZE_Z + lz) * CHUNK_SIZE_X + lx;
            const block = blocks ? blocks[blockIndex] : chunk.getLocalBlock(lx, y, lz);
            if (block === 0) continue;
            heights[surfaceIndex] = y;
            colors[surfaceIndex] = terrainColors
              ? terrainColors[blockIndex]
              : chunk.getLocalColor(lx, y, lz);
            break;
          }
        }
      }
    }

    const surface = { dataVersion, heights, colors };
    // Duck-typed/legacy chunks without a revision cannot be safely cached.
    if (dataVersion !== null) this.chunkSurfaceCache.set(chunk, surface);
    return surface;
  }

  /** Revisit only changed visible micro chunks, using their numeric cell index. */
  private getMicroChunkSurface(layer: any, cx: number, cz: number): CachedMicroChunkSurface | null {
    if (typeof layer?.forEachCellInChunk !== 'function') return null;
    const key = `${cx},${cz}`;
    const revision = layer.getChunkRevision?.(cx, cz);
    const dataVersion = Number.isFinite(revision) ? Number(revision) : null;
    const cached = dataVersion === null ? null : this.microSurfaceCache.get(key);
    if (cached?.dataVersion === dataVersion) return cached;

    const cellCount = CHUNK_SIZE_X * CHUNK_SIZE_Z;
    const heights = new Float32Array(cellCount);
    const colors = new Uint32Array(cellCount);
    const originX = cx * CHUNK_SIZE_X;
    const originZ = cz * CHUNK_SIZE_Z;
    layer.forEachCellInChunk(cx, cz, (mx: number, my: number, mz: number, color: number) => {
      const lx = Math.floor(mx / MICRO_DIVISIONS) - originX;
      const lz = Math.floor(mz / MICRO_DIVISIONS) - originZ;
      const index = lz * CHUNK_SIZE_X + lx;
      const topY = (my + 1) / MICRO_DIVISIONS;
      if (topY > heights[index]) {
        heights[index] = topY;
        colors[index] = color;
      }
    });

    const surface = { dataVersion, heights, colors };
    if (dataVersion !== null) this.microSurfaceCache.set(key, surface);
    return surface;
  }

  /** Rebuild the terrain layer on an offscreen canvas with toroidal wrap around integer world coordinates. */
  recomputeTerrain(centerX, centerZ) {
    const C = Minimap.CELLS;
    const halfRange = Minimap.RANGE;
    this.gridCenterX = centerX;
    this.gridCenterZ = centerZ;

    this.heights.fill(0);
    this.colors.fill(0);

    const world = this.world;
    if (!world || !world.chunks) return;

    const wrappedCenterX = wrapX(centerX);
    const wrappedCenterZ = wrapZ(centerZ);

    const centerChunkX = Math.floor(wrappedCenterX / CHUNK_SIZE_X);
    const centerChunkZ = Math.floor(wrappedCenterZ / CHUNK_SIZE_Z);
    const chunkRadius = Math.ceil(halfRange / CHUNK_SIZE_X); // 6 chunks covers ±96m

    const microLayer = world.microVoxels;
    if (microLayer !== this.microSurfaceLayer) {
      this.microSurfaceLayer = microLayer;
      this.microSurfaceCache.clear();
    }
    const visibleChunkKeys = new Set<string>();

    // 1) Standard and micro blocks: query only chunks around the player. Their
    // surface caches are independent, so a micro edit cannot rescan unchanged
    // standard blocks or microcells elsewhere in the world.
    for (let dcx = -chunkRadius; dcx <= chunkRadius; dcx++) {
      const cx = wrapChunkX(centerChunkX + dcx);
      for (let dcz = -chunkRadius; dcz <= chunkRadius; dcz++) {
        const cz = wrapChunkZ(centerChunkZ + dcz);
        visibleChunkKeys.add(`${cx},${cz}`);
        const chunk = world.getChunk ? world.getChunk(cx, cz) : world.chunks.get(`${cx},${cz}`);
        const surface = chunk ? this.getChunkSurface(chunk) : null;
        const microSurface = this.getMicroChunkSurface(microLayer, cx, cz);
        if (!surface && !microSurface) continue;

        for (let lx = 0; lx < CHUNK_SIZE_X; lx++) {
          const cellWx = cx * CHUNK_SIZE_X + lx;
          let dx = cellWx - wrappedCenterX;
          if (dx > TORUS_SIZE_X / 2) dx -= TORUS_SIZE_X;
          else if (dx < -TORUS_SIZE_X / 2) dx += TORUS_SIZE_X;

          const gx = Math.round(dx + halfRange);
          if (gx < 0 || gx >= C) continue;

          for (let lz = 0; lz < CHUNK_SIZE_Z; lz++) {
            const cellWz = cz * CHUNK_SIZE_Z + lz;
            let dz = cellWz - wrappedCenterZ;
            if (dz > TORUS_SIZE_Z / 2) dz -= TORUS_SIZE_Z;
            else if (dz < -TORUS_SIZE_Z / 2) dz += TORUS_SIZE_Z;

            const gz = Math.round(dz + halfRange);
            if (gz < 0 || gz >= C) continue;

            const i = gz * C + gx;
            const surfaceIndex = lz * CHUNK_SIZE_X + lx;
            const topY = surface?.heights[surfaceIndex] ?? -1;
            if (topY >= 0 && surface) {
              this.heights[i] = topY + 1; // 0 means no block.
              this.colors[i] = surface.colors[surfaceIndex];
            }
            const microTopY = microSurface?.heights[surfaceIndex] ?? 0;
            if (microTopY > this.heights[i] && microSurface) {
              this.heights[i] = microTopY;
              this.colors[i] = microSurface.colors[surfaceIndex];
            }
          }
        }
      }
    }

    // Keep cache memory bounded as the player travels across the world.
    for (const key of this.microSurfaceCache.keys()) {
      if (!visibleChunkKeys.has(key)) this.microSurfaceCache.delete(key);
    }

    // 2) Fill ImageData with height shading.
    if (!this.imageData) return;
    const data = this.imageData.data;
    const voidR = Minimap.VOID_COLOR[0], voidG = Minimap.VOID_COLOR[1], voidB = Minimap.VOID_COLOR[2];
    for (let i = 0; i < C * C; i++) {
      const h = this.heights[i];
      const o = i * 4;
      if (h <= 0) {
        data[o] = voidR; data[o + 1] = voidG; data[o + 2] = voidB; data[o + 3] = 255;
        continue;
      }
      const color = this.colors[i];
      const shade = 0.72 + 0.28 * Math.min(1, (h - 1) / (CHUNK_SIZE_Y - 1));
      data[o] = ((color >> 16) & 0xff) * shade;
      data[o + 1] = ((color >> 8) & 0xff) * shade;
      data[o + 2] = (color & 0xff) * shade;
      data[o + 3] = 255;
    }

    this.terrainCtx.putImageData(this.imageData, 0, 0);
  }
}
