import type { ApiSection } from './ScriptApiContract.ts';
import { ENTITY_SCRIPT_SDK } from '../scripting/EntityScriptSDK.generated.ts';

/** Read signatures from the exact SDK source supplied to the compiler. */
const classes: ApiSection[] = [];
let current: ApiSection | null = null;
for (const line of ENTITY_SCRIPT_SDK.split('\n')) {
  const declaration = line.match(/^export class (\w+)(?: extends (\w+))?/);
  if (declaration) {
    current = { id: `sdk-${declaration[1].toLowerCase()}`, title: declaration[1],
      intro: declaration[2] ? `Extends ${declaration[2]}; inherited typed data accessors are available.` : undefined,
      entries: [] };
    classes.push(current);
  }
  const member = line.match(/^  ((?:static )?(?:get )?\w+(?:\([^\n]*?\))?: [^{]+) \{/);
  if (member && current) current.entries!.push({ signature: member[1].trim(), description: 'Callable SDK signature.' });
}
export const AS_LANGUAGE_SECTION: ApiSection = {
  id: 'assemblyscript', title: 'AssemblyScript language and available libraries',
  facts: [
    'Write an AssemblyScript controller BODY. The compiler supplies `self: Component` and `ctx: Context`; do not add imports, exports, or a tick wrapper. Source is compiled to native WebAssembly when saved. Compilation is asynchronous; the browser uses a separate compiler worker.',
    'Use explicit numeric types (`f64`, `i32`, `u32`), `bool`, `string`, and `f64[]` vectors. AssemblyScript resembles TypeScript but does not implement JavaScript dynamic objects, undefined, eval, or npm module loading.',
    'Available standard library: Math/Mathf, typed arrays, Array<T>, StaticArray<T>, Map<K,V>, Set<T>, and strings. The pinned AssemblyScript compiler is 0.28.20. No third-party guest packages are currently exposed. The former gl-matrix, simplex-noise, seedrandom, tween.js, robot3, culori and ngraph namespaces, and ctx.math/spatial/random/noise/ease/control/timer helpers, have been removed.',
    'Math.random() uses a deterministic seed derived from entity ID, component ID and tick. The sequence restarts from that seed each invocation; store custom PRNG state explicitly when you need another sequence.',
    'Persistent state uses `self.state.getNumber/setNumber`, `getString/setString`, `getBoolean/setBoolean`, `get/set` and `setVector`. Getter defaults are 0, empty string and false; an optional fallback may be supplied. Do not write `self.state.foo`. Only state survives ticks; WASM instances and local variables are recreated each tick.',
    'Records, options, snapshots, command results, contacts and messages use `Value`. Construct with `Value.object()` / `Value.array()`, set typed fields, and read with typed getters. Use `.at(i)` for array items, `.length`, `.isNull`, and `.asVector()`. A missing record is a Value with isNull=true, not a JavaScript null. child(id) is the exception: it returns Component | null.',
    'Returned snapshots are read-only. Assigning one into state copies its JSON-compatible data. Prototype access, host globals, browser APIs, Node, filesystem and network are unavailable. Prefer local typed arrays for computation; each SDK access crosses the WASM/host boundary.',
    'New portable components store `scriptLanguage: "assemblyscript"`; flat runtime script entries store `language: "assemblyscript"`. Loading/importing/saving unmarked or differently marked legacy scripts replaces their code with an empty string. No historical source translation is performed.',
  ],
  examples: [
    { title: 'Hover controller', code: `const lift: f64 = ctx.mass * Math.abs(ctx.gravity[1])
  + (5.0 - ctx.groundDistance) * 34.0 - ctx.velocity[1] * 13.0;
self.applyForce([0, Math.max(0, lift), 0]);
self.state.setNumber("ticks", self.state.getNumber("ticks") + 1);` },
    { title: 'World edit and later result', code: `if (!self.state.getBoolean("placed")) {
  const options = Value.object().setNumber("color", 0x44aaff);
  const queued = ctx.world.voxels.set([10, 20, 30], options);
  if (queued.getBoolean("ok")) {
    self.state.setBoolean("placed", true);
    self.state.setString("command", queued.getString("commandId"));
  }
}
const result = ctx.commands.result(self.state.getString("command"));
if (!result.isNull) ctx.log(result.getString("reason"));` },
    { title: 'Read observations', code: `if (ctx.players.length > 0) {
  const eye = ctx.players.at(0).get("position").asVector();
  self.state.setVector("lastEye", eye);
}
const arm = self.child("arm");
if (arm) arm.setLocalSpin([0, 1, 0], 60);` }
  ],
};
export const AS_SDK_SECTION: ApiSection = {
  id: 'typed-sdk', title: 'Complete typed SDK signatures',
  intro: 'Signatures below are generated from the compiler SDK. Component, Context, Value and the other named classes are available without imports. Generic Value.call(name,args) invokes only registered own host API methods; use Value.array() for its argument list.',
  subsections: classes,
};
