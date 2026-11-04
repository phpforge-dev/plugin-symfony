import { analyze, codeOnly, namespaceAt, phpTokens, position, segments, type Literal, type PhpToken } from '../php-source';
import { callSite } from './host';
import { literalIn, prepared } from './prepared';
import { xmlTags } from './symfony-config';

// Doctrine ORM (doctrine-project.org/projects/orm): mapeamento por atributos `#[ORM\...]` ou
// anotações `@ORM\...`, repositórios, chaves de findBy/findOneBy/count, aliases de QueryBuilder e
// DQL. Formulários: `->add()` com campos do `data_class` e opções conhecidas dos tipos do Symfony.

export type EntityField = { name: string; kind: 'field' | 'association' | 'embedded'; type?: string; target?: string; offset: number; line: number; character: number; file?: string; owner?: string };
export type Entity = { fqcn: string; name: string; file: string; repository?: string; fields: EntityField[]; line: number; character: number };
/** Classe com mapeamento (ou candidata a herdar um): entidade, superclasse mapeada, embeddable, trait. */
export type MappedClass = Entity & { kind: 'entity' | 'superclass' | 'embeddable' | 'trait' | 'class'; parent?: string; traits: string[]; source: 'php' | 'xml' };

/** Resolve um nome de classe como o PHP: imports, namespace atual, nome totalmente qualificado. */
export function resolver(text: string) {
 const context = prepared(text).context;
 return (name: string, offset = text.length) => {
  if (!name) return name;
  if (name.startsWith('\\')) return name.slice(1);
  const [head, ...rest] = name.split('\\');
  const imported = context.imports.find(i => i.alias.toLowerCase() === head.toLowerCase());
  if (imported) return [imported.fqn, ...rest].join('\\');
  const ns = namespaceAt(context, offset); return ns ? `${ns}\\${name}` : name;
 };
}
/** Texto com comentários trocados por espaços, strings intactas (offsets preservados). */
export const withoutComments = (text: string) => prepared(text).plain;
const MAPPING = /^(Column|Id|Embedded|ManyToOne|OneToMany|ManyToMany|OneToOne)$/;
const classConst = (arg: PhpToken[]) => { const i = arg.findIndex((t, n) => t.value === '::' && arg[n + 1]?.value === 'class'); return i > 0 ? arg.slice(0, i).map(t => t.value).join('') : arg.length === 1 && arg[0].type === 'string' ? '\\' + arg[0].value.replace(/^\\/, '') : undefined; };
const qualifiedName = (tokens: PhpToken[], i: number) => { let name = ''; let j = i; while (tokens[j] && (tokens[j].type === 'word' || tokens[j].value === '\\')) name += tokens[j++].value; return { name, next: j }; };

/** Entidade declarada no arquivo (atributo `Entity` ou anotação `@ORM\Entity`), ou null. */
export function parseEntity(text: string, file: string): Entity | null {
 const mapped = parseMapped(text, file); if (mapped?.kind !== 'entity') return null;
 const { kind, parent, traits, source, ...entity } = mapped; void kind; void parent; void traits; void source; return entity;
}
/**
 * Primeira classe ou trait do arquivo com campos mapeados por atributos `#[ORM\...]` ou anotações
 * `@ORM\...`: `Entity`, `MappedSuperclass`, `Embeddable`; classes comuns e traits também voltam
 * (com `extends` e `use`) porque uma entidade pode herdar delas.
 */
