import { phpTokens, position, type PhpToken } from '../php-source';
import { callArguments, xmlTags, type Route } from './symfony-config';
import type { ProjectFiles } from './api';
import { listIn } from './list';

// Carregamento de rotas como o Routing do Symfony (symfony.com/doc/current/routing.html):
// coleções do RoutingConfigurator (`$routes->collection('blog_')->prefix('/blog')`), imports com
// `prefix`/`name_prefix` em YAML, XML e PHP, e o gerador compilado
// (`var/cache/<env>/url_generating_routes.php`). Implementação própria a partir da documentação.

/** Import de recurso: caminho relativo ao arquivo que importa, diretório, glob ou `@Bundle/…`. */
export type RouteImport = { resource: string; type?: string; prefix: string; namePrefix: string; trailingSlashOnRoot: boolean; file: string; line: number; character: number };
export type RoutingFile = { routes: Route[]; imports: RouteImport[] };

/** Prefixo como `RouteCollection::addPrefix()`: `'/' . trim($prefix, '/') . $path`. */
export function prefixPath(prefix: string, path: string, trailingSlashOnRoot = true) {
 const p = prefix.trim().replace(/^\/+|\/+$/g, ''); if (!p) return path;
 if (path === '/' && !trailingSlashOnRoot) return '/' + p;
 return '/' + p + path;
}

type Scope = { name: string; prefixes: string[]; parent?: Scope };
const scopeName = (s: Scope | undefined): string => s ? scopeName(s.parent) + s.name : '';
const scopePath = (s: Scope | undefined, path: string): string => s ? scopePath(s.parent, s.prefixes.reduceRight((acc, p) => prefixPath(p, acc), path)) : path;
const firstString = (arg: PhpToken[] | undefined) => arg?.find(t => t.type === 'string');

/** Rotas e imports de um arquivo PHP do RoutingConfigurator (coleções em variáveis ou encadeadas). */
export function parsePhpRouting(text: string, file: string): RoutingFile {
 const tokens = phpTokens(text); const routes: { route: Route; scope?: Scope; raw: string }[] = []; const imports: (RouteImport & { scope?: Scope })[] = [];
 const vars = new Map<string, Scope | undefined>();
 // Instruções separadas por `;` (o arquivo é um closure `return function (...) { ... };`).
 let start = 0;
 for (let i = 0; i <= tokens.length; i++) {
  if (i < tokens.length && tokens[i].value !== ';' && tokens[i].value !== '{' && tokens[i].value !== '}') continue;
  let statement = tokens.slice(start, i); start = i + 1;
  if (statement[0]?.value === '<' && statement[1]?.value === '?' && statement[2]?.value.toLowerCase() === 'php') statement = statement.slice(3);
  let k = 0; let assign: string | undefined;
  if (statement[0]?.value === '$' && statement[1]?.type === 'word' && statement[2]?.value === '=' && statement[3]?.value !== '=') { assign = statement[1].value; k = 3; }
  if (statement[k]?.value !== '$' || statement[k + 1]?.type !== 'word') continue;
  const base = statement[k + 1].value;
  let scope = vars.get(base); let current: 'scope' | 'route' | 'import' = 'scope';
  let lastRoute: (typeof routes)[number] | undefined; let lastImport: (typeof imports)[number] | undefined;
  let touched = false;
  for (let j = k + 2; j < statement.length; j++) {
   if (statement[j].value !== '->' || statement[j + 1]?.type !== 'word' || statement[j + 2]?.value !== '(') continue;
   const method = statement[j + 1].value; const { args, close } = callArguments(statement, j + 2); j = close;
   if (method === 'collection') { scope = { name: firstString(args[0])?.value ?? '', prefixes: [], parent: scope }; current = 'scope'; touched = true; }
   else if (method === 'add' && args[0]?.length === 1 && args[0][0].type === 'string') {
    const name = args[0][0]; const path = firstString(args[1]);
    lastRoute = { route: { name: name.value, path: path?.value ?? '', methods: 'ANY', file, ...position(text, name.offset + 1), length: name.value.length }, scope, raw: name.value };
    routes.push(lastRoute); current = 'route';
   } else if (method === 'import') {
    const res = firstString(args[0]); if (!res) continue;
    lastImport = { resource: res.value, ...(firstString(args[1]) ? { type: firstString(args[1])!.value } : {}), prefix: '', namePrefix: '', trailingSlashOnRoot: true, file, ...position(text, res.offset + 1), scope };
    imports.push(lastImport); current = 'import';
   } else if (method === 'methods' && current === 'route' && lastRoute) {
    const list = args.flat().filter(t => t.type === 'string').map(t => t.value.toUpperCase()); if (list.length) lastRoute.route.methods = list.join('|');
   } else if (method === 'prefix') {
    // Prefixo localizado (`['en' => '/blog', …]`): o primeiro locale representa a rota.
    const value = args[0]?.find((t, n, arr) => t.type === 'string' && arr[n - 1]?.value === '=>') ?? firstString(args[0]);
    const trailing = !args.slice(1).flat().some(t => t.value.toLowerCase() === 'false');
    if (current === 'import' && lastImport) { lastImport.prefix = value?.value ?? ''; lastImport.trailingSlashOnRoot = trailing; }
    else if (current === 'scope' && scope && value) scope.prefixes.push(value.value);
   } else if (method === 'namePrefix' && current === 'import' && lastImport) lastImport.namePrefix = firstString(args[0])?.value ?? '';
  }
  if (assign && touched) vars.set(assign, scope);
 }
 return {
  routes: routes.map(({ route, scope }) => ({ ...route, name: scopeName(scope) + route.name, path: scopePath(scope, route.path) })),
  imports: imports.map(({ scope, ...imp }) => ({ ...imp, namePrefix: scopeName(scope) + imp.namePrefix, prefix: scope ? scopePath(scope, prefixPath(imp.prefix, '')) || imp.prefix : imp.prefix })),
 };
}

