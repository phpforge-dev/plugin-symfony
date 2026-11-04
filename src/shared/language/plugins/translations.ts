import { phpTokens, position } from '../php-source';
import type { ProjectFiles } from './api';
import { callSite } from './host';
import { literalIn, prepared } from './prepared';
import { xmlTags, xmlText } from './symfony-config';

// Traduções do Symfony (symfony.com/doc/current/translation.html): catálogos
// `translations/<domínio>[+intl-icu].<locale>.(yaml|xlf|php|json)`, `->trans()`, `t()`,
// `new TranslatableMessage()`, o filtro Twig `|trans` e `trans_default_domain`.

export type Message = { key: string; domain: string; locale: string; value: string; file: string; line: number; character: number; length: number };
const FILE = /^(.+?)(\+intl-icu)?\.([A-Za-z]{2,3}(?:[_-][A-Za-z0-9]+)*)\.(ya?ml|xlf|xliff|php|json)$/;

/** Achata YAML de bloco aninhado em chaves com ponto (como o YamlFileLoader). */
export function yamlMessages(text: string) {
 const out: { key: string; value: string; line: number; character: number; length: number }[] = []; const stack: { indent: number; key: string }[] = [];
 text.split(/\r?\n/).forEach((raw, line) => {
  if (/^\s*(#|$|-)/.test(raw)) return;
  const m = /^(\s*)(?:'((?:[^']|'')*)'|"((?:[^"\\]|\\.)*)"|([^\s#'"][^:#]*?))\s*:(?:\s+(.*?))?\s*$/.exec(raw.replace(/\s+#.*$/, ''));
  if (!m) return;
  const indent = m[1].length; const key = (m[2]?.replace(/''/g, "'")) ?? m[3] ?? m[4];
  while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
  const value = (m[5] ?? '').replace(/^(['"])(.*)\1$/, '$2');
  if (value && value !== '|' && value !== '>') out.push({ key: [...stack.map(s => s.key), key].join('.'), value, line, character: indent + (m[4] === undefined ? 1 : 0), length: key.length });
  else stack.push({ indent, key });
 });
 return out;
}
/** `<trans-unit resname|id>` (XLIFF 1.2) e `<unit name|id>` (XLIFF 2): chave = resname/name, senão `<source>`. */
export function xliffMessages(text: string) {
 const tags = xmlTags(text); const out: { key: string; value: string; line: number; character: number; length: number }[] = [];
 tags.forEach((t, i) => {
  if (t.close || (t.name !== 'trans-unit' && t.name !== 'unit')) return;
  let source = ''; let target = ''; let sourceAt = -1;
  for (let j = i + 1; j < tags.length && !(tags[j].close && tags[j].name === t.name); j++) {
   if (tags[j].name === 'source' && !tags[j].close) { source = xmlText(text, tags, j); sourceAt = tags[j].end; }
   if (tags[j].name === 'target' && !tags[j].close) target = xmlText(text, tags, j);
  }
  const attr = t.attrs.resname ?? t.attrs.name;
  const key = attr?.value ?? (source || t.attrs.id?.value); if (!key) return;
  const at = attr ? attr.offset : sourceAt >= 0 ? sourceAt + (text.slice(sourceAt).length - text.slice(sourceAt).trimStart().length) : t.attrs.id!.offset;
  out.push({ key, value: target || source, ...position(text, at), length: key.length });
 });
 return out;
}
/** `return ['a' => ['b' => 'x']]` de catálogos PHP. */
export function phpMessages(text: string) {
 const tokens = phpTokens(text); const out: { key: string; value: string; line: number; character: number; length: number }[] = [];
 const array = (open: number, path: string[]): number => {
  let j = open + 1;
  while (j < tokens.length && tokens[j].value !== ']') {
   const t = tokens[j];
   if (t.type === 'string' && tokens[j + 1]?.value === '=>') {
    const next = tokens[j + 2];
    if (next?.value === '[') { j = array(j + 2, [...path, t.value]) + 1; continue; }
    if (next?.type === 'string') out.push({ key: [...path, t.value].join('.'), value: next.value, ...position(text, t.offset + 1), length: t.value.length });
   }
   // Pula até a próxima vírgula de nível zero.
   let depth = 0;
   for (; j < tokens.length; j++) { const v = tokens[j].value; if (v === '[' || v === '(') depth++; else if (v === ']' || v === ')') { if (depth === 0) break; depth--; } else if (v === ',' && depth === 0) { j++; break; } }
  }
  return j;
 };
 const start = tokens.findIndex((t, i) => t.value === 'return' && tokens[i + 1]?.value === '[');
 if (start >= 0) array(start + 1, []);
 return out;
}
export function jsonMessages(text: string) {
 const out: { key: string; value: string; line: number; character: number; length: number }[] = [];
 let data: unknown; try { data = JSON.parse(text); } catch { return out; }
 const walk = (v: unknown, path: string[]) => {
  if (v && typeof v === 'object') { for (const [k, c] of Object.entries(v)) walk(c, [...path, k]); return; }
  const key = path.join('.'); const at = text.indexOf(JSON.stringify(path.at(-1)));
  out.push({ key, value: String(v), ...position(text, Math.max(0, at + 1)), length: path.at(-1)!.length });
 };
 walk(data, []); return out;
}

export type Catalog = { messages: Message[]; domains: Set<string>; defaultLocale: string };
export async function loadCatalog(files: ProjectFiles): Promise<Catalog> {
 const messages: Message[] = []; const domains = new Set<string>();
 for (const file of await files.list('translations', n => FILE.test(n))) {
  const m = FILE.exec(file.split('/').pop()!)!; const text = (await files.read(file)) ?? '';
  const [domain, locale, ext] = [m[1], m[3], m[4]]; domains.add(domain);
  const list = /ya?ml/.test(ext) ? yamlMessages(text) : /xl/.test(ext) ? xliffMessages(text) : ext === 'php' ? phpMessages(text) : jsonMessages(text);
  for (const e of list) messages.push({ ...e, domain, locale, file });
 }
 // default_locale de config/packages/translation.yaml ou framework.yaml; senão o primeiro catálogo.
 let defaultLocale = '';
 for (const path of ['config/packages/translation.yaml', 'config/packages/framework.yaml']) {
  const found = /^\s+default_locale:\s*['"]?([\w-]+)/m.exec((await files.read(path)) ?? ''); if (found && !found[1].startsWith('%')) { defaultLocale = found[1]; break; }
 }
 return { messages, domains, defaultLocale: defaultLocale || (messages.some(m => m.locale === 'en') ? 'en' : messages[0]?.locale ?? 'en') };
}

/** Argumentos de nível zero depois do primeiro; limites achados em `code` (strings apagadas), texto de `raw`. */
function laterArguments(raw: string, code: string): string[] {
 const args = ['']; let depth = 0;
 for (let i = 0; i < code.length; i++) {
  const c = code[i];
  if ('([{'.includes(c)) depth++;
  else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
  else if (c === ',' && depth === 0) { args.push(''); continue; }
  else if (c === ';' && depth === 0) break;
  args[args.length - 1] += raw[i];
 }
 return args.slice(1).map(a => a.trim());
}
const stringValue = (arg?: string) => /^(['"])([\w.+-]+)\1$/.exec(arg ?? '')?.[2];

export type TransSite = { from: number; to: number; key: string; domain: string; closed: boolean };
/** String de chave de tradução em PHP: `->trans('k', [], 'domínio')`, `t('k')`, `new TranslatableMessage('k')`. */
export function phpTransSite(text: string, offset: number): TransSite | null {
 const literal = literalIn(text, offset); if (!literal || literal.quote === '<<<') return null;
 const code = prepared(text).code.slice(0, literal.start); const call = callSite(code, literal.start);
 if (!call || call.argument !== 0 || !['->trans', 't', 'TranslatableMessage'].includes(call.callee)) return null;
 if (call.callee === 't' && /\bfunction\s+$/.test(code.slice(-40, -1))) return null;
 const rest = text.slice(literal.end, literal.end + 2000); const later = laterArguments(rest, prepared(text).code.slice(literal.end, literal.end + 2000));
 return { from: literal.start + 1, to: literal.closed ? literal.end - 1 : offset, key: literal.value, domain: stringValue(later[1]) ?? 'messages', closed: !!literal.closed };
}
/** `'chave'|trans` e `'chave'|trans({}, 'domínio')` no Twig; `{% trans_default_domain %}` muda o padrão. */
export function twigTransSites(text: string): TransSite[] {
 const fallback = /\{%-?\s*trans_default_domain\s+['"]([\w.+-]+)['"]/.exec(text)?.[1] ?? 'messages'; const out: TransSite[] = [];
 for (const m of text.matchAll(/(['"])([^'"\n]*)\1\s*\|\s*trans\b(\s*\(\s*(?:\{[^}]*\}|\[[^\]]*\]|[\w.]+)?\s*(?:,\s*(['"])([\w.+-]+)\4)?)?/g)) {
  const from = m.index! + 1; out.push({ from, to: from + m[2].length, key: m[2], domain: m[5] ?? fallback, closed: true });
 }
 return out;
}
/** Sítio Twig sob o cursor, inclusive com a chave ainda incompleta (`'adm|'|trans`). */
export function twigTransSite(text: string, offset: number): TransSite | null {
 const found = twigTransSites(text).find(s => offset >= s.from && offset <= s.to); if (found) return found;
 const line = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset); const m = /(['"])([\w.\-]*)$/.exec(line);
 const rest = text.slice(offset, offset + 200);
 if (!m || !new RegExp(`^[\\w.\\-]*${m[1]}\\s*\\|\\s*trans\\b`).test(rest)) return null;
 const tail = /^[\w.\-]*/.exec(rest)![0];
 return { from: offset - m[2].length, to: offset + tail.length, key: m[2] + tail, domain: /\{%-?\s*trans_default_domain\s+['"]([\w.+-]+)['"]/.exec(text)?.[1] ?? 'messages', closed: true };
}
/** Todos os sítios de PHP com chave literal (para diagnóstico de chaves ausentes). */
export function phpTransSites(text: string): TransSite[] {
 const out: TransSite[] = [];
 // Filtro barato antes do contexto completo (que reanalisa o texto anterior): arquivos grandes ficam rápidos.
 for (const s of prepared(text).segments) if (s.kind === 'string' && (s.quote === "'" || s.quote === '"') && /(?:trans|\bt|TranslatableMessage)\s*\(\s*$/.test(text.slice(Math.max(0, s.start - 40), s.start))) { const site = phpTransSite(text, s.start + 1); if (site && site.closed && site.key && !/[{$]/.test(site.key)) out.push(site); }
 return out;
}
