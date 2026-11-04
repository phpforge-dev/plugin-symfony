import test from 'node:test';
import assert from 'node:assert/strict';
import { formOptions } from '../src/shared/language/plugins/doctrine';
import { at, host, line, read, target } from './helpers';

const form = read('src/Form/PostType.php'); const path = 'src/Form/PostType.php'; const post = read('src/Entity/Post.php');
test('->add(): campos do data_class com navegação para a propriedade', async () => {
 const h = host();
 const items = await h.complete(path, form, at(form, "->add('"));
 assert.deepEqual(items!.items.map(i => i.label), ['id', 'title', 'body', 'publishedAt', 'author', 'tags']);
 assert.deepEqual(target(await h.define(path, form, at(form, "->add('bo"))), [['src/Entity/Post.php', line(post, '$body'), post.split('\n')[line(post, '$body')].indexOf('$body')]]);
 const noData = form.replace("'data_class' => Post::class", "'csrf_protection' => true");
 assert.equal(await h.complete(path, noData, at(noData, "->add('")), null, 'sem data_class não sugere');
});

test('opções do tipo no terceiro argumento e no setDefaults', async () => {
 const h = host();
 const options = await h.complete(path, form, at(form, "TextType::class, ['"));
 const labels = options!.items.map(i => i.label);
 assert.ok(labels.includes('label') && labels.includes('required') && labels.includes('constraints'));
 const choice = form.replace('TextType::class', 'ChoiceType::class');
 const choiceItems = await h.complete(path, choice, at(choice, "ChoiceType::class, ['"));
 assert.equal(choiceItems!.items[0].labelDetails?.description, 'ChoiceType', 'opções próprias do tipo primeiro');
 assert.ok(choiceItems!.items.some(i => i.label === 'choices'));
 const defaults = await h.complete(path, form, at(form, "setDefaults(['"));
 assert.ok(defaults!.items.some(i => i.label === 'data_class'));
 assert.ok(formOptions('EntityType').some(o => o.name === 'query_builder' && o.own));
});

test('label/help recebem chaves de tradução do domínio do form', async () => {
 const h = host();
 const items = await h.complete(path, form, at(form, "'label' => 'post."));
 assert.ok(items!.items.some(i => i.label === 'post.title' && i.labelDetails?.description === 'Title'));
 assert.deepEqual(target(await h.define(path, form, at(form, "'label' => 'post.ti"))), [['translations/messages.en.yaml', 3, 4]]);
});
