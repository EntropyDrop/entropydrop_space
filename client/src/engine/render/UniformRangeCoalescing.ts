import { REVISION } from 'three/webgpu';

/** r183 uploads every changed uniform range of a bind-group buffer with its own
 * queue.writeBuffer call. Moving cameras and LOD fades change several ranges in
 * dozens of small buffers per frame. Firefox forwards each write separately to
 * its GPU process, so upload one contiguous span per buffer instead. The CPU
 * copy is already current for the whole buffer, so rewriting the unchanged
 * bytes between ranges is exact. */
export function installUniformRangeCoalescing(renderer: any) {
  const backend = renderer.backend, utils = backend?.bindingUtils;
  if (REVISION !== '183' || !backend?.isWebGPUBackend || typeof utils?.updateBinding !== 'function') return false;
  if (utils.spaceUniformRangeCoalescing) return true;
  utils.spaceUniformRangeCoalescing = true;
  const updateBinding = utils.updateBinding;
  utils.updateBinding = function(binding: any) {
    const ranges = binding.updateRanges, array = binding.buffer;
    if (!ranges || ranges.length < 2 || !ArrayBuffer.isView(array)) return updateBinding.call(this, binding);
    let start = Infinity, end = 0;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (range.start < start) start = range.start;
      if (range.start + range.count > end) end = range.start + range.count;
    }
    const elementBytes = (array as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT;
    backend.device.queue.writeBuffer(backend.get(binding).buffer, start * elementBytes, array, start, end - start);
  };
  return true;
}
