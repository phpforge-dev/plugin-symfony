import {build} from 'esbuild';
await build({entryPoints:['src/index.ts'],outfile:'main.js',bundle:true,format:'iife',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
