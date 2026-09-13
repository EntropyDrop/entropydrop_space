import * as THREE from 'three';
import { createHeldVoxelTool, normalizeHeldTool, type HeldTool, type HeldVoxelToolMesh } from './HeldVoxelTool.ts';

export type CuteCharacterAction = 'idle' | 'walk';
export type SkinModel = 'strong' | 'slim';

type FaceName = 'right' | 'front' | 'left' | 'top' | 'bottom' | 'back';
type FaceUv = [number, number, number, number, number?, number?];
type UvMap = Partial<Record<FaceName, FaceUv>>;
type PixelData = Pick<ImageData, 'width' | 'height' | 'data'>;

export type CuteCharacterOptions = {
  height?: number;
  model?: SkinModel | 'auto';
  showOverlay?: boolean;
  castShadow?: boolean;
  createBillboard?: boolean;
  createFirstPersonHand?: boolean;
};

export type CuteCharacterMotion = {
  speed?: number;
  forwardSpeed?: number;
  sideSpeed?: number;
  verticalSpeed?: number;
  maxSpeed?: number;
  grounded?: boolean;
  flying?: boolean;
  lookPitch?: number;
  toolUseSequence?: number;
};

type RigParts = {
  body: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
};

const FACE_ORDER: FaceName[] = ['left', 'right', 'top', 'bottom', 'front', 'back'];
const CUTE_SOURCE_SIDE_ROWS = 12;
const CUTE_X_SCALE = 0.85;
const CUTE_TARGET_SIDE_HEIGHT = CUTE_SOURCE_SIDE_ROWS * 0.55;
const CUTE_SIDE_ROWS = Math.round(CUTE_TARGET_SIDE_HEIGHT / CUTE_X_SCALE);
const CUTE_Y_CELL_SCALE = CUTE_X_SCALE;
const CUTE_HALF_SIDE_HEIGHT = CUTE_SIDE_ROWS * CUTE_Y_CELL_SCALE / 2;
const FIRST_PERSON_REFERENCE_FOV = 70;
const FIRST_PERSON_REFERENCE_ASPECT = 16 / 9;
const FIRST_PERSON_REFERENCE_TAN = Math.tan(THREE.MathUtils.degToRad(FIRST_PERSON_REFERENCE_FOV * 0.5));
// Mojang's player_firstperson.animation.json, first_person.empty_hand:
// position [13.5, -10, 12], rotation [95, -45, 115] in model pixels/degrees.
// Use camera-forward -Z and the bone's Z-Y-X rotation order in Three.js.
const FIRST_PERSON_REST_POSITION = new THREE.Vector3(13.5, -10, -12).multiplyScalar(1 / 16);
const FIRST_PERSON_REST_ROTATION = new THREE.Euler(
  THREE.MathUtils.degToRad(95), THREE.MathUtils.degToRad(-45), THREE.MathUtils.degToRad(115), 'ZYX'
);
const FIRST_PERSON_SCALE = 0.08;
const FIRST_PERSON_TOOL_DEPTH = 0.62;
// Equipped items use their own camera anchor. The heel extends below the
// viewport, with the working end leaning back into view from the right edge.
const FIRST_PERSON_TOOL_POSITION = new THREE.Vector3(
  1.02 * FIRST_PERSON_TOOL_DEPTH * FIRST_PERSON_REFERENCE_TAN * FIRST_PERSON_REFERENCE_ASPECT,
  -1.12 * FIRST_PERSON_TOOL_DEPTH * FIRST_PERSON_REFERENCE_TAN,
  -FIRST_PERSON_TOOL_DEPTH
);
const TOOL_USE_DURATION = 0.36;

function damp(current: number, target: number, responsiveness: number, dt: number) {
  return THREE.MathUtils.lerp(current, target, 1 - Math.exp(-responsiveness * dt));
}

function shiftUvMap(map: UvMap, x: number, y: number): UvMap {
  const shifted: UvMap = {};
  for (const [face, uv] of Object.entries(map) as [FaceName, FaceUv][]) {
    shifted[face] = [uv[0] + x, uv[1] + y, uv[2], uv[3], uv[4], uv[5]];
  }
  return shifted;
}

export function detectSkinModel(imageData: PixelData): SkinModel {
  if (imageData.width < 56 || imageData.height < 21) return 'strong';
  const alpha = imageData.data[(20 * imageData.width + 55) * 4 + 3];
  return alpha === 0 ? 'slim' : 'strong';
}

function getUvMaps(model: SkinModel) {
  const armWidth = model === 'slim' ? 3 : 4;
  const head: UvMap = {
    right: [0, 8, 8, 8], left: [16, 8, 8, 8], top: [8, 0, 8, 8],
    bottom: [16, 0, 8, 8, 0, 1], front: [8, 8, 8, 8], back: [24, 8, 8, 8]
  };
  const body: UvMap = {
    right: [16, 20, 4, 12], left: [28, 20, 4, 12], top: [20, 16, 8, 4],
    bottom: [28, 16, 8, 4, 0, 1], front: [20, 20, 8, 12], back: [32, 20, 8, 12]
  };
  const rightArm: UvMap = {
    right: [40, 20, 4, 12], front: [44, 20, armWidth, 12], left: [44 + armWidth, 20, 4, 12],
    top: [44, 16, armWidth, 4], bottom: [44 + armWidth, 16, armWidth, 4, 0, 1],
    back: [48 + armWidth, 20, armWidth, 12]
  };
  const rightLeg: UvMap = {
    right: [0, 20, 4, 12], left: [8, 20, 4, 12], top: [4, 16, 4, 4],
    bottom: [8, 16, 4, 4, 0, 1], front: [4, 20, 4, 12], back: [12, 20, 4, 12]
  };

  return {
    armWidth,
    head,
    body,
    rightArm,
    leftArm: shiftUvMap(rightArm, -8, 32),
    rightLeg,
    leftLeg: shiftUvMap(rightLeg, 16, 32)
  };
}

