import { phpTokens, position, type PhpToken } from '../php-source';

// Fontes de configuração do Symfony além de atributos/YAML (symfony.com/doc): rotas em PHP
// (RoutingConfigurator) e XML, config/bundles.php, autoload PSR-4 do Composer para achar o
// diretório dos bundles e o container compilado (`var/cache/<env>/*Container.xml`), que o
// plugin Symfony Support do PhpStorm também lê. Implementação própria; Web Worker não tem DOMParser.

export type Route = { name: string; path: string; methods: string; file: string; line: number; character: number; length: number };
export type Definition = { key: string; file: string; line: number; character: number; value?: string; class?: string };

// ── XML ─────────────────────────────────────────────────────────────────────────────────────────
export type XmlTag = { name: string; attrs: Record<string, { value: string; offset: number }>; offset: number; end: number; close: boolean; self: boolean; depth: number };
const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export const decodeXml = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (all, e: string) => e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : entities[e] ?? all);
/** Tags em ordem, ignorando comentários, CDATA e declarações; `depth` é a profundidade do elemento. */
export function xmlTags(text: string): XmlTag[] {
 const out: XmlTag[] = []; let depth = 0; let i = 0;
 while (i < text.length) {
  const lt = text.indexOf('<', i); if (lt < 0) break;
  const skip = (close: string) => { const e = text.indexOf(close, lt); i = e < 0 ? text.length : e + close.length; };
  if (text.startsWith('<!--', lt)) { skip('-->'); continue; }
  if (text.startsWith('<![CDATA[', lt)) { skip(']]>'); continue; }
  if (text[lt + 1] === '?' || text[lt + 1] === '!') { skip('>'); continue; }
  const m = /^<(\/?)([\w:.-]+)/.exec(text.slice(lt, lt + 200)); if (!m) { i = lt + 1; continue; }
  let j = lt + m[0].length; let quote = '';
  for (; j < text.length; j++) { const c = text[j]; if (quote) { if (c === quote) quote = ''; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break; }
  const start = lt + m[0].length; const body = text.slice(start, j);
  const attrs: XmlTag['attrs'] = {};
  for (const a of body.matchAll(/([\w:.-]+)\s*=\s*(["'])([\s\S]*?)\2/g)) attrs[a[1]] = { value: decodeXml(a[3]), offset: start + a.index! + a[0].indexOf(a[2]) + 1 };
  const close = m[1] === '/'; const self = /\/\s*$/.test(body);
  if (close) depth--;
  out.push({ name: m[2], attrs, offset: lt, end: Math.min(j + 1, text.length), close, self, depth });
  if (!close && !self) depth++;
  i = j + 1;
 }
 return out;
}
/** Texto entre a abertura e a próxima tag (valor de `<parameter>`, `<source>`…). */
export const xmlText = (text: string, tags: XmlTag[], index: number) => tags[index].self ? '' : decodeXml(text.slice(tags[index].end, tags[index + 1]?.offset ?? text.length).trim());

/** `<route id path methods>` de config/routes/*.xml (inclusive dentro de `<when env>`). */
export function parseXmlRoutes(text: string, file: string): Route[] {
 return xmlTags(text).filter(t => t.name === 'route' && !t.close && t.attrs.id).map(t => {
  const id = t.attrs.id; const methods = (t.attrs.methods?.value ?? '').split(/[|,\s]+/).filter(Boolean).map(m => m.toUpperCase()).join('|');
  return { name: id.value, path: t.attrs.path?.value ?? '', methods: methods || 'ANY', file, ...position(text, id.offset), length: id.value.length };
 });
}


// ── PHP ─────────────────────────────────────────────────────────────────────────────────────────
/** Argumentos de nível zero da chamada cujo `(` está em `open`. */
export function callArguments(tokens: PhpToken[], open: number) {
 const args: PhpToken[][] = [[]]; let depth = 0; let i = open + 1;
 for (; i < tokens.length; i++) {
  const v = tokens[i].type === 'punct' ? tokens[i].value : '';
  if (v === '(' || v === '[' || v === '{') depth++;
  else if (v === ')' || v === ']' || v === '}') { if (depth === 0) break; depth--; }
  else if (v === ',' && depth === 0) { args.push([]); continue; }
  args.at(-1)!.push(tokens[i]);
 }
 return { args: args.filter((a, n) => a.length || n === 0), close: i };
}
const single = (arg: PhpToken[] | undefined) => arg?.length === 1 && arg[0].type === 'string' ? arg[0] : undefined;

/** `$routes->add('nome', '/caminho')->methods([...])` de config/routes*.php (RoutingConfigurator). */
export function parsePhpRoutes(text: string, file: string): Route[] {
 const tokens = phpTokens(text); const out: Route[] = [];
 for (let i = 0; i < tokens.length; i++) {
  if (tokens[i].value !== 'add' || tokens[i - 1]?.value !== '->' || tokens[i + 1]?.value !== '(') continue;
  const { args, close } = callArguments(tokens, i + 1);
  const name = single(args[0]); if (!name) continue;
  const path = single(args[1]) ?? args[1]?.find(t => t.type === 'string');
  let methods: string[] = [];
  for (let j = close + 1, depth = 0; j < tokens.length; j++) {
   const v = tokens[j].value;
   if (v === '(' || v === '[') depth++; else if (v === ')' || v === ']') depth--;
   if (depth < 0 || (v === ';' && depth === 0)) break;
   if (v === 'methods' && tokens[j - 1]?.value === '->' && tokens[j + 1]?.value === '(') methods = callArguments(tokens, j + 1).args.flat().filter(t => t.type === 'string').map(t => t.value.toUpperCase());
  }
  out.push({ name: name.value, path: path?.value ?? '', methods: methods.join('|') || 'ANY', file, ...position(text, name.offset + 1), length: name.value.length });
 }
 return out;
}


