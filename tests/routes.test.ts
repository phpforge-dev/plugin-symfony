import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePhpRoutes, parseXmlRoutes, xmlTags } from '../src/shared/language/plugins/symfony-config';
import { at, host, line, read, target } from './helpers';

test('rotas PHP (RoutingConfigurator): nome, caminho, métodos encadeados; import ignorado', () => {
 const text = read('config/routes/admin.php');
 assert.deepEqual(parsePhpRoutes(text, 'config/routes/admin.php').map(r => [r.name, r.path, r.methods, r.line, r.character]), [
  ['admin_dashboard', '/admin', 'GET|HEAD', line(text, "'admin_dashboard'"), text.split('\n')[line(text, "'admin_dashboard'")].indexOf('admin_dashboard')],
  ['admin_post_edit', '/admin/post/{id}', 'ANY', line(text, "'admin_post_edit'"), text.split('\n')[line(text, "'admin_post_edit'")].indexOf('admin_post_edit')],
 ]);
 assert.deepEqual(parsePhpRoutes("<?php\n$routes->add('a', '/a');\n$routes->add('b', '/b')->methods(['post']);", 'x.php').map(r => r.methods), ['ANY', 'POST'], 'métodos não vazam para a rota seguinte');
});

test('rotas XML: <route> dentro de <when>, comentário ignorado, entidades decodificadas', () => {
 const text = read('config/routes/legacy.xml');
 assert.deepEqual(parseXmlRoutes(text, 'config/routes/legacy.xml').map(r => [r.name, r.path, r.methods, r.line]), [
  ['legacy_archive', '/archive/{year}', 'GET|POST', line(text, 'legacy_archive')], ['legacy_debug', '/_legacy', 'ANY', line(text, 'legacy_debug')]]);
 assert.deepEqual(parseXmlRoutes('<routes><route id="a&amp;b" path=\'/x\'/></routes>', 'r.xml').map(r => r.name), ['a&b']);
 assert.deepEqual(xmlTags('<a><b/><c x="1>2"></c></a>').map(t => [t.name, t.depth, t.close, t.self]), [['a', 0, false, false], ['b', 1, false, true], ['c', 1, false, false], ['c', 1, true, false], ['a', 0, true, false]]);
});

test('PHP e Twig: completion e navegação para rotas PHP/XML', async () => {
 const h = host(); const controller = read('src/Controller/BlogController.php');
 const items = await h.complete('src/Controller/BlogController.php', controller, at(controller, "redirectToRoute('"));
 const legacy = items!.items.find(i => i.label === 'legacy_archive')!;
 assert.equal(legacy.labelDetails?.description, '/archive/{year}'); assert.equal(legacy.labelDetails?.detail, ' GET|POST');
 const edited = controller.replace("redirectToRoute('blog_index')", "redirectToRoute('admin_dashboard')");
 assert.deepEqual(target(await h.define('src/Controller/BlogController.php', edited, at(edited, "redirectToRoute('adm"))), [['config/routes/admin.php', 8, 18]]);
 const twig = "{{ path('legacy_ar') }}";
 assert.deepEqual(target(await h.defineCode('templates/x.html.twig', twig.replace('legacy_ar', 'legacy_archive'), 12)), [['config/routes/legacy.xml', 5, 15]]);
});
