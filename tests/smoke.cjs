const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const nodes=new Map(),storage=new Map(),timers=new Map();
let seq=0;
const context2d=new Proxy({}, {get:(o,k)=>o[k]||(()=>{}),set:(o,k,v)=>(o[k]=v,true)});
class Element{
 constructor(){this.style={};this.dataset={};this.value='';this.width=300;this.height=220;this.classList={add(){},remove(){},toggle(){}};}
 set innerHTML(v){this.html=v;for(const m of v.matchAll(/id="([^"]+)"/g))nodes.set('#'+m[1],new Element());}
 get innerHTML(){return this.html||''}
 getContext(){return context2d}
 querySelectorAll(){return []}
 addEventListener(){}
 click(){if(this.onclick)this.onclick({target:this})}
}
for(const m of html.matchAll(/id="([^"]+)"/g))nodes.set('#'+m[1],new Element());
const document={querySelector:s=>nodes.get(s)||null,querySelectorAll:()=>[],createElement:()=>new Element()};
let downloaded=null;
const sandbox={document,console,Date,Math,JSON,Set,Number,String,Object,Array,RegExp,Error,
 localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
 setTimeout:f=>{timers.set(++seq,f);return seq},clearTimeout:id=>timers.delete(id),
 window:{addEventListener(){}},confirm:()=>true,innerWidth:1200,innerHeight:900,
 navigator:{clipboard:{writeText:async()=>{}}},Blob:class{constructor(parts){this.parts=parts}},
 URL:{createObjectURL:b=>{downloaded=b.parts.join('');return 'blob:test'}},
 FileReader:class{readAsText(f){this.result=f.text;this.onload()}},
 fetch:()=>{throw Error('Network disabled in tests')}
};
vm.createContext(sandbox);
const run=s=>vm.runInContext(s,sandbox);
vm.runInContext(source,sandbox);
assert.equal(run('state.records.length'),0,'fresh installation must be empty');
assert.equal(run('typeof renderExport'),'function');
assert.equal(run('typeof startEvent'),'function');
run("startEvent('测试学习')");
assert.equal(run('running.name'),'测试学习');
assert.equal(timers.size>=1,true);
run("stopEvent()");
assert.equal(run('pendingEnd.name'),'测试学习');
nodes.get('#mask').onclick({target:{id:'mask'}});
assert.equal(run('state.records.length'),1);
assert.equal(run('pendingEnd'),null);
const personal=run('JSON.stringify(state.records)');
nodes.get('#toggleDemo').click();
assert.equal(run('demoMode'),true);
assert.ok(run('state.records.length')>20);
nodes.get('#toggleDemo').click();
assert.equal(run('JSON.stringify(state.records)'),personal,'demo must not replace personal records');
assert.equal(run("clipRecords([{start:0,end:200,cat:'study'}],50,100)[0].end-clipRecords([{start:0,end:200,cat:'study'}],50,100)[0].start"),50);
assert.equal(run("byCat(clipRecords([{start:0,end:200,cat:'study'}],50,100)).study"),50);
assert.equal(run("parseNatural('下午3点到4点开会').end-parseNatural('下午3点到4点开会').start"),3600000);
assert.equal(run("parseNatural('看书2小时').end-parseNatural('看书2小时').start"),7200000);
run("doParse('看书2小时')");
nodes.get('#rtOk').click();
assert.equal(run('state.records.length'),2);
run("state.records.push({id:'old',name:'旧记录',cat:'study',start:Date.now()-60*DAY_MS,end:Date.now()-60*DAY_MS+60000})");
nodes.get('#expJson').click();
assert.equal(JSON.parse(downloaded).records.some(r=>r.id==='old'),true,'backup includes records older than 30 days');
run("state=emptyState();running=null;save()");
assert.ok(run("localReviewText()").includes('没有记录'));
const payload={categories:[{id:'study',name:'学习',color:'#123456'}],records:[{id:'import1',name:'导入',cat:'study',start:1,end:60001}]};
nodes.get('#impFile').onchange({target:{files:[{text:JSON.stringify(payload)}]}});
assert.equal(run('state.records.length'),1);
nodes.get('#impFile').onchange({target:{files:[{text:JSON.stringify(payload)}]}});
assert.equal(run('state.records.length'),1,'repeated import deduplicates');
payload.records[0].end=-1;
nodes.get('#impFile').onchange({target:{files:[{text:JSON.stringify(payload)}]}});
assert.equal(run('state.records[0].end'),60001,'invalid import must not mutate existing data');
run("state.records=[{id:'cross',name:'跨天',cat:'study',start:dayStart(new Date())-3600000,end:dayStart(new Date())+3600000}]");
assert.ok(run('buildMarkdown()').includes('1h00m'));
assert.ok(!run('buildMarkdown()').includes('2h00m'));
nodes.get('#resetDemo').click();
assert.equal(run('state.records.length'),0);
const pluginSource=fs.readFileSync(require('node:path').join(__dirname,'../obsidian-plugin/main.js'),'utf8');
const pluginContext={require:()=>({Plugin:class{},PluginSettingTab:class{},ItemView:class{},TFile:class{},moment:()=>({format:()=>''})}),module:{exports:{}},Date,console};
vm.createContext(pluginContext);vm.runInContext(pluginSource,pluginContext);
assert.equal(vm.runInContext('clipRecords([{start:0,end:200}],50,100)[0].end',pluginContext),100);
console.log('PASS: initialization, timer/archive, demo isolation, clipping, natural input, export, import validation, empty review, clearing and plugin clipping.');
