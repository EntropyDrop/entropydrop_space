import test from 'node:test';
import assert from 'node:assert/strict';
import { getCodeCompletions, applyCodeCompletion } from '../src/ui/react/utils/codeCompletion.ts';
import { SPACE_SCRIPT_API_V3 } from '@entropydrop/space-engine/contraption/ScriptApiContract.ts';

function query(source: string, explicit = false) {
  return getCodeCompletions(source, source.length, explicit);
}
function labels(source: string, explicit = false) {
  return query(source, explicit)?.items.map(item => item.label) ?? [];
}

test('self and ctx completion follows the exact compiler SDK including inherited members', () => {
  const sections = SPACE_SCRIPT_API_V3.sections.find(section => section.id === 'typed-sdk')!.subsections!;
  for (const [expression, name] of [['self.', 'Component'], ['ctx.', 'Context'],
    ['self.state.', 'State'], ['ctx.input.', 'Input'], ['self.body.', 'Body'],
    ['ctx.world.voxels.', 'Voxels'], ['ctx.world.microVoxels.', 'MicroVoxels'],
    ['ctx.selection.', 'Selection'], ['self.decorations.', 'Decorations'], ['ctx.messages.', 'Messages']]) {
    const items = query(expression)!.items;
    for (const entry of sections.find(section => section.title === name)!.entries!) {
      if (entry.signature.startsWith('static ')) continue;
      const label = entry.signature.match(/^(?:get )?(\w+)/)![1];
      assert.ok(items.some(item => item.label === label), `${expression} includes ${label}`);
    }
    assert.equal(new Set(items.map(item => item.label)).size, items.length, 'overrides never create duplicate candidates');
  }
  assert.ok(labels('self.state.').includes('getNumber'), 'State inherits typed Value accessors');
  assert.ok(labels('self.').indexOf('setLocalSpin') < labels('self.').indexOf('getNumber'), 'component APIs rank before generic inherited methods');
  assert.ok(!labels('self.').includes('object'), 'static constructors are not instance methods');
});

test('filtered candidates include typed signatures and canonical API descriptions', () => {
  const result = query('self.setLocalS')!;
  assert.deepEqual(result.items.map(item => item.label), ['setLocalSpin']);
  const item = result.items[0];
  assert.equal(item.signature, 'setLocalSpin(axis: f64[], rpm: f64): void');
  assert.match(item.description, /continuous local-axis spin/);
  assert.equal(item.hasParameters, true);
  assert.deepEqual(labels('ctx.input.pre'), ['pressed']);
  assert.deepEqual(labels('self.SETLOCALs'), ['setLocalSpin']);
});

test('nested properties and calls resolve return types without offering unrelated namespaces', () => {
  assert.ok(labels('ctx.root.body.').includes('getType'));
  assert.ok(labels('self.child("wheel").').includes('setLocalSpin'));
  assert.ok(labels('self.children()[0].').includes('setLocalSpin'));
  assert.ok(labels('(ctx.root).').includes('setLocalSpin'));
  assert.ok(labels('Value.object().').includes('setVector'));
  assert.ok(labels('self.getBounds().').includes('getNumber'));
  assert.ok(labels('ctx.commands.result("id").').includes('getString'));
  assert.deepEqual(labels('ctx.unknown.'), []);
  assert.deepEqual(labels('other.'), []);
  assert.deepEqual(labels('unknown(self).'), []);
  assert.ok(!labels('ctx.input.').includes('setLocalSpin'));
});

test('local component and Value variables, annotations, scope and shadowing affect completion', () => {
  assert.ok(labels('const wheel = self.child("wheel"); if (wheel) wheel.').includes('setLocalSpin'));
  assert.ok(labels('const settings = Value.object().setNumber("mass", 10); settings.').includes('getNumber'));
  assert.ok(labels('let wheel: Component | null = self.child("wheel"); wheel.').includes('setLocalSpin'));
  assert.ok(labels('const driver = ctx.root; driver.body.').includes('getType'));
  assert.ok(labels('const wheel = self; { const wheel = ctx.input; } wheel.').includes('setLocalSpin'));
  assert.ok(!labels('const wheel = self; { const wheel = ctx.input; wheel.').includes('setLocalSpin'));
  assert.deepEqual(labels('{ const wheel = self; } wheel.'), []);
  assert.deepEqual(labels('const self = 1; self.'), [], 'a local shadow must not fall back to the global Component');
  assert.ok(labels('const wheel = self; whe').includes('wheel'));
  assert.equal(query('const wheel'), null, 'new declaration names are not completion sites');
});

