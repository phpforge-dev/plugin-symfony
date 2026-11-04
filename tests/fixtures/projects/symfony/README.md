# Fixture Symfony v1

Projeto sintético, sem código do Symfony nem de bundles reais: só `composer.json`/`composer.lock` fictícios, controllers com `#[Route]`, rotas YAML/PHP/XML, `config/services.yaml`, `config/bundles.php`, templates Twig e `.env` com valores fictícios. Também:

- `vendor/composer/installed.json` e classes vazias em `vendor/` só para o autoload PSR-4 dos bundles; `vendor/acme/demo-bundle/templates/` para `@AcmeDemo/...`;
- `var/cache/dev/App_KernelDevDebugContainer.xml` escrito à mão no formato do container compilado;
- entidades Doctrine (atributos em `Post`, anotações em `User`), `PostRepository`, `PostType` e catálogos em `translations/` (YAML, XLIFF e PHP).

`vendor/symfony/console/composer.json` existe para a navegação pacote → vendor. Usado pelos testes em `tests/`.
