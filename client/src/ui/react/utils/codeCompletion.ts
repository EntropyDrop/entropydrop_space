import { SPACE_SCRIPT_API_V3, type ApiSection } from '@entropydrop/space-engine/contraption/ScriptApiContract.ts';

export interface CodeCompletion {
  label: string;
  signature: string;
  description: string;
  kind: 'method' | 'property' | 'variable' | 'keyword' | 'class';
  type: string;
  hasParameters?: boolean;
  inherited?: boolean;
  static?: boolean;
}

export interface CodeCompletionQuery {
  from: number;
  to: number;
  items: CodeCompletion[];
}

interface SdkClass { parent?: string; members: CodeCompletion[] }
const sdk = new Map<string, SdkClass>();
const sdkSection = SPACE_SCRIPT_API_V3.sections.find(section => section.id === 'typed-sdk');
for (const section of sdkSection?.subsections ?? []) {
  const members: CodeCompletion[] = [];
  for (const entry of section.entries ?? []) {
    const match = entry.signature.match(/^(static )?(get )?(\w+)(\(.*\))?: (.+)$/);
    if (!match) continue;
    const [, isStatic, getter, name, parameters, type] = match;
    const method = !!parameters && !getter;
    members.push({ label: name, signature: `${name}${method ? parameters : ''}: ${type}`,
      description: `${section.title} ${method ? 'method' : 'property'}.`, type,
      kind: method ? 'method' : 'property', hasParameters: method && parameters !== '()', static: !!isStatic });
  }
  sdk.set(section.title, { parent: section.intro?.match(/^Extends (\w+)/)?.[1], members });
}

function cleanType(type: string): string { return type.replace(/\s*\|\s*null/g, '').trim(); }

function membersOf(type: string): CodeCompletion[] {
  const isStatic = type.startsWith('typeof ');
  const definition = sdk.get(cleanType(type.replace(/^typeof /, '')));
  if (!definition) return [];
  const own = definition.members.filter(member => !!member.static === isStatic);
  const names = new Set(own.map(member => member.label));
  const inherited = !isStatic && definition.parent ? membersOf(definition.parent)
    .filter(member => !names.has(member.label)).map(member => ({ ...member, inherited: true })) : [];
  return [...own, ...inherited];
}