test('comments and strings never suggest code, including escaped quotes and incomplete comments', () => {
  for (const source of ['// self.set', '/* self.', 'ctx.log("self.', "ctx.log('self.",
    'ctx.log("escaped \\\" self.', '/* comment */ // ctx.', '`self.']) {
    assert.equal(query(source, true), null, source);
  }
  assert.ok(labels('// self.\nctx.input.').includes('down'));
  assert.ok(labels('/* ctx. */ self.').includes('setLocalSpin'));
  assert.ok(labels('self /* note */ .').includes('setLocalSpin'));
  assert.ok(labels('ctx.log("self."); self.').includes('setLocalSpin'));
});

test('manual completion includes globals and keywords without browser or removed APIs', () => {
  assert.equal(query(''), null);
  for (const label of ['self', 'ctx', 'Value', 'Math', 'f64', 'if', 'const']) assert.ok(labels('', true).includes(label));
  for (const label of ['window', 'fetch', 'console', 'eval', 'undefined']) assert.ok(!labels('', true).includes(label));
  for (const label of ['math', 'spatial', 'noise', 'random']) assert.ok(!labels('ctx.').includes(label));
  assert.deepEqual(labels('sel'), ['self', 'Selection'], 'case-matching names rank first');
});

test('Math and Mathf suggestions use their correct numeric precision', () => {
  assert.equal(query('Math.sin')!.items[0].signature, 'sin(x: f64): f64');
  assert.equal(query('Mathf.sin')!.items[0].signature, 'sin(x: f32): f32');
  assert.equal(query('Math.PI')!.items[0].kind, 'property');
  assert.ok(query('Math.random')!.items[0].hasParameters === false);
});

test('accepting a method inserts parentheses and puts the caret inside the argument list', () => {
  const source = 'self.setLocalS';
  const result = query(source)!;
  const edit = applyCodeCompletion(source, result, result.items[0]);
  assert.equal(edit.source, 'self.setLocalSpin()');
  assert.equal(edit.source.slice(0, edit.selection), 'self.setLocalSpin(');
  const noArgs = query('self.getLocalP')!;
  const zeroEdit = applyCodeCompletion('self.getLocalP', noArgs, noArgs.items[0]);
  assert.equal(zeroEdit.source, 'self.getLocalPosition()');
  assert.equal(zeroEdit.selection, zeroEdit.source.length);
});

test('completion replaces the full token at a middle-of-line caret and preserves surrounding code', () => {
  const source = 'if (true) { self.setLocalSpn([0, 1, 0], 30); }';
  const caret = source.indexOf('Spn') + 1;
  const result = getCodeCompletions(source, caret)!;
  const edit = applyCodeCompletion(source, result, result.items.find(item => item.label === 'setLocalSpin')!);
  assert.equal(edit.source, 'if (true) { self.setLocalSpin([0, 1, 0], 30); }');
  assert.equal(edit.source.slice(edit.selection), '([0, 1, 0], 30); }');
});

test('property insertion and existing spaced call syntax do not add parentheses', () => {
  const property = query('ctx.deltaT')!;
  const edit = applyCodeCompletion('ctx.deltaT', property, property.items[0]);
  assert.equal(edit.source, 'ctx.deltaTime');
  const source = 'self.setLocalS  ([0, 1, 0], 30);';
  const result = getCodeCompletions(source, 'self.setLocalS'.length)!;
  assert.equal(applyCodeCompletion(source, result, result.items[0]).source, 'self.setLocalSpin  ([0, 1, 0], 30);');
});
