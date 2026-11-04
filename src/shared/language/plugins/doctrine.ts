import { analyze, codeOnly, namespaceAt, phpTokens, position, segments, type Literal, type PhpToken } from '../php-source';
import { callSite } from './host';
import { literalIn, prepared } from './prepared';

// Doctrine ORM (doctrine-project.org/projects/orm): mapeamento por atributos `#[ORM\...]` ou
// anotações `@ORM\...`, repositórios, chaves de findBy/findOneBy/count, aliases de QueryBuilder e
// DQL. Formulários: `->add()` com campos do `data_class` e opções conhecidas dos tipos do Symfony.

export type EntityField = { name: string; kind: 'field' | 'association' | 'embedded'; type?: string; target?: string; offset: number; line: number; character: number };
export type Entity = { fqcn: string; name: string; file: string; repository?: string; fields: EntityField[]; line: number; character: number };

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

/** Entidade declarada no arquivo (atributo `Entity` ou anotação `@ORM\Entity`), ou null. */
export function parseEntity(text: string, file: string): Entity | null {
 if (!/\bEntity\b/.test(text)) return null;
 const tokens = phpTokens(text); const resolve = resolver(text);
 const comments = segments(text).filter(s => s.kind === 'comment');
 const docBefore = (offset: number, after: number) => comments.filter(c => c.end <= offset && c.start >= after).map(c => text.slice(c.start, c.end)).join('\n');
 type Attr = { name: string; args: PhpToken[][] };
 let pending: Attr[] = []; let entity: Entity | null = null; let depth = 0; let classDepth = -1; let boundary = 0; let awaitBody = false;
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
  if (v === 'class' && tokens[i - 1]?.value !== '::' && tokens[i + 1]?.type === 'word' && !entity) {
   const doc = docBefore(t.offset, 0);
   const attr = pending.find(a => a.name === 'Entity');
   const annotation = /@(?:ORM\\)?Entity\b(?:\(([^)]*)\))?/.exec(doc);
   pending = [];
   if (!attr && !annotation) return null;
   const declaration = analyze(text).declarations.find(d => d.offset === tokens[i + 1].offset);
   let repository: string | undefined;
   const repoArg = attr?.args.find(a => a[0]?.value === 'repositoryClass' && a[1]?.value === ':');
   if (repoArg) repository = classConst(repoArg.slice(2));
   else if (annotation?.[1]) { const r = /repositoryClass\s*=\s*"([^"]+)"/.exec(annotation[1])?.[1]; repository = r?.includes('\\') ? '\\' + r.replace(/^\\/, '') : r; }
   awaitBody = true;
   entity = { fqcn: declaration?.fqn ?? tokens[i + 1].value, name: tokens[i + 1].value, file, ...(repository ? { repository: resolve(repository, t.offset) } : {}), fields: [], ...position(text, tokens[i + 1].offset) };
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
    const annotated = /targetEntity\s*=\s*"([^"]+)"/.exec(annotations.find(a => a[1] === assoc)?.[2] ?? '')?.[1];
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

export type Model = { entities: Entity[]; repositories: Map<string, string> };
export const entityByName = (model: Model, name: string) => { const n = name.replace(/^\\/, '').toLowerCase(); return model.entities.find(e => e.fqcn.toLowerCase() === n) ?? model.entities.find(e => e.name.toLowerCase() === n || `${e.fqcn.split('\\')[0]}:${e.name}`.toLowerCase() === n); };
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
  const dotted = wordAt(/(\w+)\.(\w*)$/);
  if (dotted) { const entity = aliases.get(dotted.left[1]); return entity ? { kind: 'alias-field', entity, alias: dotted.left[1], from: dotted.from, to: dotted.to, word: dotted.left[2] + text.slice(offset, dotted.to), literal } : null; }
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
