import { ToolingError } from './models';

type Property = { key: string; value: JsonNode };
type JsonNode = { start: number; end: number; value: unknown; properties?: Property[]; trailingComma?: boolean };

/** A small JSONC reader for targeted devcontainer edits. No evaluation or runtime dependency. */
function readObject(text: string): JsonNode {
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const fail = (): never => { throw new ToolingError('INVALID_REQUEST', 'The existing devcontainer configuration is not a supported JSONC object. No file was changed.'); };
  function trivia() {
    for (;;) {
      while (/[\t\r\n ]/.test(text[at] ?? '\0')) at++;
      if (text.startsWith('//', at)) { while (at < text.length && text[at] !== '\n') at++; }
      else if (text.startsWith('/*', at)) { const end = text.indexOf('*/', at + 2); if (end < 0) fail(); at = end + 2; }
      else return;
    }
  }
  function string(): string {
    if (text[at] !== '"') return fail();
    const start = at++;
    while (at < text.length) {
      const char = text[at++];
      if (char === '\\') { at++; continue; }
      if (char === '"') { try { return JSON.parse(text.slice(start, at)); } catch { return fail(); } }
    }
    return fail();
  }
  function node(depth: number): JsonNode {
    if (depth > 100) return fail();
    trivia();
    const start = at;
    if (text[at] === '{') {
      at++; trivia();
      const value: Record<string, unknown> = Object.create(null);
      const properties: Property[] = [];
      let trailingComma = false;
      while (text[at] !== '}') {
        const key = string(); trivia();
        if (text[at++] !== ':' || Object.hasOwn(value, key)) return fail();
        const child = node(depth + 1); value[key] = child.value; properties.push({ key, value: child }); trivia();
        if (text[at] !== ',') break;
        at++; trivia(); trailingComma = text[at] === '}';
      }
      if (text[at++] !== '}') return fail();
      return { start, end: at, value, properties, trailingComma };
    }
    if (text[at] === '[') {
      at++; trivia(); const value: unknown[] = [];
      while (text[at] !== ']') {
        value.push(node(depth + 1).value); trivia();
        if (text[at] !== ',') break;
        at++; trivia();
      }
      if (text[at++] !== ']') return fail();
      return { start, end: at, value };
    }
    if (text[at] === '"') return { start, value: string(), end: at };
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(literal, at)) { at += literal.length; return { start, end: at, value }; }
    }
    const number = text.slice(at).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number || !Number.isFinite(Number(number[0]))) return fail();
    at += number[0].length;
    return { start, end: at, value: Number(number[0]) };
  }
  const result = node(0); trivia();
  if (at !== text.length || !result.properties) return fail();
  return result;
}

/** Keeps every existing comment and unrelated value byte-for-byte; only edits owned fields. */
export function updateDevcontainerJsonc(source: string, image: string): string {
  const text = source || '{}\n';
  const root = readObject(text);
  const object = root.value as Record<string, unknown>;
  if (object.build !== undefined || object.dockerComposeFile !== undefined) {
    throw new ToolingError('UNSUPPORTED_ACTION', 'This devcontainer uses a build or Compose definition. An image-based rewrite would change its behavior, so the existing configuration was preserved.');
  }
  const desired: Record<string, unknown> = { image };
  if (object.workspaceFolder == null || object.workspaceFolder === '') desired.workspaceFolder = '/app';
  if (object.workspaceMount == null || object.workspaceMount === '') desired.workspaceMount = 'source=${localWorkspaceFolder},target=/app,type=bind,consistency=cached';
  const edits: { start: number; end: number; value: string }[] = [];
  const additions: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    const current = root.properties!.find(property => property.key === key);
    if (current) {
      if (current.value.value !== value) edits.push({ start: current.value.start, end: current.value.end, value: JSON.stringify(value) });
    } else additions.push(`${JSON.stringify(key)}: ${JSON.stringify(value)}`);
  }
  if (additions.length) {
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const indentation = text.match(/(?:\r?\n)([\t ]+)"/)?.[1] ?? '  ';
    const last = root.properties!.at(-1);
    const needsComma = Boolean(last && !root.trailingComma);
    const adjacent = last?.value.end === root.end - 1;
    if (needsComma && !adjacent) edits.push({ start: last!.value.end, end: last!.value.end, value: ',' });
    edits.push({ start: root.end - 1, end: root.end - 1, value: `${needsComma && adjacent ? ',' : ''}${newline}${indentation}${additions.join(`,${newline}${indentation}`)}${newline}` });
  }
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  readObject(result);
  return result;
}
