import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmlRoutes, xmlTags } from '../src/shared/language/plugins/symfony-config';
import { parseCompiledRoutes, parsePhpRouting, parseXmlImports, parseYamlImports, prefixPath } from '../src/shared/language/plugins/routing';
import { loadRoutes } from '../src/shared/language/plugins/symfony';
const parsePhpRoutes = (text: string, file: string) => parsePhpRouting(text, file).routes;
import { at, host, line, project, read, root, target } from './helpers';

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

test('coleções do RoutingConfigurator: prefixo de nome e caminho, mesmo declarado depois', () => {
 const text = read('config/routes/blog.php');
 const { routes, imports } = parsePhpRouting(text, 'config/routes/blog.php');
 assert.deepEqual(routes.map(r => [r.name, r.path, r.methods, r.line]), [
  ['blog_archive_list', '/archive/', 'GET', line(text, "add('list'")], ['blog_archive_year', '/archive/{year}', 'ANY', line(text, "add('year'")], ['api_status', '/api/status', 'GET', line(text, "add('status'")]]);
 assert.deepEqual(imports.map(i => [i.resource, i.prefix, i.namePrefix]), [['shop/catalog.yaml', '/shop', 'shop_']]);
 const nested = parsePhpRouting("<?php\n$a = $routes->collection('a_')->prefix('/a');\n$b = $a->collection('b_')->prefix('/b');\n$b->add('x', '/x');\n$a->import('../src/X/', 'attribute')->prefix('/i');", 'r.php');
 assert.deepEqual(nested.routes.map(r => [r.name, r.path]), [['a_b_x', '/a/b/x']], 'coleção aninhada');
 assert.deepEqual(nested.imports.map(i => [i.namePrefix, i.prefix, i.type]), [['a_', '/a/i', 'attribute']], 'import dentro de coleção');
 assert.equal(prefixPath('/blog', '/'), '/blog/'); assert.equal(prefixPath('/blog/', '/', false), '/blog'); assert.equal(prefixPath('', '/x'), '/x');
});

test('imports YAML/XML/PHP aplicam prefix e name_prefix; @Bundle e controllers por diretório', async () => {
 const routes = await loadRoutes(project(root), async () => []);
 const by = (name: string) => routes.filter(r => r.name === name).map(r => [r.path, r.file]);
 assert.deepEqual(by('api_v1_health'), [['/api/v1/health', 'src/Api/StatusController.php']], 'YAML: resource de diretório com type attribute');
 assert.deepEqual(by('old_page'), [['/old/page', 'config/routes/legacy/old.xml']], 'XML: prefix e name-prefix');
 assert.deepEqual(by('shop_catalog_item'), [['/shop/item/{sku}', 'config/routes/shop/catalog.yaml']], 'PHP: import encadeado');
 assert.deepEqual(by('catalog_item'), [], 'arquivo importado não é carregado de novo sem prefixo');
 assert.equal(by('blog_index').length, 1, 'controller importado por três arquivos aparece uma vez');
 assert.deepEqual(parseYamlImports(read('config/routes.yaml'), 'config/routes.yaml').map(i => [i.resource, i.type ?? '', i.prefix, i.namePrefix]), [
  ['../src/Controller/', 'attribute', '', ''], ['../src/Api/', 'attribute', '/api/v1', 'api_v1_'], ['@FrameworkBundle/Resources/config/routing/errors.xml', '', '/_error', '']]);
 assert.deepEqual(parseXmlImports(read('config/routes/legacy.xml'), 'x.xml').map(i => [i.resource, i.prefix, i.namePrefix]), [['../../src/Controller/', '', ''], ['legacy/old.xml', '/old', 'old_']]);
});

test('rotas compiladas (url_generating_routes.php): só as que a configuração não declara, navegação ao controller', async () => {
 const text = read('var/cache/dev/url_generating_routes.php');
 assert.deepEqual(parseCompiledRoutes(text, 'c.php').map(r => [r.name, r.path, r.controller ?? '']), [
  ['_preview_error', '/_error/{code}.{_format}', 'error_controller::preview'], ['acme_panel', '/_acme/panel/{section}', 'Acme\\DemoBundle\\Controller\\PanelController::show'],
  ['_wdt', '/_wdt/{token}', 'web_profiler.controller.profiler::toolbarAction'], ['blog_index', '/blog', 'App\\Controller\\BlogController::index']]);
 const h = host(); const controller = read('src/Controller/BlogController.php');
 const items = (await h.complete('src/Controller/BlogController.php', controller, at(controller, "redirectToRoute('")))!.items;
 const wdt = items.find(i => i.label === '_wdt')!;
 assert.equal(wdt.labelDetails?.description, '/_wdt/{token}'); assert.equal(wdt.labelDetails?.detail, undefined, 'o gerador não guarda métodos');
 assert.match(wdt.detail!, /rotas compiladas/);
 assert.ok(!items.some(i => i.label === 'prod_only'), 'cache dev tem preferência');
 assert.equal(items.find(i => i.label === 'blog_index')!.detail, `src/Controller/BlogController.php:${line(controller, "name: 'index'") + 1}`, 'rota declarada continua na fonte');
 assert.equal(items.find(i => i.label === '_preview_error')!.labelDetails?.description, '/_error/{code}.{_format}', 'import @FrameworkBundle com prefix');
 const edited = controller.replace("redirectToRoute('blog_index')", "redirectToRoute('acme_panel')");
 const panel = read('vendor/acme/demo-bundle/src/Controller/PanelController.php');
 assert.deepEqual(target(await h.define('src/Controller/BlogController.php', edited, at(edited, "redirectToRoute('acm"))), [['vendor/acme/demo-bundle/src/Controller/PanelController.php', line(panel, 'function show'), panel.split('\n')[line(panel, 'function show')].indexOf('show')]]);
});
