import { SpaceRenderer } from './SpaceRenderer.ts';
import * as THREE from 'three/webgpu';
import { normalizeColor } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { normalizeVoxelMaterialId, VoxelMaterialIds } from '@entropydrop/space-engine/voxel/VoxelMaterials.ts';
import { getInventoryPreviewBlocks } from './SceneRenderer.ts';

export class InventoryThumbnailRenderer {
  private static instance: InventoryThumbnailRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: SpaceRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private thumbnailCache = new Map<string, string>();
  private webgpuAvailable: boolean = true;

  static getInstance(): InventoryThumbnailRenderer {
    if (!InventoryThumbnailRenderer.instance) {
      InventoryThumbnailRenderer.instance = new InventoryThumbnailRenderer();
    }
    return InventoryThumbnailRenderer.instance;
  }

  private readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Set<string>();
  private failed = new Set<string>();
  private listeners = new Set<() => void>();
  private revision = 0;
  private generation = 0;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly getRevision = () => this.revision;
  constructor() { this.ready = this.initSandbox(); }
  private notify() { this.revision++; for (const listener of this.listeners) listener(); }


  private async initSandbox() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      this.webgpuAvailable = false;
      return;
    }

    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 128;
      this.canvas.height = 128;

      this.renderer = new SpaceRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'low-power'
      });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(128, 128, false);
      this.renderer.setClearColor(0x000000, 0); // Transparent background

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 500);

      // Studio 3-point lighting setup
      const ambientLight = new THREE.AmbientLight(0xffffff, 0.85);
      this.scene.add(ambientLight);

      const mainLight = new THREE.DirectionalLight(0xffffff, 1.4);
      mainLight.position.set(3, 4, 3.5);
      this.scene.add(mainLight);

      const fillLight = new THREE.DirectionalLight(0x88b0ff, 0.6);
      fillLight.position.set(-3, 1, -2);
      this.scene.add(fillLight);

      const topLight = new THREE.DirectionalLight(0xffffff, 0.5);
      topLight.position.set(0, 5, 0);
      this.scene.add(topLight);
      this.camera.coordinateSystem = THREE.WebGPUCoordinateSystem;
      await this.renderer.initialize();
    } catch (e) {
      this.webgpuAvailable = false;
      this.renderer = null;
      this.scene = null;
      this.camera = null;
    }
  }

  /**
   * Compute a deterministic cache key for an inventory slot item.
   */
  private getItemCacheKey(item: any, size: number): string {
    if (!item) return '';
    if (item.kind === 'item') {
      const geometry = getInventoryPreviewBlocks(item, true).map(entry => (
        `${entry.center.toArray()}:${entry.size}:${entry.color}:${normalizeVoxelMaterialId(entry.materialId)}:${entry.scale?.toArray()}:${entry.quaternion?.toArray()}`
      )).join(';');
      return `item:${geometry}:${size}`;
    }
    const kind = item.kind
      || (item.type === 'space-entity' || Array.isArray(item.childEntities) ? 'entity' : 'blockset');
    const blockCount = item.blockCount || item.blocks?.length || 0;
    const name = item.name || '';
    const childCount = item.childEntities?.length || 0;

    // Fast signature from sample blocks
    const sample = (item.blocks || []).slice(0, 5).map((b: any) =>
      `${b.localX ?? b.dx}_${b.localY ?? b.dy}_${b.localZ ?? b.dz}_${b.color}_${b.size || 1}_${normalizeVoxelMaterialId(b.materialId)}`
    ).join(';');

    const decorationSignature = JSON.stringify([item.decorations, (item.childEntities || []).map(child => child.decorations)]);
    return `${kind}:${name}:${blockCount}:${childCount}:${sample}:${decorationSignature}:${size}`;
  }

  /**
   * Generate or retrieve a cached thumbnail Data URL for an inventory item (blockset or resting entity).
   */
  getThumbnail(item: any, size = 128): string | null {
    if (!item?.blocks?.length) return null;
    const key = this.getItemCacheKey(item,size);
    if (this.thumbnailCache.has(key)) return this.thumbnailCache.get(key)!;
    if (!this.pending.has(key) && !this.failed.has(key)) {
      this.pending.add(key);
      const generation = this.generation;
      this.queue = this.queue.then(async () => {
        await this.ready;
        if (generation !== this.generation) return;
        const url = await this.generateThumbnail(item,size);
        if (generation !== this.generation) return;
        if (url) this.thumbnailCache.set(key,url); else this.failed.add(key);
      }).catch(error => { this.failed.add(key); console.warn('Thumbnail rendering failed:',error); })
        .finally(() => { this.pending.delete(key); this.notify(); });
    }
    return null;
  }

  private async generateThumbnail(item: any, size: number): Promise<string | null> {
    if (!item || !item.blocks || item.blocks.length === 0) return null;

    const cacheKey = this.getItemCacheKey(item, size);
    if (this.thumbnailCache.has(cacheKey)) {
      return this.thumbnailCache.get(cacheKey)!;
    }

    if (!this.webgpuAvailable || !this.renderer || !this.scene || !this.camera || !this.canvas) {
      return null;
    }

    const tempGroup = new THREE.Group();
    const createdMeshes: THREE.InstancedMesh[] = [];
    try {
      // 1. Convert inventory item into resting / stopped state voxel instances
      const previewBlocks = getInventoryPreviewBlocks(item, true);
      if (!previewBlocks || previewBlocks.length === 0) return null;

      // 2. Compute bounding box
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (const block of previewBlocks) {
        const half = block.decoration ? block.scale.length() / 2 : (Number(block.size) || 1) / 2;
        minX = Math.min(minX, block.center.x - half);
        minY = Math.min(minY, block.center.y - half);
        minZ = Math.min(minZ, block.center.z - half);
        maxX = Math.max(maxX, block.center.x + half);
        maxY = Math.max(maxY, block.center.y + half);
        maxZ = Math.max(maxZ, block.center.z + half);
      }

      const centerX = (minX + maxX) / 2;
      const centerY = (minY + maxY) / 2;
      const centerZ = (minZ + maxZ) / 2;

      const sizeX = maxX - minX;
      const sizeY = maxY - minY;
      const sizeZ = maxZ - minZ;
      const maxExtent = Math.max(sizeX, sizeY, sizeZ, 1);
      const boundingRadius = Math.max(0.5, Math.hypot(sizeX, sizeY, sizeZ) / 2);

      // 3. Build meshes grouped by block size and material.
      const blocksByGroup = new Map<string, any[]>();
      for (const block of previewBlocks) {
        const s = Number(block.size) || 1;
        const materialId = normalizeVoxelMaterialId(block.materialId);
        const key = `${s}:${materialId}`;
        if (!blocksByGroup.has(key)) blocksByGroup.set(key, []);
        blocksByGroup.get(key)!.push(block);
      }

      const dummy = new THREE.Object3D();
      const colorHelper = new THREE.Color();


      for (const [key, blocks] of blocksByGroup.entries()) {
        const [sizeText, materialText] = key.split(':');
        const s = Number(sizeText);
        const materialId = Number(materialText);
        const geom = new THREE.BoxGeometry(s, s, s);
        const mat = materialId === VoxelMaterialIds.EMISSIVE
          ? new THREE.MeshBasicNodeMaterial({ toneMapped: false })
          : new THREE.MeshStandardNodeMaterial({ roughness: 0.45, metalness: 0.05 });

        const instancedMesh = new THREE.InstancedMesh(geom, mat, blocks.length);
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          dummy.position.set(
            b.center.x - centerX,
            b.center.y - centerY,
            b.center.z - centerZ
          );
          dummy.scale.set(1, 1, 1);
          dummy.quaternion.identity();
          if (b.scale) dummy.scale.copy(b.scale);
          if (b.quaternion) dummy.quaternion.copy(b.quaternion);
          dummy.updateMatrix();
          instancedMesh.setMatrixAt(i, dummy.matrix);

          const col = normalizeColor(b.color);
          colorHelper.setHex(col);
          instancedMesh.setColorAt(i, colorHelper);
        }
        instancedMesh.instanceMatrix.needsUpdate = true;
        if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true;

        tempGroup.add(instancedMesh);
        createdMeshes.push(instancedMesh);
      }

      this.scene.add(tempGroup);

      // 4. Setup camera at isometric 3D angle (yaw ~40 deg, pitch ~28 deg)
      const fovRad = THREE.MathUtils.degToRad(this.camera.fov);
      const fitDistance = (boundingRadius * 1.35) / Math.sin(fovRad / 2);
      const cameraDistance = Math.max(2.5, fitDistance);

      const yaw = THREE.MathUtils.degToRad(42);
      const pitch = THREE.MathUtils.degToRad(28);
      const cosPitch = Math.cos(pitch);

      this.camera.aspect = 1;
      this.camera.near = Math.max(0.1, cameraDistance - boundingRadius * 2);
      this.camera.far = cameraDistance + boundingRadius * 4;
      this.camera.position.set(
        cameraDistance * Math.sin(yaw) * cosPitch,
        cameraDistance * Math.sin(pitch),
        cameraDistance * Math.cos(yaw) * cosPitch
      );
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();

      // 5. Render
      if (this.canvas.width !== size || this.canvas.height !== size) {
        this.canvas.width = size;
        this.canvas.height = size;
        this.renderer.setSize(size, size, false);
      }

      const target = new THREE.RenderTarget(size,size,{ samples:4 });
      target.texture.colorSpace = THREE.SRGBColorSpace;
      let dataUrl: string;
      try {
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene,this.camera);
        const pixels = await this.renderer.readRenderTargetPixelsAsync(target,0,0,size,size);
        // Canvas2D only encodes already-rendered GPU pixels as a PNG.
        const encoder = document.createElement('canvas'); encoder.width=size; encoder.height=size;
        encoder.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(pixels as Uint8Array),size,size),0,0);
        dataUrl = encoder.toDataURL('image/png');
      } finally { this.renderer.setRenderTarget(null); target.dispose(); }

      if (dataUrl && dataUrl.length > 50) {
        return dataUrl;
      }
    } catch (e) {
      console.warn('Failed to generate inventory thumbnail:', e);
    } finally {
      this.scene.remove(tempGroup);
      for (const mesh of createdMeshes) {
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) material.dispose();
      }
    }

    return null;
  }

  /**
   * Clear the thumbnail cache when inventory changes or items are edited.
   */
  clearCache() {
    this.generation++; this.thumbnailCache.clear(); this.failed.clear(); this.notify();
  }
}