/** `<import resource type prefix name-prefix trailing-slash-on-root>` (com `<prefix locale>` filho). */
export function parseXmlImports(text: string, file: string): RouteImport[] {
 const tags = xmlTags(text); const out: RouteImport[] = [];
 tags.forEach((t, index) => {
  if (t.name !== 'import' || t.close || !t.attrs.resource) return;
  let prefix = t.attrs.prefix?.value ?? '';
  if (!prefix && !t.self) { const child = tags.slice(index + 1).find(c => c.name === 'prefix' && !c.close); if (child && tags.indexOf(child) < tags.findIndex((c, n) => n > index && c.name === 'import' && c.close)) prefix = text.slice(child.end, tags[tags.indexOf(child) + 1]?.offset).trim(); }
  out.push({ resource: t.attrs.resource.value, ...(t.attrs.type ? { type: t.attrs.type.value } : {}), prefix, namePrefix: t.attrs['name-prefix']?.value ?? '', trailingSlashOnRoot: t.attrs['trailing-slash-on-root']?.value !== 'false', file, ...position(text, t.attrs.resource.offset) });
 });
 return out;
}

/** Entradas com `resource:` (string ou `{path, namespace}`), `prefix`, `name_prefix`, inclusive em `when@env`. */
export function parseYamlImports(text: string, file: string): RouteImport[] {
 type L = { indent: number; key: string; value: string; line: number; character: number };
 const lines: L[] = [];
 text.split(/\r?\n/).forEach((raw, line) => {
  const m = /^(\s*)(['"]?)([^\s#'":][^:#]*?)\2\s*:(?:\s+(.*?))?\s*$/.exec(raw.replace(/\s+#.*$/, ''));
  if (!m || raw.trimStart().startsWith('#')) return;
  lines.push({ indent: m[1].length, key: m[3], value: (m[4] ?? '').replace(/^(['"])(.*)\1$/, '$2'), line, character: m[1].length });
 });
 const out: RouteImport[] = [];
 const scan = (from: L[], indent: number) => {
  for (let i = 0; i < from.length; i++) {
   const l = from[i]; if (l.indent !== indent) continue;
   const body: L[] = []; for (let k = i + 1; k < from.length && from[k].indent > indent; k++) body.push(from[k]);
   if (l.key.startsWith('when@')) { if (body.length) scan(body, body[0].indent); continue; }
   const level = body[0]?.indent; const direct = body.filter(b => b.indent === level);
   const resource = direct.find(b => b.key === 'resource'); if (!resource) continue;
   let path = resource.value; let at = resource;
   if (!path) { const sub = body.slice(body.indexOf(resource) + 1).filter(b => b.indent > resource.indent); const p = sub.find(b => b.key === 'path'); if (p) { path = p.value; at = p; } }
   if (!path) continue;
   const value = (key: string) => direct.find(b => b.key === key)?.value;
   let prefix = value('prefix') ?? '';
   if (!prefix && direct.some(b => b.key === 'prefix')) { const p = direct.find(b => b.key === 'prefix')!; prefix = body.find(b => b.indent > p.indent && body.indexOf(b) > body.indexOf(p))?.value ?? ''; }
   const raw = text.split(/\r?\n/)[at.line]; const character = Math.max(0, raw.indexOf(path, raw.indexOf(':') + 1));
   out.push({ resource: path, ...(value('type') ? { type: value('type') } : {}), prefix, namePrefix: value('name_prefix') ?? '', trailingSlashOnRoot: value('trailing_slash_on_root') !== 'false', file, line: at.line, character });
  }
 };
 scan(lines, 0);
 return out;
}

// ── Rotas compiladas ────────────────────────────────────────────────────────────────────────────
type PhpValue = string | number | boolean | null | PhpValue[] | { [k: string]: PhpValue };
/** Literal de array PHP (`[...]`/`array(...)`) com strings, números, booleanos e null. */
function phpValue(tokens: PhpToken[], i: number): { value: PhpValue; next: number } {
 const t = tokens[i]; if (!t) return { value: null, next: i };
 if (t.type === 'string') return { value: t.value, next: i + 1 };
 if (t.type === 'number') return { value: Number(t.value.replace(/_/g, '')), next: i + 1 };
 if (t.value === '-' && tokens[i + 1]?.type === 'number') return { value: -Number(tokens[i + 1].value), next: i + 2 };
 const open = t.value === '[' ? i : t.value.toLowerCase() === 'array' && tokens[i + 1]?.value === '(' ? i + 1 : -1;
 if (open >= 0) {
  const close = tokens[open].value === '[' ? ']' : ')'; const list: PhpValue[] = []; const map: Record<string, PhpValue> = {}; let assoc = false; let j = open + 1;
  while (j < tokens.length && tokens[j].value !== close) {
   const first = phpValue(tokens, j);
   if (tokens[first.next]?.value === '=>') { const v = phpValue(tokens, first.next + 1); map[String(first.value)] = v.value; assoc = true; j = v.next; } else { list.push(first.value); map[String(list.length - 1)] = first.value; j = first.next; }
   if (tokens[j]?.value === ',') j++; else if (tokens[j]?.value !== close) { j++; }
  }
  return { value: assoc ? map : list, next: j + 1 };
 }
 const word = t.value.toLowerCase();
 return { value: word === 'true' ? true : word === 'false' ? false : null, next: i + 1 };
}
export type CompiledRoute = Route & { controller?: string; compiled: true };
/** `return ['nome' => [variáveis, defaults, requisitos, tokens, hostTokens, schemes, …], …]`. */
export function parseCompiledRoutes(text: string, file: string): CompiledRoute[] {
 const tokens = phpTokens(text); const ret = tokens.findIndex(t => t.value === 'return'); if (ret < 0) return [];
 const open = ret + 1; if (tokens[open]?.value !== '[' && tokens[open]?.value.toLowerCase() !== 'array') return [];
 const out: CompiledRoute[] = []; let j = tokens[open].value === '[' ? open + 1 : open + 2;
 while (j < tokens.length && tokens[j].value !== ']' && tokens[j].value !== ')') {
  const key = tokens[j]; if (key.type !== 'string' || tokens[j + 1]?.value !== '=>') break;
  const { value, next } = phpValue(tokens, j + 2); j = tokens[next]?.value === ',' ? next + 1 : next;
  if (!Array.isArray(value)) continue;
  const defaults = (value[1] && typeof value[1] === 'object' && !Array.isArray(value[1]) ? value[1] : {}) as Record<string, PhpValue>;
  // Tokens do gerador vêm do fim para o começo: ['text', '/x'] ou ['variable', prefixo, regex, nome, importante].
  const parts = Array.isArray(value[3]) ? (value[3] as PhpValue[][]).slice().reverse() : [];
  const path = parts.map(p => p[0] === 'text' ? String(p[1]) : p[0] === 'variable' ? `${p[1]}{${p[3]}}` : '').join('') || '/';
  const controller = typeof defaults._controller === 'string' ? defaults._controller : undefined;
  out.push({ name: key.value, path, methods: '', file, ...position(text, key.offset + 1), length: key.value.length, ...(controller ? { controller } : {}), compiled: true });
 }
 return out;
}
/** Gerador compilado `var/cache/<env>/url_generating_routes.php`, preferindo o ambiente dev. */
export async function compiledRoutesFile(files: ProjectFiles): Promise<string | null> {
 const list = (await listIn(files, 'var/cache', n => n === 'url_generating_routes.php')).filter(p => /^var\/cache\/[^/]+\/url_generating_routes\.php$/.test(p));
 return list.sort((a, b) => Number(!a.includes('/dev/')) - Number(!b.includes('/dev/')) || a.localeCompare(b))[0] ?? null;
}