export function parseMapped(text: string, file: string): MappedClass | null {
 const tokens = phpTokens(text); const resolve = resolver(text);
 const comments = segments(text).filter(s => s.kind === 'comment');
 const docBefore = (offset: number, after: number) => comments.filter(c => c.end <= offset && c.start >= after).map(c => text.slice(c.start, c.end)).join('\n');
 type Attr = { name: string; args: PhpToken[][] };
 let pending: Attr[] = []; let entity: MappedClass | null = null; let depth = 0; let classDepth = -1; let boundary = 0; let awaitBody = false;
 for (let i = 0; i < tokens.length; i++) {
  const t = tokens[i]; const v = t.value;
  if (v === '#' && tokens[i + 1]?.value === '[') {
   // Atributos `#[A(...), B]`: nome sem namespace e argumentos de nível zero.
   let j = i + 2;
   while (j < tokens.length && tokens[j].value !== ']') {
    let name = ''; while (tokens[j] && (tokens[j].type === 'word' || tokens[j].value === '\\')) name += tokens[j++].value;
    let args: PhpToken[][] = [];
    if (tokens[j]?.value === '(') { const call = argumentsAt(tokens, j); args = call.args; j = call.close + 1; }
    if (name) pending.push({ name: name.split('\\').pop()!, args });
    if (tokens[j]?.value === ',') j++; else if (tokens[j]?.value !== ']') break;
   }
   i = j; continue;
  }
  if (v === '{' || v === '}' || v === ';' || v === 'function') {
   if (v === '{') { depth++; if (awaitBody) { classDepth = depth; awaitBody = false; } }
   else if (v === '}') { if (depth === classDepth) break; depth--; }
   pending = []; boundary = t.offset + 1; continue;
  }
  if ((v === 'class' || v === 'trait') && tokens[i - 1]?.value !== '::' && tokens[i - 1]?.value !== 'new' && tokens[i + 1]?.type === 'word' && !entity) {
   const doc = docBefore(t.offset, 0);
   const has = (name: string) => pending.find(a => a.name === name) ?? (new RegExp(`@(?:ORM\\\\)?${name}\\b`).test(doc) ? { name, args: [] } : undefined);
   const attr = pending.find(a => a.name === 'Entity');
   const annotation = /@(?:ORM\\)?Entity\b(?:\(([^)]*)\))?/.exec(doc);
   const kind: MappedClass['kind'] = v === 'trait' ? 'trait' : attr || annotation ? 'entity' : has('MappedSuperclass') ? 'superclass' : has('Embeddable') ? 'embeddable' : 'class';
   pending = [];
   const declaration = analyze(text).declarations.find(d => d.offset === tokens[i + 1].offset);
   let repository: string | undefined;
   const repoArg = attr?.args.find(a => a[0]?.value === 'repositoryClass' && a[1]?.value === ':');
   if (repoArg) repository = classConst(repoArg.slice(2));
   else if (annotation?.[1]) { const r = /repositoryClass\s*=\s*"([^"]+)"/.exec(annotation[1])?.[1]; repository = r?.includes('\\') ? '\\' + r.replace(/^\\/, '') : r; }
   let parent: string | undefined;
   if (tokens[i + 2]?.value === 'extends') { const q = qualifiedName(tokens, i + 3); if (q.name) parent = resolve(q.name, t.offset); }
   awaitBody = true;
   entity = { kind, traits: [], source: 'php', ...(parent ? { parent } : {}), fqcn: declaration?.fqn ?? tokens[i + 1].value, name: tokens[i + 1].value, file, ...(repository ? { repository: resolve(repository, t.offset) } : {}), fields: [], ...position(text, tokens[i + 1].offset) };
   continue;
  }
  // `use Trait1, Trait2;` no corpo da classe.
  if (entity && depth === classDepth && v === 'use') {
   let j = i + 1;
   while (j < tokens.length) { const q = qualifiedName(tokens, j); if (q.name) entity.traits.push(resolve(q.name, t.offset)); j = q.next; if (tokens[j]?.value === ',') j++; else break; }
   continue;
  }
  // Propriedade mapeada: `$nome` na profundidade da classe, fora de métodos.
  if (entity && depth === classDepth && v === '$' && tokens[i + 1]?.type === 'word' && !tokens.slice(Math.max(0, i - 6), i).some(x => x.value === 'function' || x.value === '(')) {
   const nameToken = tokens[i + 1]; const doc = docBefore(t.offset, boundary);
   const attrs = pending.filter(a => MAPPING.test(a.name));
   const annotations = [...doc.matchAll(/@(?:ORM\\)?(Column|Id|Embedded|ManyToOne|OneToMany|ManyToMany|OneToOne)\b(?:\(([^)]*)\))?/g)];
   pending = [];
   if (!attrs.length && !annotations.length) continue;
   const kinds = [...attrs.map(a => a.name), ...annotations.map(a => a[1])];
   const assoc = kinds.find(k => /To(One|Many)$/.test(k)); const embedded = kinds.includes('Embedded');
   let target: string | undefined; let type: string | undefined;
   const typed = tokens.slice(Math.max(0, i - 4), i).filter(x => x.type === 'word' && !/^(private|protected|public|readonly|static|var)$/i.test(x.value)).map(x => x.value);
   if (assoc || embedded) {
    const attr = attrs.find(a => a.name === assoc || a.name === 'Embedded');
    const arg = attr?.args.find(a => /^(targetEntity|class)$/.test(a[0]?.value ?? '') && a[1]?.value === ':');
    const annotated = /(?:targetEntity|class)\s*=\s*"([^"]+)"/.exec(annotations.find(a => a[1] === (assoc ?? 'Embedded'))?.[2] ?? '')?.[1];
    const raw = arg ? classConst(arg.slice(2)) : annotated?.includes('\\') ? '\\' + annotated.replace(/^\\/, '') : annotated;
    const declared = typed.at(-1);
    target = raw ? resolve(raw, t.offset) : declared && !/^(Collection|array|iterable|ArrayCollection)$/.test(declared) ? resolve(declared, t.offset) : undefined;
   } else {
    const attr = attrs.find(a => a.name === 'Column');
    const arg = attr?.args.find(a => a[0]?.value === 'type' && a[1]?.value === ':');
    type = arg ? (arg[2]?.type === 'string' ? arg[2].value : arg.at(-1)?.value.toLowerCase()) : /type\s*=\s*"(\w+)"/.exec(annotations.find(a => a[1] === 'Column')?.[2] ?? '')?.[1] ?? typed.at(-1)?.toLowerCase();
   }
   entity.fields.push({ name: nameToken.value, kind: assoc ? 'association' : embedded ? 'embedded' : 'field', ...(type ? { type } : {}), ...(target ? { target } : {}), offset: nameToken.offset - 1, ...position(text, nameToken.offset - 1) });
  }
 }
 return entity;
}

