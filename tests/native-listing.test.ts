import test from 'node:test';
import assert from 'node:assert/strict';
import { SymfonyPlugin } from '../src/shared/language/plugins/symfony';
import { PluginHost } from '../src/shared/language/plugins/host';
import type { ProjectFiles } from '../src/shared/language/plugins/api';

// The IDE's native listing rejects missing folders. A minimal project (no var/cache, src/Entity or mapping
// dirs) must still complete its routes, as the native smoke fixture does.
test('missing optional folders do not drop route completion', async () => {
 const tree: Record<string, string> = {
  'composer.json': '{"require":{"symfony/framework-bundle":"^7.0"}}',
  'config/routes.yaml': 'extraction_home:\n  path: /extraction\n',
 };
 const files: ProjectFiles = {
  root: '/p',
  read: async path => tree[path] ?? null,
  exists: async path => path in tree,
  list: async (dir, accept) => {
   const inside = Object.keys(tree).filter(p => p.startsWith(dir + '/'));
   if (!inside.length) throw Error('No such file or directory (os error 2): ' + dir);
   return inside.filter(p => accept(p.split('/').pop()!));
  },
  uri: path => 'file:///p/' + path,
 };
 const text = "{{ path('extraction_";
 const result: any = await new PluginHost(files, [new SymfonyPlugin()]).completeCode('templates/a.html.twig', text, text.length);
 assert.deepEqual(result?.items.map((i: any) => i.label), ['extraction_home']);
});
