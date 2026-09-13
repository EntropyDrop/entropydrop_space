import * as THREE from 'three';
import { normalizeColor } from '@entropydrop/space-engine/voxel/BlockTypes.ts';
import { getInventoryPreviewBlocks } from './SceneRenderer.ts';

export class InventoryThumbnailRenderer {
  private static instance: InventoryThumbnailRenderer | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private thumbnailCache = new Map<string, string>();
  private webglAvailable: boolean = true;

  static getInstance(): InventoryThumbnailRenderer {
    if (!InventoryThumbnailRenderer.instance) {
      InventoryThumbnailRenderer.instance = new InventoryThumbnailRenderer();
    }
    return InventoryThumbnailRenderer.instance;
  }

  constructor() {
    this.initSandbox();
  }

  private initSandbox() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
      this.webglAvailable = false;
      return;
    }

    try {
      this.canvas = document.createElement('canvas');
      this.canvas.width = 128;
      this.canvas.height = 128;

      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true,
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
    } catch (e) {
      this.webglAvailable = false;
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
    const kind = item.kind
      || (item.type === 'space-entity' || Array.isArray(item.childEntities) ? 'entity' : 'blockset');
    const blockCount = item.blockCount || item.blocks?.length || 0;
    const name = item.name || '';
    const childCount = item.childEntities?.length || 0;

    // Fast signature from sample blocks
    const sample = (item.blocks || []).slice(0, 5).map((b: any) =>
      `${b.localX ?? b.dx}_${b.localY ?? b.dy}_${b.localZ ?? b.dz}_${b.color}_${b.size || 1}`
    ).join(';');

    return `${kind}:${name}:${blockCount}:${childCount}:${sample}:${size}`;
  }

  /**
   * Generate or retrieve a cached thumbnail Data URL for an inventory item (blockset or resting entity).
   */
  getThumbnail(item: any, size: number = 128): string | null {
    if (!item || !item.blocks || item.blocks.length === 0) return null;

    const cacheKey = this.getItemCacheKey(item, size);
    if (this.thumbnailCache.has(cacheKey)) {
      return this.thumbnailCache.get(cacheKey)!;
    }

    if (!this.webglAvailable || !this.renderer || !this.scene || !this.camera || !this.canvas) {
      return null;
    }

    try {
      // 1. Convert inventory item into resting / stopped state voxel instances
      const previewBlocks = getInventoryPreviewBlocks(item);
      if (!previewBlocks || previewBlocks.length === 0) return null;

      // 2. Compute bounding box
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

      for (const block of previewBlocks) {
        const half = (Number(block.size) || 1) / 2;
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

      // 3. Build meshes grouped by block size
      const blocksBySize = new Map<number, Array<{ center: THREE.Vector3; color: any }>>();
      for (const block of previewBlocks) {
        const s = Number(block.size) || 1;
        if (!blocksBySize.has(s)) blocksBySize.set(s, []);
        blocksBySize.get(s)!.push(block);
      }

      const tempGroup = new THREE.Group();
      const dummy = new THREE.Object3D();
      const colorHelper = new THREE.Color();

      const createdMeshes: THREE.InstancedMesh[] = [];

      for (const [s, blocks] of blocksBySize.entries()) {
        const geom = new THREE.BoxGeometry(s, s, s);
        const mat = new THREE.MeshStandardMaterial({
          roughness: 0.45,
          metalness: 0.05
        });

        const instancedMesh = new THREE.InstancedMesh(geom, mat, blocks.length);
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          dummy.position.set(
            b.center.x - centerX,
            b.center.y - centerY,
            b.center.z - centerZ
          );
          dummy.scale.set(1, 1, 1);
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

      this.renderer.render(this.scene, this.camera);
      const dataUrl = this.canvas.toDataURL('image/png');

      // 6. Cleanup
      this.scene.remove(tempGroup);
      for (const mesh of createdMeshes) {
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach(m => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }

      if (dataUrl && dataUrl.length > 50) {
        this.thumbnailCache.set(cacheKey, dataUrl);
        return dataUrl;
      }
    } catch (e) {
      console.warn('Failed to generate inventory thumbnail:', e);
    }

    return null;
  }

  /**
   * Clear the thumbnail cache when inventory changes or items are edited.
   */
  clearCache() {
    this.thumbnailCache.clear();
  }
}