/**
 * Mapeamento XML (`*.orm.xml`, doctrine-mapping): `<entity>`, `<mapped-superclass>` e `<embeddable>`
 * com `<id>`, `<field>`, `<embedded>` e associações; `target-entity` curto usa o namespace da entidade.
 */
export function parseXmlMapping(text: string, file: string): MappedClass[] {
 const out: MappedClass[] = []; let current: MappedClass | null = null; let depth = -1;
 const kinds: Record<string, MappedClass['kind']> = { entity: 'entity', 'mapped-superclass': 'superclass', embeddable: 'embeddable' };
 for (const tag of xmlTags(text)) {
  if (tag.close) { if (current && tag.depth === depth && kinds[tag.name]) current = null; continue; }
  if (kinds[tag.name] && tag.attrs.name) {
   const fqcn = tag.attrs.name.value.replace(/^\\/, ''); const repo = tag.attrs['repository-class']?.value.replace(/^\\/, '');
   current = { kind: kinds[tag.name], traits: [], source: 'xml', fqcn, name: fqcn.split('\\').pop()!, file, ...(repo ? { repository: repo } : {}), fields: [], ...position(text, tag.attrs.name.offset) };
   out.push(current); depth = tag.depth; if (tag.self) current = null; continue;
  }
  if (!current || tag.depth !== depth + 1) continue;
  const ns = current.fqcn.split('\\').slice(0, -1).join('\\');
  const qualify = (name?: string) => name ? (name.includes('\\') ? name.replace(/^\\/, '') : ns ? `${ns}\\${name}` : name) : undefined;
  const key = tag.name === 'id' || tag.name === 'field' || tag.name === 'embedded' ? tag.attrs.name : /^(one|many)-to-(one|many)$/.test(tag.name) ? tag.attrs.field : undefined;
  if (!key) continue;
  const at = position(text, key.offset);
  if (tag.name === 'id' || tag.name === 'field') current.fields.push({ name: key.value, kind: 'field', ...(tag.attrs.type ? { type: tag.attrs.type.value } : {}), offset: key.offset, ...at });
  else if (tag.name === 'embedded') current.fields.push({ name: key.value, kind: 'embedded', ...(qualify(tag.attrs.class?.value) ? { target: qualify(tag.attrs.class?.value) } : {}), offset: key.offset, ...at });
  else current.fields.push({ name: key.value, kind: 'association', ...(qualify(tag.attrs['target-entity']?.value) ? { target: qualify(tag.attrs['target-entity']?.value) } : {}), offset: key.offset, ...at });
 }
 return out;
}

