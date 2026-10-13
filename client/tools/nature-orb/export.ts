import { mkdir, writeFile } from 'node:fs/promises';
import { createNatureOrb } from './model.ts';
import { encodeInventoryResource, decodeInventoryResource } from '../../../engine/src/storage/InventoryProtobuf.ts';
import { compileEntityScript } from '../../../engine/src/scripting/AssemblyScriptCompiler.ts';

const model = createNatureOrb(), nodes = [model.root, ...model.root.children];
for (const node of nodes) await compileEntityScript(node.script!);
const bytes = encodeInventoryResource('entity', model);
const decoded = decodeInventoryResource(bytes, 'entity');
const localOutput = new URL('../../../.local/nature-vehicle-exports/nature-orb/', import.meta.url);
await mkdir(localOutput, { recursive: true });
await writeFile(new URL('./volna-01.entity.pb', import.meta.url), bytes);
await writeFile(new URL('volna-01.json', localOutput), JSON.stringify(decoded.portable));
console.log(JSON.stringify({ bytes: bytes.length, components: nodes.length,
  voxels: nodes.reduce((sum, node) => sum + node.blocks.length, 0),
  decorations: nodes.reduce((sum, node) => sum + node.decorations!.length, 0),
  compiledScripts: nodes.length }));