function createFaceMaterials(
  texture: THREE.Texture,
  uvMap: UvMap,
  missingColor: Partial<Record<FaceName, number>> = {}
): THREE.Material[] {
  return FACE_ORDER.map(face => {
    const uv = uvMap[face];
    if (!uv) {
      if (missingColor[face] !== undefined) {
        return new THREE.MeshBasicMaterial({ color: missingColor[face] });
      }
      return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    }

    const [u, v, w, h, flipX, flipY] = uv;
    const epsilon = 0.01;
    const faceTexture = texture.clone();
    faceTexture.needsUpdate = true;
    faceTexture.repeat.set((w - 2 * epsilon) / 64, (h - 2 * epsilon) / 64);
    faceTexture.offset.set((u + epsilon) / 64, (64 - v - h + epsilon) / 64);

    if (flipY) {
      faceTexture.repeat.y = -(h - 2 * epsilon) / 64;
      faceTexture.offset.y = (64 - v - epsilon) / 64;
    }
    if (flipX) {
      faceTexture.repeat.x = -(w - 2 * epsilon) / 64;
      faceTexture.offset.x = (u + w - epsilon) / 64;
    }

    return new THREE.MeshBasicMaterial({
      map: faceTexture,
      side: THREE.DoubleSide,
      alphaTest: 0.5
    });
  });
}

/**
 * Build one tiny texture per face and resample only the vertical side rows.
 * Mapping all 12 source rows onto a short box would merely squash the pixels;
 * an 8-row texture gives every retained row one equally sized geometry cell.
 */
function createCuteFaceMaterials(imageData: PixelData, uvMap: UvMap): THREE.Material[] {
  return FACE_ORDER.map(face => {
    const uv = uvMap[face];
    if (!uv) return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });

    const [u, v, width, sourceHeight, flipX, flipY] = uv;
    const isVerticalSide = face === 'left' || face === 'right' || face === 'front' || face === 'back';
    const outputHeight = isVerticalSide && sourceHeight === CUTE_SOURCE_SIDE_ROWS
      ? CUTE_SIDE_ROWS
      : sourceHeight;
    const pixels = new Uint8Array(width * outputHeight * 4);

    for (let y = 0; y < outputHeight; y++) {
      const sourceY = Math.min(
        sourceHeight - 1,
        Math.floor((y + 0.5) * sourceHeight / outputHeight)
      );
      for (let x = 0; x < width; x++) {
        const sourceIndex = ((v + sourceY) * imageData.width + u + x) * 4;
        const outputIndex = (y * width + x) * 4;
        pixels[outputIndex] = imageData.data[sourceIndex];
        pixels[outputIndex + 1] = imageData.data[sourceIndex + 1];
        pixels[outputIndex + 2] = imageData.data[sourceIndex + 2];
        pixels[outputIndex + 3] = imageData.data[sourceIndex + 3];
      }
    }

    const faceTexture = new THREE.DataTexture(
      pixels,
      width,
      outputHeight,
      THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    faceTexture.colorSpace = THREE.SRGBColorSpace;
    faceTexture.magFilter = THREE.NearestFilter;
    faceTexture.minFilter = THREE.NearestFilter;
    faceTexture.generateMipmaps = false;
    // Match TextureLoader's image orientation; the UV flip flags continue to
    // describe only the Minecraft face layout, not the upload convention.
    faceTexture.flipY = true;
    if (flipX) {
      faceTexture.repeat.x = -1;
      faceTexture.offset.x = 1;
    }
    if (flipY) {
      faceTexture.repeat.y = -1;
      faceTexture.offset.y = 1;
    }
    faceTexture.needsUpdate = true;

    return new THREE.MeshBasicMaterial({
      map: faceTexture,
      side: THREE.DoubleSide,
      alphaTest: 0.5
    });
  });
}

type Rgba = [number, number, number, number];
type DecorFace = [[number, number, number], [number, number]];
type DecorPart = [DecorFace[], [number, number]];

/** Match the frontend CUTE renderer's overlay edge-color compensation. */
function ensureOverlayConsistency(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const getPixel = (x: number, y: number): Rgba => {
    const index = (y * width + x) * 4;
    return [data[index], data[index + 1], data[index + 2], data[index + 3]];
  };
  const setPixel = (x: number, y: number, rgba: Rgba) => {
    const index = (y * width + x) * 4;
    data[index] = rgba[0];
    data[index + 1] = rgba[1];
    data[index + 2] = rgba[2];
    data[index + 3] = rgba[3];
  };

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] > 0 && data[index + 3] < 255) data[index + 3] = 255;
  }

  const slim = getPixel(47, 52)[3] === 0;
  const parts: DecorPart[] = [
    [[
      [[8, 8, 8], [8, 8]], [[8, 8, 8], [24, 8]], [[8, 8, 8], [16, 8]],
      [[8, 8, 8], [0, 8]], [[8, 8, 8], [8, 0]], [[8, 8, 8], [16, 0]]
    ], [32, 0]],
    [[
      [[8, 12, 4], [20, 20]], [[8, 12, 4], [32, 20]], [[4, 12, 8], [28, 20]],
      [[4, 12, 8], [16, 20]], [[8, 4, 12], [20, 16]], [[8, 4, 12], [28, 16]]
    ], [0, 16]],
    [[
      [[slim ? 3 : 4, 12, 4], [36, 52]], [[slim ? 3 : 4, 12, 4], [slim ? 43 : 44, 52]],
      [[4, 12, 4], [slim ? 39 : 40, 52]], [[4, 12, 4], [32, 52]],
      [[slim ? 3 : 4, 4, 12], [36, 48]], [[slim ? 3 : 4, 4, 12], [slim ? 39 : 40, 48]]
    ], [16, 0]],
    [[
      [[slim ? 3 : 4, 12, 4], [44, 20]], [[slim ? 3 : 4, 12, 4], [slim ? 51 : 52, 20]],
      [[4, 12, 4], [slim ? 47 : 48, 20]], [[4, 12, 4], [40, 20]],
      [[slim ? 3 : 4, 4, 12], [44, 16]], [[slim ? 3 : 4, 4, 12], [slim ? 47 : 48, 16]]
    ], [0, 16]],
    [[
      [[4, 12, 4], [20, 52]], [[4, 12, 4], [28, 52]], [[4, 12, 4], [24, 52]],
      [[4, 12, 4], [16, 52]], [[4, 4, 12], [20, 48]], [[4, 4, 12], [24, 48]]
    ], [-16, 0]],
    [[
      [[4, 12, 4], [4, 20]], [[4, 12, 4], [12, 20]], [[4, 12, 4], [8, 20]],
      [[4, 12, 4], [0, 20]], [[4, 4, 12], [4, 16]], [[4, 4, 12], [8, 16]]
    ], [0, 16]]
  ];

  const priority = (face: number) => [0, 1, 4, 5, 2, 3].indexOf(face);
  for (const [faces, decorOffset] of parts) {
    const [sizeX, sizeY, sizeZ] = faces[4][0];
    const colors = new Map<string, { rgba: Rgba; priority: number }>();
    const inverse = new Map<string, [number, number][]>();

    faces.forEach(([size, offset], faceIndex) => {
      for (let dx = 0; dx < size[0]; dx++) {
        for (let dy = 0; dy < size[1]; dy++) {
          const imageX = offset[0] + dx + decorOffset[0];
          const imageY = offset[1] + dy + decorOffset[1];
          const rgba = getPixel(imageX, imageY);
          let x = 0, y = 0, z = 0;
          if (faceIndex === 4) [x, y, z] = [dx, sizeY - 1 - dy, sizeZ - 1];
          else if (faceIndex === 5) [x, y, z] = [dx, sizeY - 1 - dy, 0];
          else if (faceIndex === 0) [x, y, z] = [dx, 0, sizeZ - 1 - dy];
          else if (faceIndex === 1) [x, y, z] = [sizeX - 1 - dx, sizeY - 1, sizeZ - 1 - dy];
          else if (faceIndex === 2) [x, y, z] = [sizeX - 1, dx, sizeZ - 1 - dy];
          else if (faceIndex === 3) [x, y, z] = [0, sizeY - 1 - dx, sizeZ - 1 - dy];

          const key = `${x},${y},${z}`;
          const destinations = inverse.get(key) || [];
          destinations.push([imageX, imageY]);
          inverse.set(key, destinations);
          if (rgba[3] === 0) continue;
          const facePriority = priority(faceIndex);
          if (!colors.has(key) || facePriority < colors.get(key)!.priority) {
            colors.set(key, { rgba, priority: facePriority });
          }
        }
      }
    });

    for (const [key, destinations] of inverse) {
      const color = colors.get(key)?.rgba;
      if (!color) continue;
      for (const [x, y] of destinations) {
        if (getPixel(x, y)[3] === 0) setPixel(x, y, color);
      }
    }
  }
  return imageData;
}

