import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SymfonyPlugin } from '../src/shared/language/plugins/symfony';
import { PluginHost } from '../src/shared/language/plugins/host';
import type { ProjectFiles } from '../src/shared/language/plugins/api';

export const root = join(import.meta.dirname, './fixtures/projects/symfony');
export const read = (path: string) => readFileSync(join(root, path), 'utf8');
export function project(dir: string, extra: Record<string, string> = {}): ProjectFiles {
 const walk = (sub: string): string[] => existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)).flatMap(name => { const p = sub ? `${sub}/${name}` : name; return statSync(join(dir, p)).isDirectory() ? walk(p) : [p]; }) : [];
 return {
  root: dir,
  read: async path => extra[path] ?? (existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null),
  exists: async path => path in extra || existsSync(join(dir, path)),
  list: async (sub, accept) => [...new Set([...walk(sub), ...Object.keys(extra).filter(p => !sub || p.startsWith(sub + '/'))])].filter(p => accept(p.split('/').pop()!)),
  uri: path => `file://${dir}/${path}`,
 };
}
export const host = (extra: Record<string, string> = {}) => new PluginHost(project(root, extra), [new SymfonyPlugin()]);
export const at = (text: string, marker: string) => { const i = text.indexOf(marker); assert.ok(i >= 0, marker); return i + marker.length; };
export const line = (text: string, marker: string) => text.split('\n').findIndex(l => l.includes(marker));
export const target = (list: { uri: string; range: { start: { line: number; character: number } } }[] | null) => (list ?? []).map(l => [l.uri.slice(l.uri.indexOf('/symfony/') + 9), l.range.start.line, l.range.start.character]);