/** Diretórios de mapeamento XML de config/packages/doctrine.yaml (`type: xml`, `dir:`), mais config/doctrine. */
export function xmlMappingDirs(yaml: string | null): string[] {
 const dirs = new Set<string>(['config/doctrine']); if (!yaml) return [...dirs];
 const lines = yaml.split(/\r?\n/);
 lines.forEach((line, n) => {
  if (!/^\s*type:\s*['"]?xml['"]?\s*$/.test(line)) return;
  const indent = /^\s*/.exec(line)![0].length;
  for (let k = n - 1; k >= 0 && /^\s*/.exec(lines[k])![0].length >= indent; k--) { const d = /^\s*dir:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(lines[k]); if (d && /^\s*/.exec(lines[k])![0].length === indent) dirs.add(d[1]); }
  for (let k = n + 1; k < lines.length && /^\s*/.exec(lines[k])![0].length >= indent; k++) { const d = /^\s*dir:\s*['"]?([^'"#]+?)['"]?\s*$/.exec(lines[k]); if (d && /^\s*/.exec(lines[k])![0].length === indent) dirs.add(d[1]); }
 });
 return [...dirs].map(d => d.replace(/^%kernel\.project_dir%\/?/, '').replace(/^\.\//, '').replace(/\/$/, ''));
}

/**
 * Campos efetivos de cada entidade: os próprios, os de traits e os herdados de superclasses
 * mapeadas e de entidades pai (herança de tabela única/joined). Classes pai comuns não mapeiam.
 * `lookup` resolve classes ainda não lidas (PSR-4); embeddables ficam no modelo para `a.emb.campo`.
 */
export async function buildModel(classes: MappedClass[], repositories: Map<string, string>, lookup: (fqcn: string) => Promise<MappedClass | null>): Promise<Model> {
 const byName = new Map<string, MappedClass>(); const key = (n: string) => n.replace(/^\\/, '').toLowerCase();
 // XML vence a classe PHP sem atributos com o mesmo nome; a PHP ainda informa `extends` e traits.
 for (const c of classes) { const prev = byName.get(key(c.fqcn)); if (!prev || (prev.kind === 'class' && c.kind !== 'class')) byName.set(key(c.fqcn), prev && c.source === 'xml' ? { ...c, parent: prev.parent, traits: prev.traits } : c); else if (c.source === 'php' && prev.source === 'xml') byName.set(key(c.fqcn), { ...prev, parent: c.parent, traits: c.traits }); }
 const find = async (fqcn: string) => { const k = key(fqcn); if (!byName.has(k)) { const c = await lookup(fqcn); if (c) byName.set(k, c); } return byName.get(k); };
 const own = (c: MappedClass) => c.fields.map(f => ({ ...f, file: f.file ?? c.file, owner: f.owner ?? c.name }));
 const resolved = new Map<string, EntityField[]>();
 const fieldsOf = async (c: MappedClass, stack: string[]): Promise<EntityField[]> => {
  const k = key(c.fqcn); const hit = resolved.get(k); if (hit) return hit; if (stack.includes(k)) return [];
  const list = own(c);
  for (const t of c.traits) { const trait = await find(t); if (trait) list.push(...await fieldsOf(trait, [...stack, k])); }
  const parent = c.parent ? await find(c.parent) : undefined;
  // Pai comum não mapeia campos, mas pode herdar de uma superclasse mapeada mais acima.
  if (parent) { const inherited = await fieldsOf(parent, [...stack, k]); list.push(...(parent.kind === 'class' ? inherited.filter(f => f.owner !== parent.name) : inherited)); }
  const seen = new Set<string>(); const out = list.filter(f => !seen.has(f.name) && seen.add(f.name));
  resolved.set(k, out); return out;
 };
 const entities: Entity[] = []; const embeddables: Entity[] = [];
 for (const c of [...byName.values()]) {
  if (c.kind !== 'entity' && c.kind !== 'embeddable') continue;
  const { kind, parent, traits, source, ...rest } = c; void parent; void traits; void source;
  (kind === 'entity' ? entities : embeddables).push({ ...rest, fields: await fieldsOf(c, []) });
 }
 return { entities, repositories, embeddables };
}
function argumentsAt(tokens: PhpToken[], open: number) {
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
/** Repositório → entidade por `parent::__construct($registry, X::class)`. */
export function repositoryEntity(text: string): { repository: string; entity: string } | null {
 const m = /parent::__construct\(\s*\$\w+\s*,\s*\\?([\w\\]+)::class/.exec(codeOnly(text)); if (!m) return null;
 const resolve = resolver(text); const declaration = analyze(text).declarations.filter(d => d.kind === 'class' && d.offset < m.index).at(-1);
 return declaration ? { repository: declaration.fqn, entity: resolve(m[1], m.index) } : null;
}

export type Model = { entities: Entity[]; repositories: Map<string, string>; embeddables?: Entity[] };
export const entityByName = (model: Model, name: string) => { const n = name.replace(/^\\/, '').toLowerCase(); return model.entities.find(e => e.fqcn.toLowerCase() === n) ?? model.entities.find(e => e.name.toLowerCase() === n || `${e.fqcn.split('\\')[0]}:${e.name}`.toLowerCase() === n); };
export const embeddableByName = (model: Model, name: string) => { const n = name.replace(/^\\/, '').toLowerCase(); return model.embeddables?.find(e => e.fqcn.toLowerCase() === n); };
const repositoryTarget = (model: Model, repo: string) => { const fqcn = model.repositories.get(repo.toLowerCase()) ?? model.entities.find(e => e.repository?.toLowerCase() === repo.toLowerCase())?.fqcn; return fqcn ? entityByName(model, fqcn) : undefined; };

/** Contexto Doctrine/Form de uma string PHP: quais nomes valem ali e qual trecho o cursor edita. */
export type DoctrineContext =
 | { kind: 'fields'; entity: Entity; from: number; to: number; word: string; literal: Literal; source: 'findBy' | 'form' }
 | { kind: 'alias-field'; entity: Entity; alias: string; from: number; to: number; word: string; literal: Literal }
 | { kind: 'aliases'; aliases: Map<string, Entity>; from: number; to: number; word: string; literal: Literal }
 | { kind: 'entity'; from: number; to: number; word: string; literal: Literal }
 | { kind: 'form-option'; type: string; from: number; to: number; word: string; literal: Literal };
const QB = new Set(['->select', '->addSelect', '->where', '->andWhere', '->orWhere', '->orderBy', '->addOrderBy', '->groupBy', '->addGroupBy', '->having', '->andHaving', '->orHaving', '->join', '->leftJoin', '->innerJoin', '->indexBy']);
const FIND = new Set(['->findBy', '->findOneBy', '->count']);

/** Tipo declarado do receptor (`$this`, `getRepository(X::class)`, `$repo` tipado) como entidade. */
function receiverEntity(model: Model, text: string, code: string, at: number): Entity | undefined {
 const before = code.slice(Math.max(0, at - 300), at);
 const resolve = resolver(text);
 const repo = /getRepository\(\s*\\?([\w\\]+)::class\s*\)\s*->\s*\w+\s*$/.exec(before); if (repo) return entityByName(model, resolve(repo[1], at));
 if (/\$this\s*->\s*\w+\s*$/.test(before)) { const cls = prepared(text).context.declarations.filter(d => d.offset < at).at(-1); return cls ? repositoryTarget(model, cls.fqn) : undefined; }
 const variable = /\$(\w+)\s*->\s*\w+\s*$/.exec(before) ?? /\$this->(\w+)\s*->\s*\w+\s*$/.exec(before);
 if (variable) { const typed = new RegExp(`([\\w\\\\]+)\\s+\\$${variable[1]}\\b`).exec(code); if (typed) { const fqcn = resolve(typed[1], typed.index); return repositoryTarget(model, fqcn) ?? entityByName(model, fqcn); } }
 return undefined;
}
/** Aliases do método: createQueryBuilder('p') no repositório, ->from(X::class,'p'), joins por associação. */
export function queryAliases(model: Model, text: string, offset: number): Map<string, Entity> {
 const code = prepared(text).code; const resolve = resolver(text);
 const start = Math.max(0, code.lastIndexOf('function', offset)); const next = code.indexOf('function', offset); const body = code.slice(start, next < 0 ? code.length : next);
 const raw = withoutComments(text).slice(start, next < 0 ? text.length : next);
 const aliases = new Map<string, Entity>();
 for (const m of raw.matchAll(/createQueryBuilder\(\s*['"](\w+)['"]/g)) { const e = receiverEntity(model, text, code, start + m.index! + 'createQueryBuilder'.length); if (e) aliases.set(m[1], e); }
 for (const m of raw.matchAll(/->from\(\s*(?:\\?([\w\\]+)::class|['"]([\w\\:]+)['"])\s*,\s*['"](\w+)['"]/g)) { const e = entityByName(model, m[1] ? resolve(m[1], start + m.index!) : m[2]); if (e) aliases.set(m[3], e); }
 for (const m of raw.matchAll(/->(?:left|inner)?[jJ]oin\(\s*\\?([\w\\]+)::class\s*,\s*['"](\w+)['"]/g)) { const e = entityByName(model, resolve(m[1], start + m.index!)); if (e) aliases.set(m[2], e); }
 // Joins dependem de aliases anteriores: repete até estabilizar.
 for (let round = 0; round < 3; round++) for (const m of raw.matchAll(/->(?:left|inner)?[jJ]oin\(\s*['"](\w+)\.(\w+)['"]\s*,\s*['"](\w+)['"]/g)) {
  const owner = aliases.get(m[1]); const target = owner?.fields.find(f => f.name === m[2])?.target; const e = target ? entityByName(model, target) : undefined; if (e) aliases.set(m[3], e);
 }
 void body; return aliases;
}
/** Aliases de uma DQL: `FROM Entidade alias` e `JOIN alias.associação alias2`. */
export function dqlAliases(model: Model, dql: string): Map<string, Entity> {
 const aliases = new Map<string, Entity>();
 for (const m of dql.matchAll(/\bFROM\s+([\w\\:]+)\s+(?:AS\s+)?(\w+)/gi)) { const e = entityByName(model, m[1]); if (e) aliases.set(m[2], e); }
 for (const m of dql.matchAll(/\bJOIN\s+([\w\\:]+)\s+(?:AS\s+)?(\w+)/gi)) { const e = entityByName(model, m[1]); if (e) aliases.set(m[2], e); }
 for (let round = 0; round < 3; round++) for (const m of dql.matchAll(/\bJOIN\s+(\w+)\.(\w+)\s+(?:AS\s+)?(\w+)/gi)) {
  const target = aliases.get(m[1])?.fields.find(f => f.name === m[2])?.target; const e = target ? entityByName(model, target) : undefined; if (e) aliases.set(m[3], e);
 }
 return aliases;
}
const keyPosition = (code: string, start: number) => { const prev = code.slice(0, start).trimEnd().at(-1); return prev === '[' || prev === ','; };
/** Abertura do array que contém `start` (nível zero) ou -1. */
function arrayOpen(code: string, start: number) {
 let depth = 0;
 for (let i = start - 1; i >= 0; i--) { const c = code[i]; if (c === ')' || c === ']' || c === '}') depth++; else if (c === '(' || c === '{') { if (depth === 0) return -1; depth--; } else if (c === '[') { if (depth === 0) return i; depth--; } else if (c === ';' && depth === 0) return -1; }
 return -1;
}
/** Contexto do cursor (offset) dentro de uma string PHP, ou null. */
export function doctrineContext(model: Model, text: string, offset: number, forms = true): DoctrineContext | null {
 const literal = literalIn(text, offset); if (!literal || literal.quote === '<<<') return null;
 const code = prepared(text).code.slice(0, literal.start); const inner = literal.start + 1; const end = literal.closed ? literal.end - 1 : offset;
 const value = text.slice(inner, end); const local = offset - inner;
 const wordAt = (re: RegExp) => { const left = re.exec(value.slice(0, local)); const right = /^\w*/.exec(value.slice(local))![0]; return left ? { from: offset - left[left.length - 1].length, to: offset + right.length, left } : null; };
 const call = callSite(code, literal.start);
 if (call && (QB.has(call.callee) || call.callee === '->createQuery')) {
  const aliases = call.callee === '->createQuery' ? dqlAliases(model, value) : queryAliases(model, text, offset);
  const dotted = wordAt(/(\w+)((?:\.\w+)*)\.(\w*)$/);
  if (dotted) {
   // `a.embutido.campo`: cada passo intermediário precisa ser um embedded.
   let entity = aliases.get(dotted.left[1]);
   for (const part of dotted.left[2].split('.').filter(Boolean)) { const f = entity?.fields.find(x => x.name === part && x.kind === 'embedded'); entity = f?.target ? embeddableByName(model, f.target) : undefined; }
   return entity ? { kind: 'alias-field', entity, alias: dotted.left[1], from: dotted.from, to: dotted.to, word: dotted.left[3] + text.slice(offset, dotted.to), literal } : null;
  }
  if (call.callee === '->createQuery') { const from = wordAt(/\b(?:FROM|JOIN)\s+([\w\\:]*)$/i); if (from) return { kind: 'entity', from: from.from, to: from.to, word: from.left[1], literal }; }
  const plain = wordAt(/(?:^|[\s(,=<>!])(\w*)$/);
  return plain && aliases.size ? { kind: 'aliases', aliases, from: plain.from, to: plain.to, word: plain.left[1], literal } : null;
 }
 const whole = (source: 'findBy' | 'form', entity?: Entity) => entity ? { kind: 'fields' as const, entity, from: inner, to: end, word: value, literal, source } : null;
 if (call?.callee === '->add' && call.argument === 0 && forms) return whole('form', formEntity(model, text));
 const open = arrayOpen(code, literal.start);
 if (open < 0 || !keyPosition(code, literal.start)) return null;
 const outer = callSite(code, open);
 if (outer && FIND.has(outer.callee) && (outer.argument === 0 || (outer.argument === 1 && outer.callee === '->findBy'))) {
  const paren = code.lastIndexOf('(', open); return whole('findBy', receiverEntity(model, text, code, paren));
 }
 if (forms && outer?.callee === '->add' && outer.argument === 2) {
  const args = withoutComments(text).slice(code.lastIndexOf('->add', open)); const type = /^->add\(\s*['"][^'"]*['"]\s*,\s*\\?([\w\\]+)::class/.exec(args)?.[1]?.split('\\').pop() ?? '';
  return { kind: 'form-option', type, from: inner, to: end, word: value, literal };
 }
 if (forms && outer?.callee === '->setDefaults' && outer.argument === 0) return { kind: 'form-option', type: 'resolver', from: inner, to: end, word: value, literal };
 return null;
}
/** Entidade do `data_class` do form type do arquivo. */
export function formEntity(model: Model, text: string): Entity | undefined {
 const m = /['"]data_class['"]\s*=>\s*\\?([\w\\]+)::class/.exec(withoutComments(text)); return m ? entityByName(model, resolver(text)(m[1], m.index)) : undefined;
}

// Opções documentadas dos tipos de formulário do Symfony (symfony.com/doc/current/reference/forms/types).
const BASE = ['attr', 'block_name', 'block_prefix', 'by_reference', 'compound', 'constraints', 'data', 'disabled', 'empty_data', 'error_bubbling', 'error_mapping', 'help', 'help_attr', 'help_html', 'help_translation_parameters', 'inherit_data', 'invalid_message', 'invalid_message_parameters', 'label', 'label_attr', 'label_format', 'label_html', 'label_translation_parameters', 'mapped', 'priority', 'property_path', 'required', 'row_attr', 'translation_domain', 'trim', 'validation_groups'];
const TYPES: Record<string, string[]> = {
 TextType: [], TextareaType: [], EmailType: [], PasswordType: ['always_empty', 'hash_property_path', 'toggle'], UrlType: ['default_protocol'], SearchType: [], TelType: [], ColorType: ['html5'],
 IntegerType: ['grouping', 'rounding_mode'], NumberType: ['grouping', 'html5', 'input', 'rounding_mode', 'scale'], MoneyType: ['currency', 'divisor', 'grouping', 'html5', 'input', 'rounding_mode', 'scale'], PercentType: ['html5', 'rounding_mode', 'scale', 'symbol', 'type'], RangeType: [],
 ChoiceType: ['choices', 'choice_attr', 'choice_filter', 'choice_label', 'choice_loader', 'choice_name', 'choice_translation_domain', 'choice_translation_parameters', 'choice_value', 'duplicate_preferred_choices', 'expanded', 'group_by', 'match', 'multiple', 'placeholder', 'placeholder_attr', 'preferred_choices', 'separator', 'separator_html'],
 EntityType: ['class', 'choice_label', 'choice_value', 'em', 'expanded', 'group_by', 'multiple', 'placeholder', 'preferred_choices', 'query_builder'],
 EnumType: ['class', 'choice_label', 'expanded', 'multiple', 'placeholder'], CountryType: ['alpha3', 'choice_translation_locale'], LanguageType: ['alpha3', 'choice_self_translation', 'choice_translation_locale'], LocaleType: ['choice_translation_locale'], TimezoneType: ['input', 'intl'], CurrencyType: ['choice_translation_locale'],
 DateType: ['calendar', 'days', 'format', 'html5', 'input', 'input_format', 'model_timezone', 'months', 'placeholder', 'view_timezone', 'widget', 'years'], DateTimeType: ['date_format', 'date_label', 'date_widget', 'format', 'html5', 'input', 'model_timezone', 'time_label', 'time_widget', 'view_timezone', 'widget', 'with_minutes', 'with_seconds'], TimeType: ['hours', 'input', 'minutes', 'model_timezone', 'reference_date', 'seconds', 'view_timezone', 'widget', 'with_minutes', 'with_seconds'], BirthdayType: ['format', 'widget', 'years'],
 CheckboxType: ['false_values', 'value'], RadioType: ['false_values', 'value'], FileType: ['multiple'], HiddenType: [], ButtonType: [], SubmitType: ['validate'], ResetType: [],
 CollectionType: ['allow_add', 'allow_delete', 'delete_empty', 'entry_options', 'entry_type', 'keep_as_list', 'prototype', 'prototype_data', 'prototype_name'], RepeatedType: ['first_name', 'first_options', 'options', 'second_name', 'second_options', 'type'],
};
const RESOLVER = ['data_class', 'csrf_protection', 'csrf_field_name', 'csrf_token_id', 'translation_domain', 'validation_groups', 'allow_extra_fields', 'empty_data', 'attr', 'label', 'required', 'inherit_data', 'error_mapping', 'method', 'action'];
export function formOptions(type: string): { name: string; own: boolean }[] {
 if (type === 'resolver') return RESOLVER.map(name => ({ name, own: true }));
 const own = TYPES[type] ?? []; return [...own.map(name => ({ name, own: true })), ...BASE.filter(b => !own.includes(b)).map(name => ({ name, own: false }))];
}
/** Valores de opções que recebem chave de tradução (label, help, placeholder…). */
export function formTranslationOption(text: string, offset: number): { domain?: string } | null {
 const literal = literalIn(text, offset); if (!literal) return null;
 const code = prepared(text).code.slice(0, literal.start);
 if (!/['"](label|help|placeholder|invalid_message|title)['"]\s*=>\s*$/.test(withoutComments(text).slice(Math.max(0, literal.start - 60), literal.start))) return null;
 const open = arrayOpen(code, literal.start); const outer = open >= 0 ? callSite(code, open) : null;
 if (!(outer?.callee === '->add' && outer.argument === 2)) return null;
 const domain = /['"]translation_domain['"]\s*=>\s*['"]([\w.+-]+)['"]/.exec(text)?.[1];
 return domain ? { domain } : {};
}

/** Distância de edição limitada para sugerir "você quis dizer". */
export function nearest(word: string, names: string[]) {
 let best: string | undefined; let score = Infinity;
 for (const name of names) {
  const a = word.toLowerCase(), b = name.toLowerCase(); const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  if (d[a.length][b.length] < score) { score = d[a.length][b.length]; best = name; }
 }
 return score <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}