type VoxelCell = {
  x: number;
  y: number;
  z: number;
} & Partial<Record<FaceName, number>>;

function readOverlayVoxels(imageData: ImageData, uvMap: UvMap, targetBoxHeight?: number): VoxelCell[] {
  const cells = new Map<string, VoxelCell>();
  const boxWidth = uvMap.front![2];
  const boxDepth = uvMap.right![2];
  const sourceBoxHeight = uvMap.front![3];
  const boxHeight = targetBoxHeight ?? sourceBoxHeight;

  for (const [face, uv] of Object.entries(uvMap) as [FaceName, FaceUv][]) {
    const [u, v, width, height, flipX, flipY] = uv;
    const isVerticalSide = face === 'left' || face === 'right' || face === 'front' || face === 'back';
    const outputHeight = isVerticalSide && height === sourceBoxHeight ? boxHeight : height;
    for (let y = 0; y < outputHeight; y++) {
      const sampledY = isVerticalSide
        ? Math.min(height - 1, Math.floor((y + 0.5) * height / outputHeight))
        : y;
      for (let x = 0; x < width; x++) {
        const readX = flipX ? width - 1 - x : x;
        const readY = flipY ? height - 1 - sampledY : sampledY;
        const index = ((v + readY) * imageData.width + u + readX) * 4;
        if (imageData.data[index + 3] < 255) continue;
        const color = (imageData.data[index] << 16) + (imageData.data[index + 1] << 8) + imageData.data[index + 2];
        let position: [number, number, number];
        if (face === 'front') position = [x - boxWidth / 2 + 1, boxHeight / 2 - y, boxDepth / 2];
        else if (face === 'back') position = [-x + boxWidth / 2, boxHeight / 2 - y, -boxDepth / 2 + 1];
        else if (face === 'left') position = [boxWidth / 2, boxHeight / 2 - y, -x + boxDepth / 2];
        else if (face === 'right') position = [-boxWidth / 2 + 1, boxHeight / 2 - y, -boxDepth / 2 + x + 1];
        else if (face === 'top') position = [x - boxWidth / 2 + 1, boxHeight / 2, -boxDepth / 2 + y + 1];
        else position = [x - boxWidth / 2 + 1, -boxHeight / 2 + 1, -y + boxDepth / 2];

        const key = position.join('_');
        const cell = cells.get(key) || { x: position[0], y: position[1], z: position[2] };
        cell[face] = color;
        cells.set(key, cell);
      }
    }
  }
  return [...cells.values()];
}

function createVoxelGroup(imageData: ImageData, uvMap: UvMap, extra: number, size: [number, number, number]) {
  const group = new THREE.Group();
  group.userData.cuteCharacterOverlay = true;
  const scaleX = (size[0] + extra) / size[0];
  const scaleY = (size[1] + extra) / size[1];
  const scaleZ = (size[2] + extra) / size[2];

  for (const cell of readOverlayVoxels(imageData, uvMap, size[1])) {
    const fallback = cell.left ?? cell.right ?? cell.top ?? cell.bottom ?? cell.front ?? cell.back ?? 0xffffff;
    const materials = FACE_ORDER.map(face => new THREE.MeshBasicMaterial({ color: cell[face] ?? fallback }));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(scaleX, scaleY, scaleZ), materials);
    mesh.position.set((cell.x - 0.5) * scaleX, (cell.y - 0.5) * scaleY, (cell.z - 0.5) * scaleZ);
    group.add(mesh);
  }
  return group;
}

