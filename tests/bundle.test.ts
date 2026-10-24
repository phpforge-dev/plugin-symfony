import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('published browser bundle registers an independent worker provider',async()=>{
 const plugins:any[]=[]; const context=vm.createContext({ide:{register:(p:any)=>plugins.push(p)}});
 vm.runInContext(readFileSync(new URL('../main.js',import.meta.url),'utf8'),context,{timeout:1000});
 assert.equal(plugins.length,1); const plugin=plugins[0];
 assert.equal(typeof plugin.completeCode,'function');
 assert.equal(vm.runInContext('typeof process',context),'undefined');
 assert.equal(vm.runInContext('typeof require',context),'undefined');
 assert.equal(await plugin.completeCode({path:'README.txt',text:'',offset:0},{}),null);
});