// Add explanations from the same canonical contract used by the in-game docs.
function addDescriptions(section: ApiSection) {
  if (section.id === 'typed-sdk') return;
  for (const entry of section.entries ?? []) {
    for (const path of entry.signature.matchAll(/\b(self|ctx)((?:\.\w+)+)/g)) {
      let type = path[1] === 'self' ? 'Component' : 'Context';
      const parts = path[2].slice(1).split('.');
      for (let i = 0; i < parts.length; i++) {
        const member = membersOf(type).find(member => member.label === parts[i]);
        if (!member) break;
        if (i === parts.length - 1) member.description = entry.description.replace(/`/g, '');
        type = member.type;
      }
    }
  }
  section.subsections?.forEach(addDescriptions);
}
SPACE_SCRIPT_API_V3.sections.forEach(addDescriptions);

const mathMembers: CodeCompletion[] = [
  ['abs', 'x: f64'], ['min', 'a: f64, b: f64'], ['max', 'a: f64, b: f64'],
  ['sin', 'x: f64'], ['cos', 'x: f64'], ['tan', 'x: f64'], ['asin', 'x: f64'], ['acos', 'x: f64'],
  ['atan', 'x: f64'], ['atan2', 'y: f64, x: f64'], ['sqrt', 'x: f64'], ['pow', 'base: f64, exponent: f64'],
  ['floor', 'x: f64'], ['ceil', 'x: f64'], ['round', 'x: f64'], ['trunc', 'x: f64'],
  ['exp', 'x: f64'], ['log', 'x: f64'], ['random', ''],
].map(([label, args]) => ({ label, signature: `${label}(${args}): f64`, description: 'AssemblyScript Math function.',
  kind: 'method', type: 'f64', hasParameters: !!args }));
mathMembers.push(...['PI', 'E'].map(label => ({ label, signature: `${label}: f64`,
  description: 'AssemblyScript Math constant.', kind: 'property' as const, type: 'f64' })));
const mathfMembers = mathMembers.map(member => ({ ...member, signature: member.signature.replaceAll('f64', 'f32'), type: 'f32' }));

const globals: CodeCompletion[] = [
  ...[['self', 'Component'], ['ctx', 'Context'], ['Math', 'typeof Math'], ['Mathf', 'typeof Mathf']].map(([label, type]) => ({
    label, signature: `${label}: ${type}`, description: 'Available in every component script.', kind: 'variable' as const, type })),
  ...[...sdk.keys(), 'Array', 'StaticArray', 'Map', 'Set', 'Uint8Array', 'Float64Array'].map(label => ({
    label, signature: label, description: 'AssemblyScript class.', kind: 'class' as const, type: `typeof ${label}` })),
  ...['const', 'let', 'if', 'else', 'for', 'while', 'return', 'break', 'continue', 'new',
    'true', 'false', 'null', 'f64', 'f32', 'i32', 'u32', 'bool', 'string'].map(label => ({
    label, signature: label, description: 'AssemblyScript keyword or type.', kind: 'keyword' as const, type: '' })),
];

interface Token { text: string; from: number; to: number; kind?: 'string' }

// Tolerate incomplete source while excluding comments and string contents.
function tokenize(source: string): { tokens: Token[]; inLiteral: boolean } {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length;) {
    const from = i;
    if (/\s/.test(source[i])) { i++; continue; }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      if (end < 0) return { tokens, inLiteral: true };
      i = end + 1; continue;
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) return { tokens, inLiteral: true };
      i = end + 2; continue;
    }
    if (/['"`]/.test(source[i])) {
      const quote = source[i++];
      let closed = false;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === quote) { closed = true; break; }
      }
      if (!closed) return { tokens, inLiteral: true };
      tokens.push({ text: source.slice(from, i), from, to: i, kind: 'string' });
      continue;
    }
    const word = source.slice(i).match(/^[A-Za-z_$][\w$]*|^\d+(?:\.\d+)?/);
    i += word ? word[0].length : 1;
    tokens.push({ text: source.slice(from, i), from, to: i });
  }
  return { tokens, inLiteral: false };
}

function opening(tokens: Token[], end: number, left: string, right: string): number {
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (tokens[i].kind === 'string') continue;
    if (tokens[i].text === right) depth++;
    if (tokens[i].text === left && --depth === 0) return i;
  }
  return -1;
}

function inferType(tokens: Token[], end: number, variables: Map<string, string>, depth = 0): string {
  if (end < 0 || depth > 24) return '';
  const token = tokens[end];
  if (token.kind === 'string') return 'string';
  if (token.text === '!') return inferType(tokens, end - 1, variables, depth + 1);
  if (token.text === ')') {
    const start = opening(tokens, end, '(', ')');
    if (start < 0) return '';
    if (tokens[start - 2]?.text === '.') {
      const type = inferType(tokens, start - 3, variables, depth + 1);
      return cleanType(getMembers(type).find(member => member.label === tokens[start - 1].text && member.kind === 'method')?.type ?? '');
    }
    // Grouped expression or constructor.
    if (tokens[start - 2]?.text === 'new') return tokens[start - 1].text;
    if (/^[\w$]+$/.test(tokens[start - 1]?.text ?? '')) return '';
    return start === end - 1 ? '' : inferType(tokens, end - 1, variables, depth + 1);
  }
  if (token.text === ']') {
    const start = opening(tokens, end, '[', ']');
    const arrayType = start > 0 ? inferType(tokens, start - 1, variables, depth + 1) : '';
    return arrayType.endsWith('[]') ? arrayType.slice(0, -2) : '';
  }
  if (tokens[end - 1]?.text === '.') {
    const type = inferType(tokens, end - 2, variables, depth + 1);
    return cleanType(getMembers(type).find(member => member.label === token.text)?.type ?? '');
  }
  return variables.get(token.text) ?? globals.find(item => item.label === token.text)?.type ?? '';
}