function createFrontBillboard(imageData: PixelData, model: SkinModel) {
  const width = 16;
  const height = 32;
  const pixels = new Uint8Array(width * height * 4);
  const armWidth = model === 'slim' ? 3 : 4;

  const draw = (sourceX: number, sourceY: number, partWidth: number, partHeight: number, targetX: number, targetY: number) => {
    for (let y = 0; y < partHeight; y++) {
      for (let x = 0; x < partWidth; x++) {
        const sx = sourceX + x;
        const sy = sourceY + y;
        const tx = targetX + x;
        const ty = targetY + y;
        if (sx < 0 || sx >= imageData.width || sy < 0 || sy >= imageData.height) continue;
        if (tx < 0 || tx >= width || ty < 0 || ty >= height) continue;

        const sourceIndex = (sy * imageData.width + sx) * 4;
        const targetIndex = (ty * width + tx) * 4;
        const sourceAlpha = imageData.data[sourceIndex + 3] / 255;
        if (sourceAlpha <= 0) continue;
        const targetAlpha = pixels[targetIndex + 3] / 255;
        const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
        for (let channel = 0; channel < 3; channel++) {
          const source = imageData.data[sourceIndex + channel];
          const target = pixels[targetIndex + channel];
          pixels[targetIndex + channel] = outputAlpha > 0
            ? Math.round((source * sourceAlpha + target * targetAlpha * (1 - sourceAlpha)) / outputAlpha)
            : 0;
        }
        pixels[targetIndex + 3] = Math.round(outputAlpha * 255);
      }
    }
  };

  // Minecraft skin front faces, assembled into one tiny 16x32 cutout.
  const leftArmX = model === 'slim' ? 13 : 12;
  draw(8, 8, 8, 8, 4, 0);
  draw(20, 20, 8, 12, 4, 8);
  draw(44, 20, armWidth, 12, 0, 8);
  draw(36, 52, armWidth, 12, leftArmX, 8);
  draw(4, 20, 4, 12, 4, 20);
  draw(20, 52, 4, 12, 8, 20);

  // Composite the translucent second skin layer over the base silhouette.
  draw(40, 8, 8, 8, 4, 0);
  draw(20, 36, 8, 12, 4, 8);
  draw(44, 36, armWidth, 12, 0, 8);
  draw(52, 52, armWidth, 12, leftArmX, 8);
  draw(4, 36, 4, 12, 4, 20);
  draw(4, 52, 4, 12, 8, 20);

  const texture = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = true;
  texture.needsUpdate = true;

  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: 0.1,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const billboard = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 1.8), material);
  billboard.name = 'CuteCharacterBillboard';
  billboard.position.y = 0.9;
  billboard.castShadow = false;
  billboard.userData.remotePlayerBillboard = true;
  return billboard;
}

