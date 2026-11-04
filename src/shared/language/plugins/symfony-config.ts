import { phpTokens, position, type PhpToken } from '../php-source';
import type { ProjectFiles } from './api';
import { listIn } from './list';

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

/** Serviços (filhos diretos de `<services>`, sem ids ocultos `.x`) e parâmetros do container compilado. */
export function parseContainerXml(text: string, file: string): { services: Definition[]; parameters: Definition[] } {
 const tags = xmlTags(text); const services: Definition[] = []; const parameters: Definition[] = [];
 let servicesDepth = -1; let parametersDepth = -1;
 tags.forEach((t, index) => {
  if (t.close) { if (t.name === 'services' && t.depth === servicesDepth) servicesDepth = -1; if (t.name === 'parameters' && t.depth === parametersDepth) parametersDepth = -1; return; }
  if (t.name === 'services') servicesDepth = t.depth;
  else if (t.name === 'parameters' && parametersDepth < 0) parametersDepth = t.depth;
  else if (t.name === 'service' && servicesDepth >= 0 && t.depth === servicesDepth + 1 && t.attrs.id && !t.attrs.id.value.startsWith('.')) {
   const at = position(text, t.attrs.id.offset);
   services.push({ key: t.attrs.id.value, file, ...at, ...(t.attrs.class ? { class: t.attrs.class.value } : {}), ...(t.attrs.alias ? { value: '@' + t.attrs.alias.value } : {}) });
  } else if (t.name === 'parameter' && parametersDepth >= 0 && t.depth === parametersDepth + 1 && t.attrs.key) {
   const value = t.attrs.type?.value === 'collection' ? '[…]' : t.attrs.value?.value ?? xmlText(text, tags, index);
   parameters.push({ key: t.attrs.key.value, file, ...position(text, t.attrs.key.offset), ...(value ? { value } : {}) });
  }
 });
 return { services, parameters };
}
/** Container compilado: `var/cache/<env>/<Kernel>Container.xml`, preferindo o ambiente dev. */
export async function compiledContainer(files: ProjectFiles): Promise<string | null> {
 const list = (await listIn(files, 'var/cache', n => /Container\.xml$/.test(n))).filter(p => /^var\/cache\/[^/]+\/\w+Container\.xml$/.test(p));
 return list.sort((a, b) => Number(!a.includes('/dev/')) - Number(!b.includes('/dev/')) || a.localeCompare(b))[0] ?? null;
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

export type Bundle = { fqcn: string; name: string; alias: string; envs: string[]; line: number; character: number; length: number };
/** `Classe::class => ['all' => true]` de config/bundles.php; `alias` é o namespace Twig (`@AcmeDemo`). */
export function parseBundles(text: string): Bundle[] {
 const tokens = phpTokens(text); const out: Bundle[] = [];
 for (let i = 0; i < tokens.length; i++) {
  if (tokens[i].value !== '::' || tokens[i + 1]?.value !== 'class' || tokens[i + 2]?.value !== '=>') continue;
  let k = i - 1; while (k >= 0 && (tokens[k].value === '\\' || tokens[k].type === 'word') && !(tokens[k].type === 'word' && tokens[k - 1]?.type === 'word')) k--;
  const parts = tokens.slice(k + 1, i); const fqcn = parts.map(t => t.value).join('').replace(/^\\/, ''); if (!fqcn) continue;
  const envs: string[] = [];
  if (tokens[i + 3]?.value === '[') for (const arg of callArguments(tokens, i + 3).args) if (arg[0]?.type === 'string' && arg[1]?.value === '=>' && arg[2]?.value.toLowerCase() === 'true') envs.push(arg[0].value);
  const name = fqcn.split('\\').pop()!; const first = parts.find(t => t.type === 'word')!;
  out.push({ fqcn, name, alias: name.replace(/Bundle$/, ''), envs, ...position(text, first.offset), length: tokens[i - 1].offset + tokens[i - 1].value.length - first.offset });
 }
 return out;
}

const normalize = (path: string) => { const out: string[] = []; for (const p of path.split('/')) { if (!p || p === '.') continue; if (p === '..') out.pop(); else out.push(p); } return out.join('/'); };
/** Prefixos PSR-4 do projeto (composer.json) e das dependências (vendor/composer/installed.json). */
export async function psr4(files: ProjectFiles): Promise<{ prefix: string; dir: string }[]> {
 const json = async (path: string) => { try { const t = await files.read(path); return t ? JSON.parse(t) : null; } catch { return null; } };
 const out: { prefix: string; dir: string }[] = [];
 const add = (map: Record<string, string | string[]> | undefined, base: string) => { for (const [prefix, dirs] of Object.entries(map ?? {})) for (const dir of ([] as string[]).concat(dirs)) out.push({ prefix, dir: normalize(`${base}/${dir}`) }); };
 const project = await json('composer.json'); add(project?.autoload?.['psr-4'], ''); add(project?.['autoload-dev']?.['psr-4'], '');
 const installed = await json('vendor/composer/installed.json');
 for (const p of (Array.isArray(installed) ? installed : installed?.packages ?? []) as any[]) add(p.autoload?.['psr-4'], normalize(`vendor/composer/${p['install-path'] ?? `../${p.name}`}`));
 return out.sort((a, b) => b.prefix.length - a.prefix.length);
}
/** Arquivo de uma classe pelo PSR-4 (o primeiro prefixo mais longo cujo arquivo existe). */
export async function classFile(fqcn: string, map: { prefix: string; dir: string }[], files: ProjectFiles): Promise<string | null> {
 for (const { prefix, dir } of map) {
  if (!fqcn.startsWith(prefix)) continue;
  const path = normalize(`${dir}/${fqcn.slice(prefix.length).replace(/\\/g, '/')}.php`);
  if (await files.exists(path)) return path;
 }
 return null;
}
/** Diretório de templates do bundle: `Resources/views` (estrutura antiga) ou `templates/` na raiz do pacote. */
export async function bundleTemplates(classPath: string, files: ProjectFiles): Promise<{ dir: string; templates: string[] } | null> {
 const dir = classPath.split('/').slice(0, -1).join('/');
 for (const candidate of [`${dir}/Resources/views`, normalize(`${dir}/../templates`), `${dir}/templates`]) {
  const templates = await listIn(files, candidate, n => n.endsWith('.twig'));
  if (templates.length) return { dir: candidate, templates: templates.map(t => t.slice(candidate.length + 1)).sort() };
 }
 return null;
}
