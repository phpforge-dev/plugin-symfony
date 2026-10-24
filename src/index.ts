import {SymfonyPlugin} from './shared/language/plugins/symfony';
declare const ide:{register(plugin:unknown):void};
ide.register(new SymfonyPlugin());
