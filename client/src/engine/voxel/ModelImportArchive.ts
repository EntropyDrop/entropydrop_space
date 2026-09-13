import { unzip } from 'fflate';
import {
  isSupportedModelFilename,
  MAX_MODEL_FILE_BYTES,
  MAX_MODEL_RESOURCE_BYTES,
  MAX_MODEL_RESOURCE_FILES,
  type ModelImportResource,
} from './ModelVoxelizer.ts';

export const MAX_MODEL_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_MODEL_ARCHIVE_ENTRIES = 256;
const MAX_MODEL_ARCHIVE_EXPANDED_BYTES = MAX_MODEL_FILE_BYTES + MAX_MODEL_RESOURCE_BYTES;

export interface ModelArchiveContents {
  model: ModelImportResource;
  resources: ModelImportResource[];
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimum = Math.max(0, bytes.byteLength - 0xffff - 22);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  return -1;
}

function preflightZip(buffer: ArrayBuffer) {
  if (!buffer || buffer.byteLength < 22) throw new Error('ZIP archive is empty or truncated');
  if (buffer.byteLength > MAX_MODEL_ARCHIVE_BYTES) {
    throw new Error(`ZIP archive exceeds the ${MAX_MODEL_ARCHIVE_BYTES / (1024 * 1024)} MiB compressed-size limit`);
  }

  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const endOffset = findEndOfCentralDirectory(bytes);
  if (endOffset < 0) throw new Error('Invalid ZIP archive: central directory was not found');

  const disk = view.getUint16(endOffset + 4, true);
  const directoryDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const directorySize = view.getUint32(endOffset + 12, true);
  const directoryOffset = view.getUint32(endOffset + 16, true);
  if (disk !== 0 || directoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-volume ZIP archives are not supported');
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 model archives are not supported');
  }
  if (entryCount > MAX_MODEL_ARCHIVE_ENTRIES) {
    throw new Error(`ZIP archive has too many entries (maximum ${MAX_MODEL_ARCHIVE_ENTRIES})`);
  }
  if (directoryOffset + directorySize > endOffset) {
    throw new Error('Invalid ZIP archive: central directory is out of bounds');
  }

  let offset = directoryOffset;
  let expandedBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > endOffset || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('Invalid ZIP archive: corrupt central directory entry');
    }
    const flags = view.getUint16(offset + 8, true);
    if ((flags & 1) !== 0) throw new Error('Password-protected ZIP archives are not supported');
    const uncompressedSize = view.getUint32(offset + 24, true);
    if (uncompressedSize === 0xffffffff) throw new Error('ZIP64 model archives are not supported');
    expandedBytes += uncompressedSize;
    if (expandedBytes > MAX_MODEL_ARCHIVE_EXPANDED_BYTES) {
      throw new Error(`ZIP contents exceed the ${MAX_MODEL_ARCHIVE_EXPANDED_BYTES / (1024 * 1024)} MiB expanded-size limit`);
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function normalizeArchivePath(value: string): string {
  const path = String(value || '').replace(/\\/g, '/');
  if (!path || path.startsWith('/') || /^[a-z]:\//i.test(path) || path.includes('\0')) {
    throw new Error(`ZIP contains an unsafe path: ${value || '(empty)'}`);
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') throw new Error(`ZIP contains an unsafe path: ${value}`);
    parts.push(part);
  }
  return parts.join('/');
}

function shouldIgnoreEntry(name: string): boolean {
  return !name
    || name.endsWith('/')
    || name.startsWith('__MACOSX/')
    || name.split('/').pop() === '.DS_Store';
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function extractModelArchive(buffer: ArrayBuffer): Promise<ModelArchiveContents> {
  preflightZip(buffer);
  const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(new Uint8Array(buffer), (error, result) => {
      if (error) reject(new Error(`Could not extract ZIP archive: ${error.message}`));
      else resolve(result);
    });
  });

  const files: ModelImportResource[] = [];
  for (const [rawName, data] of Object.entries(entries)) {
    if (shouldIgnoreEntry(rawName)) continue;
    const name = normalizeArchivePath(rawName);
    if (!name) continue;
    files.push({ name, buffer: exactArrayBuffer(data) });
  }

  const models = files.filter(entry => isSupportedModelFilename(entry.name));
  if (models.length === 0) {
    throw new Error('ZIP archive must contain one .fbx, .glb, .gltf, or .stl model file');
  }
  if (models.length > 1) {
    throw new Error(`ZIP archive contains ${models.length} model files; keep exactly one model in the archive`);
  }

  const model = models[0];
  const resources = files.filter(entry => entry !== model);
  if (model.buffer.byteLength > MAX_MODEL_FILE_BYTES) {
    throw new Error(`Archived model exceeds the ${MAX_MODEL_FILE_BYTES / (1024 * 1024)} MiB import limit`);
  }
  if (resources.length > MAX_MODEL_RESOURCE_FILES) {
    throw new Error(`ZIP contains too many model resources (maximum ${MAX_MODEL_RESOURCE_FILES})`);
  }
  const resourceBytes = resources.reduce((total, resource) => total + resource.buffer.byteLength, 0);
  if (resourceBytes > MAX_MODEL_RESOURCE_BYTES) {
    throw new Error(`Archived model resources exceed the ${MAX_MODEL_RESOURCE_BYTES / (1024 * 1024)} MiB import limit`);
  }
  return { model, resources };
}
