import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCatalog, phpMessages, twigTransSites, xliffMessages, yamlMessages } from '../src/shared/language/plugins/translations';
import { at, host, line, project, read, root, target } from './helpers';

test('catálogos YAML aninhado, XLIFF, PHP (+intl-icu) e JSON', async () => {
 assert.deepEqual(yamlMessages(read('translations/messages.en.yaml')).map(m => [m.key, m.value, m.line]), [['admin.title', 'Administration', 1], ['post.title', 'Title', 3], ['post.body', 'Body', 4], ['flat.key', 'Flat', 5]]);
 assert.deepEqual(xliffMessages(read('translations/messages.pt_BR.xlf')).map(m => [m.key, m.value]), [['admin.title', 'Administração'], ['post.only_pt', 'Só em português']]);
 assert.deepEqual(phpMessages(read('translations/admin+intl-icu.en.php')).map(m => [m.key, m.value]), [['menu.posts', 'Posts'], ['menu.users', 'Users']]);
 const catalog = await loadCatalog(project(root, { 'translations/validators.fr.json': '{"a":{"b":"c"}}' }));
 assert.deepEqual([...catalog.domains].sort(), ['admin', 'messages', 'validators']);
 assert.equal(catalog.defaultLocale, 'en');
 assert.ok(catalog.messages.some(m => m.domain === 'validators' && m.key === 'a.b' && m.locale === 'fr'));
});

test('PHP: ->trans() com domínio no terceiro argumento, completion e navegação para todos os locales', async () => {
 const h = host(); const php = read('src/Controller/AdminController.php'); const path = 'src/Controller/AdminController.php';
 const items = await h.complete(path, php, at(php, "trans('admin."));
 assert.deepEqual(items!.items.map(i => [i.label, i.labelDetails?.description]), [['admin.title', 'Administration'], ['flat.key', 'Flat'], ['post.body', 'Body'], ['post.only_pt', 'Só em português'], ['post.title', 'Title']]);
 assert.equal(items!.items[0].detail, 'messages · en, pt_BR');
 const admin = await h.complete(path, php, at(php, "trans('menu."));
 assert.deepEqual(admin!.items.map(i => i.label), ['menu.posts', 'menu.users']);
 assert.deepEqual(target(await h.define(path, php, at(php, "trans('admin.ti"))).map(t => t[0]), ['translations/messages.en.yaml', 'translations/messages.pt_BR.xlf']);
 const t = "<?php\nuse function Symfony\\Component\\Translation\\t;\n$m = t('post.title');\n$n = new TranslatableMessage('menu.posts', [], 'admin');";
 assert.ok((await h.complete('src/X.php', t, at(t, "t('post")))!.items.some(i => i.label === 'post.title'));
 assert.ok((await h.complete('src/X.php', t, at(t, "Message('menu")))!.items.some(i => i.label === 'menu.users'));
});

test('Twig: |trans, |trans({}, domínio) e trans_default_domain', async () => {
 const h = host(); const twig = read('templates/admin/dashboard.html.twig'); const path = 'templates/admin/dashboard.html.twig';
 assert.deepEqual(twigTransSites(twig).map(s => [s.key, s.domain]), [['admin.title', 'messages'], ['menu.users', 'admin'], ['nope.missing', 'messages']]);
 assert.deepEqual(twigTransSites("{% trans_default_domain 'admin' %}{{ 'x'|trans }}").map(s => s.domain), ['admin']);
 const items = await h.completeCode(path, twig, at(twig, "'menu."));
 assert.deepEqual(items!.items.map(i => i.label), ['menu.posts', 'menu.users']);
 assert.equal(items!.items[0].textEdit.range.start.character, twig.split('\n')[3].indexOf('menu.users'), 'substitui a chave inteira');
 const typing = twig.replace("'admin.title'|trans", "'adm'|trans");
 assert.ok((await h.completeCode(path, typing, at(typing, "'adm")))!.items.some(i => i.label === 'admin.title'), 'chave incompleta');
 assert.deepEqual(target(await h.defineCode(path, twig, at(twig, "'menu.us"))), [['translations/admin+intl-icu.en.php', 5, 9]]);
});

test('chave ausente: aviso em PHP e Twig com correção que cria a chave no catálogo YAML', async () => {
 const h = host();
 const php = read('src/Controller/AdminController.php');
 const p = (await h.diagnose('src/Controller/AdminController.php', php)).filter(d => d.code === 'symfony.translation.missing');
 assert.deepEqual(p.map(d => [d.message, d.range.start.line]), [["Chave de tradução 'missing.key' não existe no domínio 'messages'.", line(php, 'missing.key')]]);
 const fix = (p[0] as any).fixes[0];
 assert.equal(fix.title, "Criar a chave 'missing.key' em translations/messages.en.yaml");
 assert.deepEqual([fix.edits[0].uri.endsWith('translations/messages.en.yaml'), fix.edits[0].range.start, fix.edits[0].newText], [true, { line: 6, character: 0 }, "'missing.key': 'missing.key'\n"]);
 const twig = read('templates/admin/dashboard.html.twig');
 const t = (await h.diagnose('templates/admin/dashboard.html.twig', twig)).filter(d => d.code === 'symfony.translation.missing');
 assert.deepEqual(t.map(d => d.message), ["Chave de tradução 'nope.missing' não existe no domínio 'messages'."]);
 assert.deepEqual((await h.diagnose('templates/admin/dashboard.html.twig', "{{ 'x'|trans({}, 'unknown') }}")), [], 'domínio sem catálogo não é reportado');
});
