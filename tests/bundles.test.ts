import test from 'node:test';
import assert from 'node:assert/strict';
import { classFile, parseBundles, psr4 } from '../src/shared/language/plugins/symfony-config';
import { at, host, project, read, root, target } from './helpers';

test('config/bundles.php: classes, alias Twig e ambientes', () => {
 assert.deepEqual(parseBundles(read('config/bundles.php')).map(b => [b.fqcn, b.alias, b.envs.join(',')]), [
  ['Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle', 'Framework', 'all'], ['Acme\\DemoBundle\\AcmeDemoBundle', 'AcmeDemo', 'dev,test'], ['Missing\\GoneBundle\\GoneBundle', 'Gone', 'all']]);
 assert.deepEqual(parseBundles("<?php return [\\A\\BBundle::class => ['prod' => false, 'dev' => true]];").map(b => [b.fqcn, b.envs]), [['A\\BBundle', ['dev']]]);
});

test('PSR-4 do composer.json e de vendor/composer/installed.json localiza a classe do bundle', async () => {
 const files = project(root); const map = await psr4(files);
 assert.equal(await classFile('Acme\\DemoBundle\\AcmeDemoBundle', map, files), 'vendor/acme/demo-bundle/src/AcmeDemoBundle.php');
 assert.equal(await classFile('Symfony\\Bundle\\FrameworkBundle\\FrameworkBundle', map, files), 'vendor/symfony/framework-bundle/FrameworkBundle.php');
 assert.equal(await classFile('Missing\\GoneBundle\\GoneBundle', map, files), null);
});

test('templates @Bundle/: completion e navegação em Twig e PHP', async () => {
 const h = host(); const twig = read('templates/admin/dashboard.html.twig'); const path = 'templates/admin/dashboard.html.twig';
 const items = await h.completeCode(path, twig.replace("'@AcmeDemo/panel/layout.html.twig'", "'@Acme"), at(twig, "'@Acme"));
 assert.deepEqual(items!.items.filter(i => i.label.startsWith('@')).map(i => [i.label, i.detail]), [['@AcmeDemo/panel/layout.html.twig', 'vendor/acme/demo-bundle/templates/panel/layout.html.twig']]);
 assert.deepEqual(target(await h.defineCode(path, twig, at(twig, "'@AcmeDemo/pa"))), [['vendor/acme/demo-bundle/templates/panel/layout.html.twig', 0, 0]]);
 const php = "<?php\n$this->render('@AcmeDemo/panel/layout.html.twig');";
 assert.deepEqual(target(await h.define('src/X.php', php, at(php, "render('@Acme"))), [['vendor/acme/demo-bundle/templates/panel/layout.html.twig', 0, 0]]);
});

test('bundle sem classe no autoload vira erro em config/bundles.php', async () => {
 const text = read('config/bundles.php');
 const problems = (await host().diagnose('config/bundles.php', text)).filter(d => d.code === 'symfony.bundle.missing');
 assert.deepEqual(problems.map(d => [d.range.start.line, d.severity]), [[5, 'error']]);
 assert.match(problems[0].message, /Missing\\GoneBundle\\GoneBundle não encontrado/);
});
