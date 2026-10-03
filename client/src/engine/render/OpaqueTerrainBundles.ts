import { REVISION } from 'three/webgpu';

/** Small r183 adapter for opaque terrain command reuse. Three normally executes
 * bundles after transparent objects and does not count replayed draw commands.
 * Keep the terrain before transparency and report executed, not encoded, work. */
export function installOpaqueTerrainBundles(renderer: any) {
  const renderBundle = renderer._renderBundle, renderTransparents = renderer._renderTransparents;
  if (REVISION !== '183' || typeof renderBundle !== 'function' || typeof renderTransparents !== 'function'
    || typeof renderer.backend?.addBundle !== 'function') return false;
  renderer._renderBundle = function(bundle: any, scene: any, lights: any) {
    if (!bundle.bundleGroup.userData.spaceOpaqueTerrain) return renderBundle.call(this, bundle, scene, lights);
    const group = bundle.bundleGroup, context = this._currentRenderContext;
    // r183 stores one native bundle per group/camera, even with several render
    // contexts. Re-record when switching between the canvas and HDR targets.
    // Unsupported cameras and mixed/override lists use normal submission.
    // The group is an optimization, never a reason to drop geometry.
    const list = bundle.renderList;
    if (bundle.camera.isArrayCamera || scene.overrideMaterial || list.transparent.length) {
      if (this.opaque && list.opaque.length) this._renderObjects(list.opaque, bundle.camera, scene, lights);
      if (this.transparent && list.transparent.length) this._renderTransparents(list.transparent, list.transparentDoublePass, bundle.camera, scene, lights);
      // Invalidate only this camera. Shadow passes use an override material
      // every frame; invalidating the group would also discard the main cache.
      this.backend.get(this._bundles.get(group, bundle.camera)).version = undefined;
      return;
    }
    const data = this.backend.get(this._bundles.get(group, bundle.camera));
    const key = [context.id, context.sampleCount, context.width, context.height,
      this.toneMapping, this.outputColorSpace, this.opaque, this.shadowMap.enabled, this.shadowMap.type,
      lights.getCacheKey(), scene.environment?.id,
      ...(context.textures?.map((texture: any) => `${texture.id}:${texture.version}`) ?? []),
      ...lights.getLights().map((light: any) => {
        const map = light.shadow?.map;
        return map ? `${map.texture.id}:${map.depthTexture?.id}:${map.width}:${map.height}` : '';
      })].join('/');
    if (data.spaceContextKey !== key) { group.needsUpdate = true; data.spaceContextKey = key; }
    const record = data.version !== group.version || !data.renderContexts?.has(context);
    if (record) bundle.renderList.sort(this._opaqueSort, this._transparentSort);
    const stats = this.info.render, calls = stats.drawCalls, triangles = stats.triangles;
    renderBundle.call(this, bundle, scene, lights);
    if (record) data.spaceDraws = { calls: stats.drawCalls - calls, triangles: stats.triangles - triangles };
    else if (data.spaceDraws) {
      stats.drawCalls += data.spaceDraws.calls; stats.triangles += data.spaceDraws.triangles;
    }
    group.userData.commandCacheStats ??= { recordings: 0, replays: 0 };
    group.userData.commandCacheStats[record ? 'recordings' : 'replays']++;
  };
  renderer._renderTransparents = function(...args: any[]) {
    const data = this.backend.get(this._currentRenderContext);
    if (this._currentRenderBundle === null && data.currentPass && data.renderBundles?.length) {
      data.currentPass.executeBundles(data.renderBundles);
      data.renderBundles.length = 0;
      // executeBundles resets bound pipeline/buffers/groups on the native pass.
      data.currentSets = { attributes: {}, bindingGroups: [], pipeline: null, index: null };
    }
    return renderTransparents.apply(this, args);
  };
  return true;
}
