import test from 'node:test';
import assert from 'node:assert/strict';
import { compiledContainer, parseContainerXml } from '../src/shared/language/plugins/symfony-config';
import { at, host, project, read, root, target } from './helpers';

const xml = read('var/cache/dev/App_KernelDevDebugContainer.xml');
test('container compilado: serviços diretos (sem ocultos/inline), aliases e parâmetros de nível zero', () => {
 const parsed = parseContainerXml(xml, 'c.xml');
 assert.deepEqual(parsed.services.map(s => [s.key, s.class ?? s.value]), [
  ['service_container', 'Symfony\\Component\\DependencyInjection\\ContainerInterface'], ['app.mailer', 'App\\Mail\\Mailer'], ['router', 'Symfony\\Bundle\\FrameworkBundle\\Routing\\Router'],
  ['Symfony\\Component\\Routing\\RouterInterface', '@router'], ['translator', 'Symfony\\Bundle\\FrameworkBundle\\Translation\\Translator']]);
 assert.deepEqual(parsed.parameters.map(p => [p.key, p.value]), [['kernel.project_dir', '/srv/app'], ['kernel.environment', 'dev'], ['app.upload_dir', '/srv/app/public/uploads'], ['router.request_context.host', 'localhost'], ['kernel.bundles', '[…]']]);
});

test('localiza var/cache/<env>/*Container.xml preferindo dev', async () => {
 assert.equal(await compiledContainer(project(root)), 'var/cache/dev/App_KernelDevDebugContainer.xml');
 assert.equal(await compiledContainer(project(root, { 'var/cache/prod/App_KernelProdContainer.xml': '<container/>' })), 'var/cache/dev/App_KernelDevDebugContainer.xml');
 assert.equal(await compiledContainer(project(join_(root, 'src'))), null);
});
const join_ = (a: string, b: string) => `${a}/${b}`;

test('completion mescla config e container compilado; navegação prefere a definição YAML', async () => {
 const h = host(); const php = read('src/Controller/AdminController.php'); const path = 'src/Controller/AdminController.php';
 const items = await h.complete(path, php, at(php, "container->get('"));
 const router = items!.items.find(i => i.label === 'router')!;
 assert.match(router.detail!, /App_KernelDevDebugContainer\.xml:15 · container compilado/);
 assert.equal(items!.items.filter(i => i.label === 'app.mailer').length, 1, 'serviço da config não duplica');
 assert.deepEqual(target(await h.define(path, php, at(php, "container->get('rou"))), [['var/cache/dev/App_KernelDevDebugContainer.xml', 14, 17]]);
 const mailer = php.replace("get('router')", "get('app.mailer')");
 assert.deepEqual(target(await h.define(path, mailer, at(mailer, "get('app.ma"))), [['config/services.yaml', 12, 4]]);
 const param = await h.complete('src/Controller/BlogController.php', read('src/Controller/BlogController.php'), at(read('src/Controller/BlogController.php'), "getParameter('"));
 assert.equal(param!.items.filter(i => i.label === 'app.upload_dir').length, 1);
 assert.ok(param!.items.some(i => i.label === 'router.request_context.host'));
});

test('sem container compilado nada muda (cache ausente)', async () => {
 const h = host({ 'var/cache/dev/App_KernelDevDebugContainer.xml': '' });
 const php = read('src/Controller/AdminController.php');
 const items = await h.complete('src/Controller/AdminController.php', php, at(php, "container->get('"));
 assert.deepEqual(items!.items.map(i => i.label), ['app.clock', 'app.mailer', 'App\\Service\\Clock']);
});