function taperGeometry(geometry: THREE.BufferGeometry, height = CUTE_SOURCE_SIDE_ROWS) {
  const positions = geometry.attributes.position;
  for (let index = 0; index < positions.count; index++) {
    const y = positions.getY(index);
    const t = THREE.MathUtils.clamp((y + height / 2) / height, 0, 1);
    positions.setX(index, positions.getX(index) * (1 - 0.3 * t));
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
}

function taperVoxelGroup(group: THREE.Group, height = CUTE_SOURCE_SIDE_ROWS) {
  for (const child of group.children) {
    if (!(child instanceof THREE.Mesh)) continue;
    const t = THREE.MathUtils.clamp((child.position.y + height / 2) / height, 0, 1);
    const scale = 1 - 0.3 * t;
    child.position.x *= scale;
    child.scale.x *= scale;
  }
}

function addSkinnedPart(parent: THREE.Object3D, geometry: THREE.BufferGeometry, materials: THREE.Material[], overlay: THREE.Group | null) {
  const mesh = new THREE.Mesh(geometry, materials);
  parent.add(mesh);
  if (overlay) parent.add(overlay);
  return mesh;
}

export class CuteCharacter {
  readonly object3d = new THREE.Group();
  /** Camera-local, projection-compensated empty hand or equipped tool. */
  readonly firstPersonHand = new THREE.Group();
  private readonly firstPersonHandPose = new THREE.Group();
  private readonly firstPersonToolPose = new THREE.Group();
  private readonly rightHandGrip = new THREE.Group();
  private readonly firstPersonGrip = new THREE.Group();
  private heldTool: HeldTool | null = null;
  private lastToolUseSequence: number | null = null;
  private toolUseTime = TOOL_USE_DURATION;
  private queuedToolUse = false;
  private readonly heldToolMeshes = new Map<HeldTool, {
    world: HeldVoxelToolMesh;
    view: HeldVoxelToolMesh | null;
  }>();
  readonly billboard: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> | null;
  readonly model: SkinModel;
  action: CuteCharacterAction = 'idle';
  private readonly rig = new THREE.Group();
  private readonly parts: RigParts;
  private readonly texture: THREE.Texture;
  private animationTime = 0;
  private gaitPhase = 0;
  private locomotionBlend = 0;
  private airborneBlend = 0;
  private flightBlend = 0;
  private smoothedSpeed = 0;
  private smoothedForward = 0;
  private smoothedSide = 0;
  private wasGrounded = true;
  private jumpPoseDirection = 1;
  private readonly overlayGroups: THREE.Group[];
  private shadowsEnabled: boolean;

  constructor(texture: THREE.Texture, imageData: ImageData, options: CuteCharacterOptions = {}) {
    this.texture = texture;
    this.model = options.model && options.model !== 'auto' ? options.model : detectSkinModel(imageData);
    const showOverlay = options.showOverlay !== false;
    const castShadow = options.castShadow !== false;
    this.shadowsEnabled = castShadow;
    const height = Math.max(0.1, options.height ?? 1.8);
    const uv = getUvMaps(this.model);
    const overlayPixels = ensureOverlayConsistency(imageData);
    this.billboard = options.createBillboard ? createFrontBillboard(overlayPixels, this.model) : null;

    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;

    const materials = {
      head: createFaceMaterials(texture, uv.head),
      body: createCuteFaceMaterials(imageData, uv.body),
      leftArm: createCuteFaceMaterials(imageData, uv.leftArm),
      rightArm: createCuteFaceMaterials(imageData, uv.rightArm),
      leftLeg: createCuteFaceMaterials(imageData, uv.leftLeg),
      rightLeg: createCuteFaceMaterials(imageData, uv.rightLeg)
    };

    const overlays = showOverlay ? {
      head: createVoxelGroup(overlayPixels, shiftUvMap(uv.head, 32, 0), 1, [8, 8, 8]),
      body: createVoxelGroup(overlayPixels, shiftUvMap(uv.body, 0, 16), 0.5, [8, CUTE_SIDE_ROWS, 4]),
      leftArm: createVoxelGroup(overlayPixels, shiftUvMap(uv.leftArm, 16, 0), 0.5, [uv.armWidth, CUTE_SIDE_ROWS, 4]),
      rightArm: createVoxelGroup(overlayPixels, shiftUvMap(uv.rightArm, 0, 16), 0.5, [uv.armWidth, CUTE_SIDE_ROWS, 4]),
      leftLeg: createVoxelGroup(overlayPixels, shiftUvMap(uv.leftLeg, -16, 0), 0.5, [4, CUTE_SIDE_ROWS, 4]),
      rightLeg: createVoxelGroup(overlayPixels, shiftUvMap(uv.rightLeg, 0, 16), 0.5, [4, CUTE_SIDE_ROWS, 4])
    } : null;
    this.overlayGroups = overlays ? Object.values(overlays) : [];

    const bodyGeometry = new THREE.BoxGeometry(8, CUTE_SIDE_ROWS, 4, 8, CUTE_SIDE_ROWS, 4);
    taperGeometry(bodyGeometry, CUTE_SIDE_ROWS);
    if (overlays) taperVoxelGroup(overlays.body, CUTE_SIDE_ROWS);

    const body = new THREE.Group();
    body.position.y = 8.5;
    this.rig.add(body);
    const torso = new THREE.Group();
    torso.scale.set(CUTE_X_SCALE, CUTE_Y_CELL_SCALE, 1);
    body.add(torso);
    addSkinnedPart(torso, bodyGeometry, materials.body, overlays?.body ?? null);

    const head = new THREE.Group();
    head.position.y = CUTE_HALF_SIDE_HEIGHT;
    body.add(head);
    const headCenter = new THREE.Group();
    headCenter.position.y = 4;
    head.add(headCenter);
    addSkinnedPart(headCenter, new THREE.BoxGeometry(8, 8, 8), materials.head, overlays?.head ?? null);

    const addLimb = (
      x: number,
      y: number,
      scale: [number, number, number],
      geometry: THREE.BufferGeometry,
      limbMaterials: THREE.Material[],
      overlay: THREE.Group | null
    ) => {
      const limb = new THREE.Group();
      limb.position.set(x, y, 0);
      limb.scale.set(...scale);
      body.add(limb);
      const center = new THREE.Group();
      center.position.y = -CUTE_SIDE_ROWS / 2;
      limb.add(center);
      addSkinnedPart(center, geometry, limbMaterials, overlay);
      return limb;
    };

    const armScale: [number, number, number] = [CUTE_X_SCALE, CUTE_Y_CELL_SCALE, 1];
    // Both cute models share the slim torso. Keep the inner arm edge aligned
    // while allowing the strong model's fourth pixel to extend outward.
    const shoulderX = 3.3 + ((uv.armWidth - 3) * armScale[0]) / 2;
    const leftArm = addLimb(
      shoulderX, CUTE_HALF_SIDE_HEIGHT, armScale,
      new THREE.BoxGeometry(uv.armWidth, CUTE_SIDE_ROWS, 4), materials.leftArm, overlays?.leftArm ?? null
    );
    const rightArm = addLimb(
      -shoulderX, CUTE_HALF_SIDE_HEIGHT, armScale,
      new THREE.BoxGeometry(uv.armWidth, CUTE_SIDE_ROWS, 4), materials.rightArm, overlays?.rightArm ?? null
    );
    this.rightHandGrip.name = 'CuteRightHandGrip';
    this.rightHandGrip.position.set(0, -CUTE_SIDE_ROWS + 1.3, 0);
    this.rightHandGrip.scale.set(1 / armScale[0], 1 / armScale[1], 1);
    rightArm.add(this.rightHandGrip);
    const legScale: [number, number, number] = [CUTE_X_SCALE, CUTE_Y_CELL_SCALE, 1];
    const leftLeg = addLimb(
      1.7, -CUTE_HALF_SIDE_HEIGHT, legScale,
      new THREE.BoxGeometry(4, CUTE_SIDE_ROWS, 4), materials.leftLeg, overlays?.leftLeg ?? null
    );
    const rightLeg = addLimb(
      -1.7, -CUTE_HALF_SIDE_HEIGHT, legScale,
      new THREE.BoxGeometry(4, CUTE_SIDE_ROWS, 4), materials.rightLeg, overlays?.rightLeg ?? null
    );

    // First-person viewmodel: use a separate material/overlay set so it can
    // render on top of the world without changing the third-person arm.
    if (options.createFirstPersonHand !== false) {
      const firstPersonArm = new THREE.Group();
      firstPersonArm.scale.set(...armScale);
      this.firstPersonGrip.name = 'CuteFirstPersonGrip';
      // Empty hand and equipped item are separate viewmodels, as in MC.
      // The first-person item is not attached to the visible empty-hand arm.
      this.firstPersonToolPose.name = 'CuteFirstPersonToolPose';
      this.firstPersonToolPose.scale.setScalar(FIRST_PERSON_SCALE);
      this.firstPersonToolPose.visible = false;
      this.firstPersonToolPose.add(this.firstPersonGrip);
      this.firstPersonHandPose.add(firstPersonArm);
      this.firstPersonHand.add(this.firstPersonHandPose, this.firstPersonToolPose);
      const firstPersonArmCenter = new THREE.Group();
      firstPersonArmCenter.name = 'CuteFirstPersonArmSurface';
      // Slim the empty hand and sleeve without changing tool dimensions.
      firstPersonArmCenter.scale.set(0.58, 1, 0.58);
      // Keep the empty-hand wrist in line with the forearm.
      firstPersonArmCenter.position.y = -CUTE_SIDE_ROWS / 2;
      firstPersonArm.add(firstPersonArmCenter);
      addSkinnedPart(
        firstPersonArmCenter,
        new THREE.BoxGeometry(uv.armWidth, CUTE_SIDE_ROWS, 4),
        createCuteFaceMaterials(imageData, uv.rightArm),
        showOverlay
          ? createVoxelGroup(
            overlayPixels,
            shiftUvMap(uv.rightArm, 0, 16),
            0.5,
            [uv.armWidth, CUTE_SIDE_ROWS, 4]
          )
          : null
      );
      this.firstPersonHand.name = 'CuteFirstPersonHand';
      this.firstPersonHandPose.name = 'CuteFirstPersonHandPose';
      this.firstPersonHandPose.scale.setScalar(FIRST_PERSON_SCALE);
      this.firstPersonHand.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = false;
        object.frustumCulled = false;
        object.renderOrder = 1000;
        // Camera-local geometry is already in render space and must not receive
        // the logical-world torus vertex bend.
        object.userData.torusPreBent = true;
        const viewMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of viewMaterials) {
          // The base arm and its raised overlay occupy nearby layers. Disabling
          // depth made their rear/inner faces draw over the front, which looked
          // like transparent skin and self-intersection. Keep normal opaque
          // depth semantics for a solid viewmodel.
          material.depthTest = true;
          material.depthWrite = true;
          material.transparent = false;
          material.opacity = 1;
          material.side = THREE.FrontSide;
        }
      });
    }

    this.parts = {
      body, head,
      leftArm, rightArm, leftLeg, rightLeg
    };
    this.object3d.add(this.rig);
    this.update(0, { grounded: true });

    this.rig.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.rig);
    const sourceHeight = Math.max(1, bounds.max.y - bounds.min.y);
    const scale = height / sourceHeight;
    this.object3d.scale.setScalar(scale);
    this.object3d.position.y = -bounds.min.y * scale;
    // The frontend model faces +Z; Space's player convention faces -Z.
    this.object3d.rotation.y = Math.PI;

    this.object3d.traverse(object => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = castShadow;
      }
    });
  }

  setOverlayVisible(visible: boolean) {
    for (const overlay of this.overlayGroups) overlay.visible = visible;
  }

  /** Cached meshes switch together in both perspectives, without per-frame allocations. */
  setHeldTool(value: string | null | undefined): boolean {
    const tool = normalizeHeldTool(value);
    if (tool === this.heldTool) return false;
    this.heldTool = tool;
    this.firstPersonHandPose.visible = !tool;
    this.firstPersonToolPose.visible = !!tool;
    this.toolUseTime = TOOL_USE_DURATION;
    this.queuedToolUse = false;
    if (tool && !this.heldToolMeshes.has(tool)) {
      const world = createHeldVoxelTool(tool);
      world.castShadow = this.shadowsEnabled;
      world.rotation.x = Math.PI / 2;
      if (tool === 'hammer') world.rotateY(Math.PI / 2);
      let view: typeof world | null = null;
      if (this.firstPersonGrip.parent) {
        view = new THREE.Mesh(world.geometry, world.material.map(material => material.clone()));
        view.name = world.name;
        for (const material of view.material) material.fog = false;
        view.frustumCulled = false;
        view.renderOrder = 1000;
        view.userData.torusPreBent = true;
        view.rotation.copy(new THREE.Euler(-0.16, -0.5, 0.34));
        if (tool === 'hammer') view.rotateY(-Math.PI / 2);
        this.firstPersonGrip.add(view);
      }
      this.rightHandGrip.add(world);
      this.heldToolMeshes.set(tool, { world, view });
    }
    for (const [key, { world, view }] of this.heldToolMeshes) {
      world.visible = key === tool;
      if (view) view.visible = key === tool;
    }
    return true;
  }

  playToolUseAnimation() {
    // Finish the current stroke before the next one, so rapid clicks never
    // snap the hand back to its resting pose or build an unbounded queue.
    if (this.toolUseTime < TOOL_USE_DURATION) this.queuedToolUse = true;
    else this.toolUseTime = 0;
  }

  setCastShadow(enabled: boolean) {
    if (enabled === this.shadowsEnabled) return;
    this.shadowsEnabled = enabled;
    this.object3d.traverse(object => {
      if (object instanceof THREE.Mesh) object.castShadow = enabled;
    });
  }

  /**
   * Counter-scale the camera-local viewmodel in camera X/Y so changing the
   * world camera's FOV or aspect ratio does not pull the shoulder cap into the
   * viewport. Z deliberately stays unchanged to preserve near-plane and depth
   * behavior.
   */
  updateFirstPersonProjection(camera: THREE.PerspectiveCamera) {
    const fov = THREE.MathUtils.clamp(Number(camera?.fov) || FIRST_PERSON_REFERENCE_FOV, 1, 179);
    const aspect = Math.max(0.01, Number(camera?.aspect) || FIRST_PERSON_REFERENCE_ASPECT);
    const fovScale = Math.tan(THREE.MathUtils.degToRad(fov * 0.5)) / FIRST_PERSON_REFERENCE_TAN;
    this.firstPersonHand.scale.set(
      fovScale * aspect / FIRST_PERSON_REFERENCE_ASPECT,
      fovScale,
      1
    );
  }

  update(deltaSeconds: number, motion: CuteCharacterMotion = {}) {
    const dt = THREE.MathUtils.clamp(Number(deltaSeconds) || 0, 0, 0.1);
    this.animationTime += dt;
    if (Number.isFinite(motion.toolUseSequence)) {
      if (this.lastToolUseSequence !== null && motion.toolUseSequence !== this.lastToolUseSequence) {
        this.playToolUseAnimation();
      }
      this.lastToolUseSequence = motion.toolUseSequence;
    }
    this.toolUseTime = Math.min(TOOL_USE_DURATION, this.toolUseTime + dt);
    if (this.toolUseTime >= TOOL_USE_DURATION && this.queuedToolUse) {
      this.toolUseTime = 0;
      this.queuedToolUse = false;
    }
    const useProgress = this.toolUseTime / TOOL_USE_DURATION;
    const windup = Math.sin(Math.PI * Math.min(1, useProgress / 0.2));
    const strike = Math.sin(Math.PI * Math.max(0, (useProgress - 0.2) / 0.8));
    const useSwing = strike - windup * 0.28;

    const speed = Math.max(0, Number(motion.speed) || 0);
    const maxSpeed = Math.max(1, Number(motion.maxSpeed) || 5);
    const grounded = motion.grounded !== false;
    const flying = motion.flying === true;
    if (!grounded && this.wasGrounded && !flying) {
      const gait = Math.sin(this.gaitPhase);
      this.jumpPoseDirection = Math.abs(gait) > 0.15
        ? Math.sign(gait)
        : (Math.cos(this.gaitPhase) >= 0 ? 1 : -1);
    }
    this.wasGrounded = grounded;
    const movingAmount = THREE.MathUtils.clamp((speed - 0.08) / 0.9, 0, 1);
    const movingTarget = grounded && !flying
      ? movingAmount * movingAmount * (3 - 2 * movingAmount)
      : 0;

    this.smoothedSpeed = damp(this.smoothedSpeed, speed, 10, dt);
    this.locomotionBlend = damp(
      this.locomotionBlend,
      movingTarget,
      movingTarget > this.locomotionBlend ? 12 : 7,
      dt
    );
    this.airborneBlend = damp(this.airborneBlend, grounded ? 0 : 1, grounded ? 14 : 9, dt);
    this.flightBlend = damp(this.flightBlend, flying ? 1 : 0, flying ? 7 : 10, dt);

    const directionDenominator = Math.max(0.05, speed);
    const targetForward = speed > 0.05
      ? THREE.MathUtils.clamp((Number(motion.forwardSpeed) || 0) / directionDenominator, -1, 1)
      : 0;
    const targetSide = speed > 0.05
      ? THREE.MathUtils.clamp((Number(motion.sideSpeed) || 0) / directionDenominator, -1, 1)
      : 0;
    this.smoothedForward = damp(this.smoothedForward, targetForward, 9, dt);
    this.smoothedSide = damp(this.smoothedSide, targetSide, 9, dt);

    if (speed > 0.03 && grounded && !flying) {
      // Tie cadence to actual ground speed to prevent visible foot sliding.
      this.gaitPhase = (this.gaitPhase + dt * (4.5 + this.smoothedSpeed * 1.65)) % (Math.PI * 2);
    }

    this.action = movingTarget > 0.05 ? 'walk' : 'idle';
    const slim = this.model === 'slim';
    const armZ = 0.2;
    const blend = this.locomotionBlend;
    const air = this.airborneBlend;
    const speedRatio = THREE.MathUtils.clamp(this.smoothedSpeed / maxSpeed, 0, 1);
    // A backward/forward switch must not add PI to the gait phase. The old
    // direction sign did exactly that and made every limb jump to its opposite
    // pose while W/S were alternated. Keep the cycle continuous; velocity and
    // body lean still transition through zero independently.
    const gait = Math.sin(this.gaitPhase);
    const stride = THREE.MathUtils.lerp(0.3, 0.62, speedRatio) * blend;
    const armSwing = stride * 0.78;
    const idleWeight = (1 - blend) * (1 - air);
    const idleBreath = Math.sin(this.animationTime * 2.25);
    const walkBob = (0.5 - 0.5 * Math.cos(this.gaitPhase * 2)) * 0.16 * blend;
    const lookPitch = -THREE.MathUtils.clamp(Number(motion.lookPitch) || 0, -0.75, 0.75) * 0.65;
    const setRotation = (part: THREE.Object3D, x: number, y: number, z = 0) => part.rotation.set(x, y, z);

    // Ground pose. Space intentionally keeps each limb as one solid part;
    // natural motion comes from cadence, weight shift and smooth blending.
    let leftLegX = gait * stride;
    let rightLegX = -gait * stride;
    const idleArmMotion = idleBreath * 0.012 * idleWeight;
    let leftArmX = 0.05 * (1 - blend) - gait * armSwing + idleArmMotion;
    let rightArmX = 0.05 * (1 - blend) + gait * armSwing - idleArmMotion;
    let bodyPitch = this.smoothedForward * speedRatio * 0.055 * blend;
    let bodyYaw = -this.smoothedSide * 0.045 * blend;
    let bodyRoll = (-this.smoothedSide * 0.07 + Math.sin(this.gaitPhase) * 0.018) * blend;
    let bodyY = 8.5 + idleBreath * 0.07 * idleWeight + walkBob;

    if (air > 0.001) {
      const flight = this.flightBlend;
      const flightSpeed = speedRatio * speedRatio * (3 - 2 * speedRatio);
      const forwardFlight = Math.max(0, this.smoothedForward) * flightSpeed;
      const backwardFlight = Math.max(0, -this.smoothedForward) * flightSpeed;
      const flightFlutter = Math.sin(this.animationTime * 2.1) * 0.025;
      const jumpLegSwing = this.jumpPoseDirection * 0.62;
      const jumpArmSwing = jumpLegSwing * 0.78;

      // At takeoff, carry the current gait direction into one full extension
      // and hold it instead of cycling the limbs in mid-air. Flight gradually
      // replaces this jump pose with relaxed arms and trailing legs.
      const jumpBodyPitch = 0.025 * this.smoothedForward;
      const jumpLeftArm = -jumpArmSwing;
      const jumpRightArm = jumpArmSwing;
      const jumpLeftLeg = jumpLegSwing;
      const jumpRightLeg = -jumpLegSwing;
      // Forward flight leans into travel and lets the limbs trail. Backward
      // flight is intentionally not the same pose played in reverse: the body
      // leans back less aggressively while arms and legs reach forward for
      // balance. Pure strafing stays nearly upright and uses banking below.
      const flightBodyPitch = 0.06 + forwardFlight * 0.52 - backwardFlight * 0.36;
      const flightLeftArm = -0.12 + forwardFlight * 0.2 - backwardFlight * 0.22 + flightFlutter;
      const flightRightArm = -0.08 + forwardFlight * 0.22 - backwardFlight * 0.2 - flightFlutter;
      const flightLeftLeg = -0.08 + forwardFlight * 0.38 - backwardFlight * 0.12 - flightFlutter;
      const flightRightLeg = 0.1 + forwardFlight * 0.3 - backwardFlight * 0.22 + flightFlutter;
      const airBodyPitch = THREE.MathUtils.lerp(jumpBodyPitch, flightBodyPitch, flight);
      const airLeftArm = THREE.MathUtils.lerp(jumpLeftArm, flightLeftArm, flight);
      const airRightArm = THREE.MathUtils.lerp(jumpRightArm, flightRightArm, flight);
      const airLeftLeg = THREE.MathUtils.lerp(jumpLeftLeg, flightLeftLeg, flight);
      const airRightLeg = THREE.MathUtils.lerp(jumpRightLeg, flightRightLeg, flight);

      leftArmX = THREE.MathUtils.lerp(leftArmX, airLeftArm, air);
      rightArmX = THREE.MathUtils.lerp(rightArmX, airRightArm, air);
      leftLegX = THREE.MathUtils.lerp(leftLegX, airLeftLeg, air);
      rightLegX = THREE.MathUtils.lerp(rightLegX, airRightLeg, air);
      bodyPitch = THREE.MathUtils.lerp(bodyPitch, airBodyPitch, air);
      // Positive local side speed means moving right. Match yaw and bank to
      // that same side; the previous negative sign visibly leaned the avatar
      // opposite its travel direction.
      bodyYaw = THREE.MathUtils.lerp(bodyYaw, this.smoothedSide * 0.06 * flightSpeed, air * flight);
      bodyRoll = THREE.MathUtils.lerp(bodyRoll, this.smoothedSide * 0.18 * flightSpeed, air * flight);
      bodyY = THREE.MathUtils.lerp(bodyY, 8.58, air);
    }

    setRotation(this.parts.leftArm, leftArmX, 0, armZ);
    setRotation(this.parts.rightArm,
      (this.heldTool ? -0.85 + rightArmX * 0.22 : rightArmX) + useSwing * 0.65,
      -useSwing * 0.08, -armZ - useSwing * 0.12);
    setRotation(this.parts.leftLeg, leftLegX, slim ? 0.04 : 0, 0);
    setRotation(this.parts.rightLeg, rightLegX, slim ? -0.04 : 0, 0);
    setRotation(this.parts.body, bodyPitch, bodyYaw, bodyRoll);
    setRotation(this.parts.head, lookPitch - bodyPitch * 0.35, -bodyYaw * 0.4, -bodyRoll * 0.55);
    this.parts.body.position.set(0, bodyY, 0);

    // A small camera-local sway keeps the first-person hand grounded in the
    // same locomotion state without shaking the view or copying full leg bob.
    const handGround = blend * (1 - air);
    const handGait = Math.sin(this.gaitPhase) * handGround;
    const handFlight = air * this.flightBlend;
    this.firstPersonHandPose.position.set(
      FIRST_PERSON_REST_POSITION.x + this.smoothedSide * 0.008 * handGround - useSwing * 0.04,
      FIRST_PERSON_REST_POSITION.y - Math.abs(handGait) * 0.01 + handFlight * 0.015 - useSwing * 0.015,
      FIRST_PERSON_REST_POSITION.z - Math.abs(handGait) * 0.008 - handFlight * 0.04 - useSwing * 0.06
    );
    this.firstPersonHandPose.rotation.set(
      FIRST_PERSON_REST_ROTATION.x + handGait * 0.025 - handFlight * 0.04 - useSwing * 0.42,
      FIRST_PERSON_REST_ROTATION.y - this.smoothedSide * 0.015 * handGround,
      FIRST_PERSON_REST_ROTATION.z + handGait * 0.02 + useSwing * 0.12,
      FIRST_PERSON_REST_ROTATION.order
    );
    this.firstPersonToolPose.position.set(
      FIRST_PERSON_TOOL_POSITION.x + this.smoothedSide * 0.008 * handGround - useSwing * 0.1,
      FIRST_PERSON_TOOL_POSITION.y - Math.abs(handGait) * 0.01 + handFlight * 0.015 + useSwing * 0.025,
      FIRST_PERSON_TOOL_POSITION.z - Math.abs(handGait) * 0.008 - handFlight * 0.04 - useSwing * 0.07
    );
    this.firstPersonToolPose.rotation.set(
      handGait * 0.025 - useSwing * 0.65,
      -this.smoothedSide * 0.015 * handGround - useSwing * 0.1,
      handGait * 0.02 + useSwing * 0.12
    );
  }

  dispose() {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>([this.texture]);
    for (const root of [this.object3d, this.firstPersonHand, this.billboard]) {
      if (!root) continue;
      root.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return;
        geometries.add(object.geometry);
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of meshMaterials) {
          materials.add(material);
          const map = (material as THREE.MeshBasicMaterial).map;
          if (map) textures.add(map);
          const envMap = (material as THREE.MeshStandardMaterial).envMap;
          if (envMap) textures.add(envMap);
        }
      });
    }
    geometries.forEach(geometry => geometry.dispose());
    materials.forEach(material => material.dispose());
    textures.forEach(texture => texture.dispose());
    this.heldToolMeshes.clear();
    this.object3d.removeFromParent();
    this.firstPersonHand.removeFromParent();
    this.billboard?.removeFromParent();
  }
}

function createDefaultSteveSkinCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(0, 0, 64, 64);
    // Head / Face
    ctx.fillStyle = '#f5cd79';
    ctx.fillRect(0, 8, 32, 8);
    ctx.fillRect(8, 0, 8, 8);
    // Hair
    ctx.fillStyle = '#4b2c11';
    ctx.fillRect(8, 0, 8, 3);
    ctx.fillRect(0, 8, 8, 2);
    ctx.fillRect(24, 8, 8, 2);
    // Eyes
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(10, 12, 2, 1);
    ctx.fillRect(14, 12, 2, 1);
    ctx.fillStyle = '#2980b9';
    ctx.fillRect(11, 12, 1, 1);
    ctx.fillRect(14, 12, 1, 1);
    // Torso / Shirt
    ctx.fillStyle = '#00cec9';
    ctx.fillRect(16, 20, 24, 12);
    ctx.fillRect(20, 16, 8, 4);
    // Arms
    ctx.fillStyle = '#f5cd79';
    ctx.fillRect(40, 20, 16, 12);
    ctx.fillRect(32, 52, 16, 12);
    // Pants / Legs
    ctx.fillStyle = '#3867d6';
    ctx.fillRect(0, 20, 16, 12);
    ctx.fillRect(16, 52, 16, 12);
  }
  return canvas;
}

