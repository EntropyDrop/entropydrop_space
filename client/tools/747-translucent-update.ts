import { VoxelMaterialIds } from '../../engine/src/voxel/VoxelMaterials.ts';
import { ensureSpaceAccessToken } from '../src/bootstrap/SpaceAuthSession.ts';

// Local maintenance page: update the existing plane using the current server
// revision. No copy of an old definition is ever written back to the world.
const apiOrigin = 'http://localhost:8000';
const entityId = '83d08a45-7e87-462e-b30d-77188072a29a';
const output = document.querySelector('#result')!;
const apply = document.querySelector('#apply') as HTMLButtonElement;
let base = '';
let current: any;
let token: string | null;
let components: any[] = [];
let pendingPatch: unknown;

async function request(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, cache: 'no-store',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail[0]?.msg : data.detail;
    throw new Error(`${response.status}: ${detail || JSON.stringify(data)}`);
  }
  return data;
}
function nodes(root: any): any[] { return [root, ...(root.children ?? []).flatMap(nodes)]; }
const glassId = /^(?:(?:left|right)_(?:cockpit_window|(?:door_|upper_)?window_\d+)|windshield_(?:left|right))$/;

// Backup remains in this tab and can be saved before applying the small patch.
function offerBackup(value: unknown) {
  document.querySelector('#backup')?.remove();
  const link = document.createElement('a');
  link.id = 'backup'; link.textContent = 'Save entity configuration before update';
  link.download = `747-before-translucent-r${current.entity.revision}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], {type:'application/json'}));
  link.href = url; document.body.insertBefore(link, output);
  link.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 1000), {once:true});
}

document.querySelector('#read')!.addEventListener('click', async () => {
  apply.disabled = true;
  try {
    if (location.hostname !== 'localhost' || !import.meta.env.DEV) throw new Error('Local development only');
    token = await ensureSpaceAccessToken(apiOrigin);
    if (!token) throw new Error('Sign in to local Space first');
    const world = await request(`${apiOrigin}/space/api/v2/worlds/nature`);
    base = `${apiOrigin}/space/api/v2/worlds/${encodeURIComponent(world.id)}/entities/${entityId}/configuration`;
    current = await request(base);
    if (current.entity.id !== entityId) throw new Error('Unexpected entity');
    const root = current.definition.root;
    components = nodes(root).map(node => ({ id: node.id, decoration_ops: (node.decorations ?? [])
      .filter((d: any) => glassId.test(d.id) && d.materialId !== VoxelMaterialIds.TRANSLUCENT)
      .map((d: any) => ({ op: 'upsert', id: d.id, materialId: VoxelMaterialIds.TRANSLUCENT })) })).filter(c => c.decoration_ops.length);
    pendingPatch = { operation_id: crypto.randomUUID(), expected_revision: current.entity.revision, components };
    output.textContent = JSON.stringify({ entity: current.entity.name, revision: current.entity.revision,
      state: current.entity.desired_run_state, windowCount: components.reduce((n,c) => n + c.decoration_ops.length, 0),
      targetMaterialId: VoxelMaterialIds.TRANSLUCENT, transparency: '60%',
      componentIds: components.map(c => c.id) }, null, 2);
    offerBackup(current);
    apply.disabled = !components.length || current.entity.desired_run_state !== 'stopped';
  } catch (error) { output.textContent = String(error); }
});

apply.addEventListener('click', async () => {
  apply.disabled = true;
  try {
    // Keep the operation ID after a lost response so retries cannot double-apply.
    const result = await request(base, 'PATCH', pendingPatch);
    current = await request(base);
    const all = nodes(current.definition.root).flatMap(n => n.decorations ?? []);
    const windows = all.filter((d: any) => glassId.test(d.id));
    if (!windows.length || windows.some((d: any) => d.materialId !== VoxelMaterialIds.TRANSLUCENT)) throw new Error('Glass material verification failed');
    output.textContent = JSON.stringify({status:'updated', revision:result.revision,
      verifiedWindows:windows.length, totalDecorations:all.length, ids:windows.map((d: any)=>d.id)}, null, 2);
  } catch (error) {
    output.textContent = String(error);
    apply.disabled = false;
  }
});
