import { REVISION } from 'three/webgpu';

type Pins = { states: Map<{ usedTimes: number }, unknown>; pipelines: Set<any>; release: () => void };

/**
 * r183 drops a compiled node program, its shader modules and its pipelines as
 * soon as the last render object using them is disposed. Shared terrain
 * materials are drawn by short-lived objects (far tiles while they fade,
 * handoff variants), so each return from zero users rebuilt everything: a
 * 5-11 ms node build on the main thread plus new shader modules and pipelines.
 * Materials marked `userData.retainProgram` keep what they compiled until the
 * material itself is disposed. Returns the function that releases every
 * retained program, or null when the renderer internals are not r183's.
 */
export function installProgramRetention(renderer: any): (() => void) | null {
  const nodes = renderer._nodes, pipelines = renderer._pipelines;
  if (REVISION !== '183' || typeof nodes?.getForRender !== 'function' || !(nodes.nodeBuilderCache instanceof Map)
    || typeof nodes.getForRenderCacheKey !== 'function' || typeof pipelines?.getForRender !== 'function'
    || typeof pipelines._releasePipeline !== 'function' || typeof pipelines._releaseProgram !== 'function') return null;
  const pinned = new Map<any, Pins>();
  const pinsFor = (material: any) => {
    let pins = pinned.get(material);
    if (pins) return pins;
    const created: Pins = { states: new Map(), pipelines: new Set(), release: () => {
      material.removeEventListener('dispose', created.release);
      pinned.delete(material);
      // The same bookkeeping r183 performs when a render object goes away.
      for (const [state, key] of created.states) if (--state.usedTimes === 0) nodes.nodeBuilderCache.delete(key);
      for (const pipeline of created.pipelines) {
        if (--pipeline.usedTimes === 0) pipelines._releasePipeline(pipeline);
        if (--pipeline.vertexProgram.usedTimes === 0) pipelines._releaseProgram(pipeline.vertexProgram);
        if (--pipeline.fragmentProgram.usedTimes === 0) pipelines._releaseProgram(pipeline.fragmentProgram);
      }
    } };
    material.addEventListener('dispose', created.release);
    pinned.set(material, created);
    return created;
  };
  const getState = nodes.getForRender;
  nodes.getForRender = function(renderObject: any) {
    const state = getState.call(this, renderObject), material = renderObject.material;
    if (material?.userData?.retainProgram === true) {
      const pins = pinsFor(material);
      if (!pins.states.has(state)) { pins.states.set(state, this.getForRenderCacheKey(renderObject)); state.usedTimes++; }
    }
    return state;
  };
  const getPipeline = pipelines.getForRender;
  pipelines.getForRender = function(renderObject: any, ...rest: any[]) {
    const pipeline = getPipeline.call(this, renderObject, ...rest), material = renderObject.material;
    if (material?.userData?.retainProgram === true && pipeline?.vertexProgram && pipeline.fragmentProgram) {
      const pins = pinsFor(material);
      if (!pins.pipelines.has(pipeline)) {
        pins.pipelines.add(pipeline);
        pipeline.usedTimes++; pipeline.vertexProgram.usedTimes++; pipeline.fragmentProgram.usedTimes++;
      }
    }
    return pipeline;
  };
  return () => { for (const pins of [...pinned.values()]) pins.release(); };
}