export async function loadCuteCharacter(url: string, options: CuteCharacterOptions = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    throw new Error('Unable to create a canvas context for the player skin');
  }
  context.imageSmoothingEnabled = false;

  let loaded = false;
  let objectUrlToRevoke: string | null = null;

  if (url && typeof url === 'string') {
    try {
      let fetchUrl = url.trim();
      if (typeof window !== 'undefined' && fetchUrl.startsWith('/')) {
        fetchUrl = `${window.location.origin}${fetchUrl}`;
      }

      if (fetchUrl.startsWith('blob:') || fetchUrl.startsWith('data:')) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to load blob image'));
          img.src = fetchUrl;
        });
        context.drawImage(img, 0, 0, 64, 64);
        loaded = true;
      } else {
        // Fetch via fetch with CORS mode to completely avoid canvas taint
        try {
          const response = await fetch(fetchUrl, { mode: 'cors', cache: 'force-cache' });
          if (response.ok) {
            const blob = await response.blob();
            objectUrlToRevoke = URL.createObjectURL(blob);
            const img = new Image();
            img.crossOrigin = 'anonymous';
            await new Promise<void>((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error('Failed to decode skin image'));
              img.src = objectUrlToRevoke!;
            });
            context.drawImage(img, 0, 0, 64, 64);
            loaded = true;
          }
        } catch {
          // Fallback to Image loading with crossOrigin
          const img = new Image();
          img.crossOrigin = 'anonymous';
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error('Failed to load skin image'));
            img.src = fetchUrl;
          });
          context.drawImage(img, 0, 0, 64, 64);
          loaded = true;
        }
      }
    } catch (error) {
      console.warn(`Could not load skin "${url}", using default skin fallback.`, error);
    } finally {
      if (objectUrlToRevoke) {
        URL.revokeObjectURL(objectUrlToRevoke);
      }
    }
  }

  if (!loaded) {
    const fallbackCanvas = createDefaultSteveSkinCanvas();
    context.drawImage(fallbackCanvas, 0, 0);
  }

  const imageData = context.getImageData(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return new CuteCharacter(texture, imageData, options);
}