function getMembers(type: string): CodeCompletion[] {
  return type === 'typeof Math' ? mathMembers : type === 'typeof Mathf' ? mathfMembers : membersOf(type);
}

function localVariables(tokens: Token[]): Map<string, string> {
  const scopes = [new Map<string, string>()];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === '{') scopes.push(new Map(scopes.at(-1)!));
    if (tokens[i].text === '}' && scopes.length > 1) scopes.pop();
    if (!['const', 'let', 'var'].includes(tokens[i].text) || !tokens[i + 1]?.text.match(/^[A-Za-z_$][\w$]*$/)) continue;
    const name = tokens[i + 1].text;
    const variables = scopes.at(-1)!;
    let j = i + 2, type = '';
    if (tokens[j]?.text === ':') {
      const start = ++j;
      while (j < tokens.length && !['=', ';', ')', ','].includes(tokens[j].text)) j++;
      type = cleanType(tokens.slice(start, j).map(token => token.text).join(''));
    }
    if (!type && tokens[j]?.text === '=') {
      let end = j + 1;
      let nesting = 0;
      for (; end < tokens.length; end++) {
        if (tokens[end].kind === 'string') continue;
        if (nesting === 0 && [';', ',', '}'].includes(tokens[end].text)) break;
        if (['(', '[', '{'].includes(tokens[end].text)) nesting++;
        if ([')', ']', '}'].includes(tokens[end].text)) {
          if (nesting === 0) break;
          nesting--;
        }
      }
      type = inferType(tokens, end - 1, variables);
    }
    variables.set(name, type);
  }
  return scopes.at(-1)!;
}

export function getCodeCompletions(source: string, caret: number, explicit = false): CodeCompletionQuery | null {
  const before = source.slice(0, caret);
  const { tokens, inLiteral } = tokenize(before);
  if (inLiteral) return null;
  const prefix = before.match(/[A-Za-z_$][\w$]*$/)?.[0] ?? '';
  const from = caret - prefix.length;
  const to = caret + (source.slice(caret).match(/^[\w$]*/)?.[0].length ?? 0);
  if (prefix) tokens.pop();
  if (['const', 'let', 'var'].includes(tokens.at(-1)?.text ?? '')) return null;
  const variables = localVariables(tokens);
  let candidates: CodeCompletion[];
  if (tokens.at(-1)?.text === '.') {
    candidates = getMembers(inferType(tokens, tokens.length - 2, variables));
  } else {
    if (!explicit && !prefix) return null;
    candidates = [...globals.filter(item => !variables.has(item.label)), ...[...variables].map(([label, type]) => ({
      label, type, signature: `${label}${type ? `: ${type}` : ''}`, description: 'Local variable.', kind: 'variable' as const }))];
  }
  const items = candidates.filter(item => item.label.toLowerCase().startsWith(prefix.toLowerCase()))
    .sort((a, b) => Number(!a.label.startsWith(prefix)) - Number(!b.label.startsWith(prefix))
      || Number(!!a.inherited) - Number(!!b.inherited) || a.label.localeCompare(b.label));
  return items.length ? { from, to, items } : null;
}

export function applyCodeCompletion(source: string, query: CodeCompletionQuery, item: CodeCompletion) {
  const addCall = item.kind === 'method' && !/^\s*\(/.test(source.slice(query.to));
  const text = item.label + (addCall ? '()' : '');
  const selection = query.from + text.length - (addCall && item.hasParameters ? 1 : 0);
  return { from: query.from, to: query.to, text, selection,
    source: source.slice(0, query.from) + text + source.slice(query.to) };
}
