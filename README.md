# PHPForge Symfony plugin

Standalone language worker extracted from PHPForge IDE under the MIT license. Requires IDE 0.2.13 or later. Install from the PHPForge plugin catalog, or install this repository from the Plugins panel. Grant project.read to enable project-aware suggestions. No Node runtime or native executable is required by the IDE. Disable or remove the plugin to stop its language contributions.

Detects symfony/framework-bundle in composer.json and its installed version in composer.lock. Supports PHP route attributes (including class prefixes and automatic names), YAML routes, Twig path/url and template references, container services and parameters, kernel parameters and masked environment references. Navigation opens declaration locations. Project changes invalidate caches. YAML support is intentionally limited to block key/value structures: imports, anchors, flow collections and multiline scalars are not fully resolved. No Symfony process is executed.

## Development

Run `npm ci --ignore-scripts`, `npm test`, and `npm run build`. Commit the generated main.js. CI tests behavior and checks the generated bundle is reproducible. Node and copied host test infrastructure are build/test tooling only; the browser bundle contains only the plugin and required helpers. Synthetic fixtures contain no real project secrets.
