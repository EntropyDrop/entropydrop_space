import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshBasicMaterial } from 'three';
import { installProgramRetention } from '../src/engine/render/ProgramRetention.ts';

/** The parts of r183's node manager and pipeline cache that retention touches. */
function fakeRenderer() {
  const builds: string[] = [], released: string[] = [];
  const stage = (code: string) => ({ code, usedTimes: 0 });
  const nodes = {
    nodeBuilderCache: new Map<string, { usedTimes: number }>(),
    getForRenderCacheKey: (object: any) => object.key,
    getForRender(object: any) {
      if (object.state) return object.state;
      let state = this.nodeBuilderCache.get(object.key);
      if (!state) { state = { usedTimes: 0 }; this.nodeBuilderCache.set(object.key, state); builds.push(object.key); }
      state.usedTimes++; object.state = state;
      return state;
    },
    delete(object: any) {
      if (--object.state.usedTimes === 0) this.nodeBuilderCache.delete(object.key);
      object.state = undefined;
    },
  };
  const pipelines = {
    caches: new Map<string, any>(),
    getForRender(object: any) {
      if (object.pipeline) return object.pipeline;
      let pipeline = this.caches.get(object.key);
      if (!pipeline) {
        pipeline = { cacheKey: object.key, usedTimes: 0, vertexProgram: stage(`${object.key}:v`), fragmentProgram: stage(`${object.key}:f`) };
        this.caches.set(object.key, pipeline);
      }
      pipeline.usedTimes++; pipeline.vertexProgram.usedTimes++; pipeline.fragmentProgram.usedTimes++;
      return object.pipeline = pipeline;
    },
    delete(object: any) {
      const pipeline = object.pipeline; object.pipeline = undefined;
      if (--pipeline.usedTimes === 0) this._releasePipeline(pipeline);
      if (--pipeline.vertexProgram.usedTimes === 0) this._releaseProgram(pipeline.vertexProgram);
      if (--pipeline.fragmentProgram.usedTimes === 0) this._releaseProgram(pipeline.fragmentProgram);
    },
    _releasePipeline(pipeline: any) { this.caches.delete(pipeline.cacheKey); released.push(pipeline.cacheKey); },
    _releaseProgram(program: any) { released.push(program.code); },
  };
  const renderer = { _nodes: nodes, _pipelines: pipelines };
  const draw = (material: MeshBasicMaterial, key: string) => {
    const object = { material, key };
    nodes.getForRender(object); pipelines.getForRender(object);
    return () => { pipelines.delete(object); nodes.delete(object); };
  };
  return { renderer, nodes, pipelines, builds, released, draw };
}

test('retained materials keep their program and pipelines across periods without users', () => {
  const f = fakeRenderer(), release = installProgramRetention(f.renderer);
  assert.ok(release);
  const retained = new MeshBasicMaterial(), plain = new MeshBasicMaterial();
  retained.userData.retainProgram = true;
  for (let i = 0; i < 3; i++) { f.draw(retained, 'terrain')(); f.draw(plain, 'plain')(); }
  assert.deepEqual(f.builds, ['terrain', 'plain', 'plain', 'plain'], 'only the unmarked material rebuilds');
  assert.equal(f.released.filter(key => key.startsWith('terrain')).length, 0);
  assert.equal(f.nodes.nodeBuilderCache.get('terrain')!.usedTimes, 1, 'one pin, however often it is drawn');
  assert.equal(f.pipelines.caches.get('terrain').usedTimes, 1);

  const live = f.draw(retained, 'terrain');
  retained.dispose();
  assert.ok(f.nodes.nodeBuilderCache.has('terrain'), 'a disposed material only gives up its own pin');
  live();
  assert.equal(f.nodes.nodeBuilderCache.has('terrain'), false);
  assert.deepEqual(f.released.filter(key => key.startsWith('terrain')), ['terrain', 'terrain:v', 'terrain:f']);
  assert.equal(((retained as any)._listeners?.dispose ?? []).length, 0, 'no listener outlives the material');
});

test('materials sharing one program hold it until the last of them is disposed, and teardown releases all', () => {
  const f = fakeRenderer(), release = installProgramRetention(f.renderer)!;
  const pages = [new MeshBasicMaterial(), new MeshBasicMaterial()];
  for (const page of pages) { page.userData.retainProgram = true; f.draw(page, 'arena')(); }
  assert.deepEqual(f.builds, ['arena']);
  pages[0].dispose();
  f.draw(pages[1], 'arena')();
  assert.deepEqual(f.builds, ['arena'], 'the surviving page still owns the program');
  const other = new MeshBasicMaterial(); other.userData.retainProgram = true;
  f.draw(other, 'other')();
  release(); release();
  assert.equal(f.nodes.nodeBuilderCache.size, 0);
  assert.equal(f.pipelines.caches.size, 0);
  pages[1].dispose(); other.dispose(); // listeners are gone: nothing is released twice
  assert.equal(f.released.filter(key => key === 'arena').length, 1);
});

test('unknown renderer internals leave the renderer untouched', () => {
  const renderer = { _nodes: {}, _pipelines: {} };
  assert.equal(installProgramRetention(renderer), null);
  assert.deepEqual(renderer, { _nodes: {}, _pipelines: {} });
});
