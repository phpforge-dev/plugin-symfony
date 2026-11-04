import test from 'node:test';
import assert from 'node:assert/strict';
import { dqlAliases, parseEntity, parseMapped, parseXmlMapping, repositoryEntity, xmlMappingDirs } from '../src/shared/language/plugins/doctrine';
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
 assert.deepEqual(entities!.items.map(i => i.label), ['App\\Entity\\Admin', 'App\\Entity\\Comment', 'App\\Entity\\Post', 'App\\Entity\\Tag', 'App\\Entity\\User', 'App\\Legacy\\Invoice']);
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

const probe = (body: string) => `<?php\nnamespace App\\Controller;\nuse App\\Entity\\Comment;\nuse App\\Entity\\Tag;\nuse Doctrine\\ORM\\EntityManagerInterface;\nfinal class Probe {\n public function x(EntityManagerInterface $em) {\n  ${body}\n }\n}\n`;
const labels = (r: { items: { label: string }[] } | null) => r!.items.map(i => i.label);

test('superclasse mapeada, trait e classe pai comum: campos herdados com dono e navegação', async () => {
 const comment = parseMapped(read('src/Entity/Comment.php'), 'src/Entity/Comment.php')!;
 assert.deepEqual([comment.kind, comment.parent, comment.traits], ['entity', 'App\\Model\\PlainBase', ['App\\Entity\\Traits\\TimestampableTrait']]);
 assert.equal(parseMapped(read('src/Model/BaseEntity.php'), 'b')!.kind, 'superclass');
 assert.equal(parseMapped(read('src/Entity/Money.php'), 'm')!.kind, 'embeddable');
 assert.equal(parseMapped(read('src/Entity/Traits/TimestampableTrait.php'), 't')!.kind, 'trait');
 const h = host(); const text = probe("$em->getRepository(Comment::class)->findBy(['']);");
 const items = await h.complete('src/Controller/Probe.php', text, at(text, "findBy(['"));
 assert.deepEqual(labels(items), ['id', 'post', 'tip', 'createdAt', 'uuid'], 'próprios, trait, superclasse acima do pai comum; sem o campo do pai comum');
 assert.equal(items!.items.find(i => i.label === 'uuid')!.detail, 'BaseEntity::$uuid');
 assert.equal(items!.items.find(i => i.label === 'createdAt')!.detail, 'TimestampableTrait::$createdAt');
 const edited = text.replace("findBy([''", "findBy(['uuid'");
 const base = read('src/Model/BaseEntity.php');
 assert.deepEqual(target(await h.define('src/Controller/Probe.php', edited, at(edited, "findBy(['uu"))), [['src/Model/BaseEntity.php', line(base, '$uuid'), base.split('\n')[line(base, '$uuid')].indexOf('$uuid')]]);
 const ignored = text.replace("findBy([''", "findBy(['ignored'");
 assert.deepEqual((await h.diagnose('src/Controller/Probe.php', ignored)).filter(d => d.code === 'symfony.doctrine.field').map(d => d.message.split('.')[0]), ["Campo 'ignored' não existe em App\\Entity\\Comment"]);
});

test('herança de entidade (tabela única): filha recebe os campos do pai mapeado por anotações', async () => {
 const text = probe("$em->createQuery('SELECT a FROM App\\Entity\\Admin a WHERE a.');");
 assert.deepEqual(labels(await host().complete('src/Controller/Probe.php', text, at(text, 'WHERE a.'))), ['role', 'id', 'email', 'posts']);
});

test('mapeamento XML: config/doctrine e diretórios type: xml do doctrine.yaml; classe PHP dá o extends', async () => {
 const xml = read('config/doctrine/Tag.orm.xml');
 const [tag] = parseXmlMapping(xml, 'config/doctrine/Tag.orm.xml');
 assert.deepEqual(tag.fields.map(f => [f.name, f.kind, f.type ?? f.target, f.line]), [
  ['id', 'field', 'integer', line(xml, '<id name')], ['label', 'field', 'string', line(xml, 'name="label"')], ['posts', 'association', 'App\\Entity\\Post', line(xml, 'many-to-many')], ['price', 'embedded', 'App\\Entity\\Money', line(xml, '<embedded')]]);
 assert.deepEqual(xmlMappingDirs(read('config/packages/doctrine.yaml')), ['config/doctrine', 'config/doctrine_legacy']);
 const h = host(); const text = probe("$em->getRepository(Tag::class)->findBy(['']);");
 const items = await h.complete('src/Controller/Probe.php', text, at(text, "findBy(['"));
 assert.deepEqual(labels(items), ['id', 'label', 'posts', 'price', 'uuid'], 'campos do XML e herdados da superclasse pela classe PHP');
 assert.match(items!.items[1].detail!, /config\/doctrine\/Tag\.orm\.xml/);
 const edited = text.replace("findBy([''", "findBy(['label'");
 assert.deepEqual(target(await h.define('src/Controller/Probe.php', edited, at(edited, "findBy(['lab"))), [['config/doctrine/Tag.orm.xml', line(xml, 'name="label"'), xml.split('\n')[line(xml, 'name="label"')].indexOf('label')]]);
 const dql = probe("$em->createQuery('SELECT i FROM App\\Legacy\\Invoice i JOIN i.customer c WHERE c.');");
 assert.deepEqual(labels(await h.complete('src/Controller/Probe.php', dql, at(dql, 'WHERE c.'))), ['id', 'email', 'posts'], 'associação de entidade XML resolve o alvo');
});

test('embeddables: a.embutido.campo em DQL/QueryBuilder, com diagnóstico em cada passo', async () => {
 const h = host(); const text = probe("$em->createQuery('SELECT c FROM App\\Entity\\Comment c WHERE c.tip.amount > 0 AND c.tip.');");
 assert.deepEqual(labels(await h.complete('src/Controller/Probe.php', text, at(text, 'AND c.tip.'))), ['amount', 'currency']);
 const wrong = probe("$em->createQuery('SELECT c FROM App\\Entity\\Comment c WHERE c.tip.amout > 0 AND c.post.title = 1');");
 assert.deepEqual((await h.diagnose('src/Controller/Probe.php', wrong)).filter(d => d.code === 'symfony.doctrine.field').map(d => d.message), ["Campo 'amout' não existe em App\\Entity\\Money. Você quis dizer 'amount'?"], 'associação não é atravessada por ponto; embeddable sim');
});
