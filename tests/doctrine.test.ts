import test from 'node:test';
import assert from 'node:assert/strict';
import { dqlAliases, parseEntity, repositoryEntity } from '../src/shared/language/plugins/doctrine';
import { at, host, line, read, target } from './helpers';

const post = read('src/Entity/Post.php'); const repo = read('src/Repository/PostRepository.php'); const admin = read('src/Controller/AdminController.php');
test('entidades por atributos e por anotações: campos, associações, alvo e repositório', () => {
 const p = parseEntity(post, 'src/Entity/Post.php')!;
 assert.equal(p.repository, 'App\\Repository\\PostRepository');
 assert.deepEqual(p.fields.map(f => [f.name, f.kind, f.type ?? f.target]), [['id', 'field', 'int'], ['title', 'field', 'string'], ['body', 'field', 'text'], ['publishedAt', 'field', 'datetimeimmutable'], ['author', 'association', 'App\\Entity\\User'], ['tags', 'association', 'App\\Entity\\Tag']]);
 assert.equal(p.fields.find(f => f.name === 'title')!.line, line(post, '$title'));
 const u = parseEntity(read('src/Entity/User.php'), 'src/Entity/User.php')!;
 assert.deepEqual(u.fields.map(f => [f.name, f.kind, f.type ?? f.target]), [['id', 'field', 'integer'], ['email', 'field', 'string'], ['posts', 'association', 'App\\Entity\\Post']]);
 assert.equal(parseEntity("<?php\n// Entity em comentário não conta\nclass PostType {}", 'x'), null);
 assert.deepEqual(repositoryEntity(repo), { repository: 'App\\Repository\\PostRepository', entity: 'App\\Entity\\Post' });
});

test('findBy/findOneBy: campos pelo repositório ($this) e por getRepository(X::class)', async () => {
 const h = host();
 const inRepo = await h.complete('src/Repository/PostRepository.php', repo, at(repo, "findBy(['"));
 assert.deepEqual(inRepo!.items.map(i => i.label), ['id', 'title', 'body', 'publishedAt', 'author', 'tags']);
 assert.equal(inRepo!.items.find(i => i.label === 'author')!.labelDetails?.description, 'User');
 const orderBy = await h.complete('src/Repository/PostRepository.php', repo, at(repo, "], ['"));
 assert.ok(orderBy!.items.some(i => i.label === 'publishedAt'), 'segundo argumento (orderBy) também');
 const outside = await h.complete('src/Controller/AdminController.php', admin, at(admin, "findBy(['"));
 assert.ok(outside!.items.some(i => i.label === 'title'));
 assert.deepEqual(target(await h.define('src/Controller/AdminController.php', admin, at(admin, "findBy(['aut"))), [['src/Entity/Post.php', line(post, '$author'), post.split('\n')[line(post, '$author')].indexOf('$author')]]);
 const value = admin.replace("['author' => null]", "['author' => 'x']");
 assert.equal(await h.complete('src/Controller/AdminController.php', value, at(value, "=> 'x")), null, 'valor não é campo');
});

test('QueryBuilder: aliases do createQueryBuilder e joins por associação', async () => {
 const h = host(); const path = 'src/Repository/PostRepository.php';
 const fields = await h.complete(path, repo, at(repo, "andWhere('p."));
 assert.ok(fields!.items.some(i => i.label === 'publishedAt'));
 assert.equal(fields!.items[0].textEdit.range.start.character, repo.split('\n')[line(repo, "andWhere('p.publishedAt")].indexOf('publishedAt'), 'substitui só o campo');
 const joined = await h.complete(path, repo, at(repo, "andWhere('a."));
 assert.deepEqual(joined!.items.map(i => i.label), ['id', 'email', 'posts'], 'alias do join resolve para User');
 const aliases = await h.complete(path, repo.replace("andWhere('a.email", "andWhere('a.email = :email AND "), at(repo, "andWhere('a.email") + ' = :email AND '.length);
 assert.deepEqual(aliases!.items.map(i => i.label), ['p', 'a']);
 assert.deepEqual(target(await h.define(path, repo, at(repo, "andWhere('a.em"))), [['src/Entity/User.php', 18, 12]]);
});

test('DQL: FROM/JOIN, campos por alias e nomes de entidade', async () => {
 const h = host(); const path = 'src/Controller/AdminController.php';
 const dql = 'SELECT p FROM App\\Entity\\Post p JOIN p.author u WHERE u.email = :e';
 assert.deepEqual([...dqlAliases({ entities: [parseEntity(post, 'p')!, parseEntity(read('src/Entity/User.php'), 'u')!], repositories: new Map() }, dql)].map(([a, e]) => [a, e.name]), [['p', 'Post'], ['u', 'User']]);
 const items = await h.complete(path, admin, at(admin, 'WHERE u.'));
 assert.deepEqual(items!.items.map(i => i.label), ['id', 'email', 'posts']);
 const entities = await h.complete(path, admin.replace('FROM App\\Entity\\Post p', 'FROM App'), at(admin, 'FROM App'));
 assert.deepEqual(entities!.items.map(i => i.label), ['App\\Entity\\Post', 'App\\Entity\\User']);
 assert.deepEqual(target(await h.define(path, admin, at(admin, 'AND p.tit'))), [['src/Entity/Post.php', line(post, '$title'), post.split('\n')[line(post, '$title')].indexOf('$title')]]);
});

test('diagnóstico de campo inexistente com sugestão e correção', async () => {
 const problems = (await host().diagnose('src/Repository/PostRepository.php', repo)).filter(d => d.code === 'symfony.doctrine.field');
 assert.deepEqual(problems.map(d => [d.message, d.range.start.line]), [["Campo 'titel' não existe em App\\Entity\\Post. Você quis dizer 'title'?", line(repo, "'p.titel'")]]);
 const fix = (problems[0] as any).fixes[0];
 assert.equal(fix.title, "Trocar por 'title'"); assert.equal(fix.edits[0].newText, 'title');
 const findBy = repo.replace("findBy(['title'", "findBy(['nope'");
 assert.deepEqual((await host().diagnose('src/Repository/PostRepository.php', findBy)).filter(d => d.code === 'symfony.doctrine.field').map(d => d.message.split('.')[0]), ["Campo 'titel' não existe em App\\Entity\\Post", "Campo 'nope' não existe em App\\Entity\\Post"]);
 assert.deepEqual((await host().diagnose('src/Controller/AdminController.php', admin)).filter(d => d.code === 'symfony.doctrine.field'), [], 'DQL válida sem falso positivo');
});
