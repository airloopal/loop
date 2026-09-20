'use strict';
// Controller integration checks in a deterministic DOM stub, not browser layout tests.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const project=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(project,'app/fragment.html'),'utf8');
const runtime=fs.readFileSync(path.join(project,'app/consumer-runtime.js'),'utf8');
class Element{
 constructor(tag='div'){
  this.tagName=tag.toUpperCase();this.nodeType=1;this.children=[];this.dataset={};this.handlers={};this.value='';this.text='';this.attrs={};this.properties={};this.animations=[];
  this.classList={toggle:(n,force)=>{const set=new Set((this.className||'').split(/\s+/).filter(Boolean));const on=force===undefined?!set.has(n):force;if(on)set.add(n);else set.delete(n);this.className=[...set].join(' ');return on;},add:(...n)=>n.forEach(x=>this.classList.toggle(x,true)),remove:(...n)=>n.forEach(x=>this.classList.toggle(x,false)),contains:n=>(this.className||'').split(/\s+/).includes(n)};
  this.style={setProperty:(k,v)=>this.properties[k]=v,getPropertyValue:k=>this.properties[k]||''};
 }
 set textContent(v){this.text=String(v);this.children=[];this._textNode=null;}get textContent(){return this.text+this.children.map(x=>x.textContent).join('');}
 get childNodes(){if(this.text&&!this._textNode){const owner=this;this._textNode={nodeType:3,parentElement:owner,parentNode:owner,get nodeValue(){return owner.text},set nodeValue(v){owner.text=String(v)},get textContent(){return owner.text},set textContent(v){owner.text=String(v)}};}return [...(this.text?[this._textNode]:[]),...this.children];}
 querySelector(s){const match=this.querySelectorAll(s)[0];if(match)return match;this.localElements ||= {};return this.localElements[s]||(this.localElements[s]=new Element());}
 querySelectorAll(s){const items=[];function walk(x){for(const c of x.children){if(c.matches?.(s))items.push(c);walk(c);}}walk(this);return items;}
 matches(selector){return selector.split(',').some(part=>{const s=part.trim();if(s==='*')return true;if(s.startsWith('.'))return this.classList.contains(s.slice(1));if(s.startsWith('#'))return this.id===s.slice(1);if(s.startsWith('[')){const m=s.match(/^\[([^=]+)(?:=["']?([^"'\]]+)["']?)?\]$/);return m&&(m[2]===undefined?this.attrs[m[1]]!==undefined:this.attrs[m[1]]===m[2]);}return this.tagName.toLowerCase()===s.toLowerCase();});}
 closest(s){let x=this;while(x){if(x.matches?.(s))return x;x=x.parentElement;}return null;}
 addEventListener(e,f){this.listeners||={};(this.listeners[e]||=[]).push(f);this.handlers[e]=event=>{for(const handler of this.listeners[e])handler(event);};}replaceChildren(...els){this.children=[];this.text='';this._textNode=null;els.forEach(e=>this.appendChild(e));}
 appendChild(e){this.children.push(e);e.parentElement=this;e.parentNode=this;return e;}append(...els){els.forEach(e=>this.appendChild(e));}prepend(e){this.children.unshift(e);e.parentElement=this;e.parentNode=this;}insertBefore(e,b){const i=this.children.indexOf(b);if(i<0)return this.appendChild(e);this.children.splice(i,0,e);e.parentElement=this;e.parentNode=this;return e;}remove(){const p=this.parentElement;if(p)p.children=p.children.filter(x=>x!==this);}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='class')this.className=String(v);if(k==='id')this.id=String(v);}getAttribute(k){return this.attrs[k]??null;}hasAttribute(k){return this.attrs[k]!==undefined;}removeAttribute(k){delete this.attrs[k];}
 animate(frames,options){this.animations.push({frames,options});return {cancel(){}};}focus(options){this.focusCount=(this.focusCount||0)+1;this.lastFocusOptions=options;}click(){if(!this.disabled)this.handlers.click?.({currentTarget:this,preventDefault(){}});}
}
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
const stateSeed=()=>({schemaVersion:1,savedProfiles:[],guideProgress:{},lastAdvancedGuide:null,language:'en',onboardingComplete:true,updatedAt:'2026-09-19T00:00:00.000Z'});
const configuration={productID:'com.littlesteps.techhelp.fullaccess.annual',purchasesEnabled:true,supportEmail:'support@example.test',privacyURL:'https://example.test/privacy',termsURL:'https://example.test/terms'};
const inactive=()=>({status:'inactive',price:'$49.99',period:'year',productId:configuration.productID,expirationDate:null});
const active=()=>({...inactive(),status:'active',expirationDate:new Date(Date.now()+86400000).toISOString()});
const tick=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const makeStorage=(seed=null)=>({native:clone(seed),browser:new Map(seed?[['little-steps-state-v1',JSON.stringify(seed)]]:[])});
function app({native=false,store=makeStorage(),subscription=inactive(),purchase,restore,loading,config={},reduced=true}={}){
 const e={},root=new Element('div'),calls=[];root.id=html.match(/<div id="([^"]+)"/)[1];
 root.querySelector=s=>{if(e[s])return e[s];const actual=Element.prototype.querySelectorAll.call(root,s)[0];if(actual)return actual;const el=new Element(/^[a-z]+$/.test(s)?s:'div');if(s.startsWith('.'))el.className=s.slice(1);if(s.startsWith('#'))el.id=s.slice(1);e[s]=el;root.appendChild(el);return el;};
 const events=object=>{object.listeners={};object.addEventListener=(name,callback)=>(object.listeners[name]||=[]).push(callback);object.dispatchEvent=event=>{for(const listener of object.listeners[event.type]||[])listener(event);return true;};return object;};
 const document=events({getElementById:()=>root,createElement:tag=>new Element(tag),visibilityState:'visible',createTreeWalker:(container,what,filter)=>{const found=[];function visit(x){for(const node of x.childNodes||[]){if(node.nodeType===3&&(!filter||filter.acceptNode?.(node)!==2))found.push(node);else visit(node);}}visit(container);let at=0;return {nextNode:()=>found[at++]||null};}});
 const window=events({matchMedia:()=>({matches:reduced}),LITTLE_STEPS_CONFIG:{...configuration,...config},location:{href:''},localStorage:{getItem:key=>store.browser.get(key)??null,setItem:(key,value)=>store.browser.set(key,String(value)),removeItem:key=>store.browser.delete(key)}});
 const billing={subscription,purchase,restore};
 if(native)window.webkit={messageHandlers:{littleSteps:{postMessage:async({action,payload})=>{calls.push({action,payload:clone(payload)});if(action==='loadState'){if(loading)return await loading;return {state:clone(store.native)};}if(action==='saveState'){store.native=clone(payload.state);return {ok:true};}if(action==='clearState'){store.native=null;return {ok:true};}if(action==='getSubscription')return clone(billing.subscription);if(action==='purchase')return typeof billing.purchase==='function'?await billing.purchase():clone(billing.purchase||billing.subscription);if(action==='restore')return clone(billing.restore||billing.subscription);if(action==='manageSubscription'||action==='shareSummary')return {ok:true};throw new Error('Unexpected bridge action '+action);}}}};
 const c={console,document,window,navigator:{language:'en-GB'},NodeFilter:{SHOW_TEXT:4,FILTER_ACCEPT:1,FILTER_REJECT:2,FILTER_SKIP:3},requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout,performance:{now:()=>0},CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}}};
 vm.createContext(c);vm.runInContext(runtime,c,{filename:'consumer-runtime.js'});
 let script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
 script=script.replace(/\}\)\(\);\s*$/,`globalThis.qa={state:()=>({current,facts:{...facts},history:history.length,deviceStep,profiles:savedProfiles.map(p=>({...p})),hasFullAccess,consumerReady,subscriptionBusy,onboardingComplete,language:localeState.code,guideProgress:JSON.parse(JSON.stringify(guideProgress))}),data:{catalog:TECH_CATALOG,free:FREE_GUIDES,advanced:ADVANCED_GUIDES},go:(...args)=>go(...args),setFacts:value=>{facts={...value};},freeMatch:basicGuideMatches,locale:code=>applyLocale(code),published:publishedModelGuides};\n})();`);
 vm.runInContext(script,c,{filename:'fragment.html'});
 const label=x=>x.children.find(z=>z.className==='ls-choice-label')?.textContent||x.textContent;
 const choose=(area,t,paging=true)=>{let b=e[area]?.children.find(x=>label(x)===t),more,loops=0;while(!b&&paging&&(more=e[area]?.children.find(x=>x.classList.contains('ls-load-more')))){assert(++loops<40,'Infinite Load More');more.click();b=e[area].children.find(x=>label(x)===t);}assert(b,`Missing '${t}' at ${c.qa.state().current}. Options: ${e[area]?.children.map(label).join(' | ')}`);return b;};
 const click=t=>choose('.th-options',t).click();
 return {c,e,root,click,choose,label,window,document,calls,store,billing,state:()=>c.qa.state(),go:(...args)=>c.qa.go(...args),wizard:t=>choose('.ls-wizard-options',t).click(),walk:labels=>labels.forEach(click),heading:()=>e.h2.textContent,ready:tick};
}
async function ready(options={}){const a=app(options);await a.ready();return a;}
async function begin(a){if(a.state().current==='welcome')a.click('Let’s begin');await tick();}
function savedData(a,native){return native?a.store.native:JSON.parse(a.store.browser.get('little-steps-state-v1')||'null');}
const results=[];
async function test(name,fn){await fn();results.push(name);console.log('PASS',name);}
(async()=>{
 await test('Async native bootstrap waits for storage and keeps a known saved state',async()=>{
  let resolve;const waiting=new Promise(r=>resolve=r),seed=stateSeed();seed.language='fr';
  const a=app({native:true,loading:waiting});assert.equal(a.state().consumerReady,false);assert(a.root.classList.contains('ls-booting'));assert.equal(a.calls.filter(c=>c.action==='saveState').length,0);
  resolve({state:seed});await tick();assert.equal(a.state().consumerReady,true);assert.equal(a.state().current,'start');assert.equal(a.state().language,'fr');assert.equal(a.root.classList.contains('ls-booting'),false);
 });
 for(const native of [false,true])await test(`${native?'Native':'Browser'} My Tech and language survive reload; removal persists`,async()=>{
  const a=await ready({native});assert.equal(a.state().current,'welcome');await begin(a);
  a.e['.ls-nav-tech'].click();a.e['.ls-add-device'].click();['Phones & tablets','Apple','iPhone 15','iOS'].forEach(a.wizard);
  const nickname='<img src=x onerror=alert(1)> My phone';a.e['#ls-device-nickname'].value=nickname;a.e['.ls-wizard-review'].handlers.submit({preventDefault(){}});await tick();
  assert.equal(a.state().profiles.length,1);assert.equal(a.state().profiles[0].nickname,nickname);assert.equal(savedData(a,native).savedProfiles[0].nickname,nickname);
  a.c.qa.locale('ar');await tick();assert.equal(savedData(a,native).language,'ar');
  const b=await ready({native,store:a.store});assert.equal(b.state().current,'start');assert.equal(b.state().language,'ar');assert.equal(b.root.getAttribute('dir'),'rtl');assert.equal(b.state().profiles[0].nickname,nickname);
  b.c.qa.locale('en');b.e['.ls-nav-tech'].click();b.e['.ls-saved-list'].children[0].children[0].click();assert.equal(b.state().current,'basic_issues');assert.equal(b.state().facts.modelId,'iphone-15');
  b.e['.ls-nav-tech'].click();b.e['.ls-saved-list'].children[0].children[1].click();await tick();assert.equal(b.state().profiles.length,0);
  const c=await ready({native,store:a.store});assert.equal(c.state().profiles.length,0);assert.equal(c.state().language,'en');assert.equal(c.state().current,'start');
 });
 await test('Unknown saved schema is preserved instead of overwritten by bootstrap',async()=>{
  for(const native of [false,true]){const seed={...stateSeed(),schemaVersion:999,extra:'do not overwrite'},store=makeStorage(seed),a=await ready({native,store});await begin(a);a.c.qa.locale('fr');await tick();assert.equal(savedData(a,native).schemaVersion,999);assert.equal(savedData(a,native).extra,'do not overwrite');assert.equal(a.state().hasFullAccess,false);}
 });
 await test('Saved flags, forged events and the old preview action cannot unlock guides',async()=>{
  const seed={...stateSeed(),hasFullAccess:true,previewAccess:true,subscriptionState:{status:'active'}};
  for(const native of [false,true]){const a=await ready({native,store:makeStorage(seed)});assert.equal(a.state().hasFullAccess,false);a.window.dispatchEvent({type:'littleStepsSubscriptionChanged',detail:{status:'active',verified:true}});await tick();assert.equal(a.state().hasFullAccess,false);
   a.go('@preview_access');assert.equal(a.state().hasFullAccess,false);const g=a.c.qa.data.advanced[0];a.go('@browse_guide',{guideId:g.id,guideStep:0,browsing:true});
   for(const target of ['member_home','guide_step','guide_result','guide_help','guide_summary']){a.go(target);assert.equal(a.state().hasFullAccess,false);assert(!a.e['.th-detail'].textContent.includes(g.steps[0].body),target+' leaks paid content');assert(a.e['.ls-guide-summary'].hidden);}
  }
 });
 await test('Annual offer uses StoreKit price; pending, cancellation and errors stay locked',async()=>{
  const a=await ready({native:true,store:makeStorage(stateSeed()),subscription:{...inactive(),price:'£44.99'}});a.go('full_access');assert.equal(a.e['.ls-plan-price'].textContent,'£44.99 / year');assert(a.choose('.th-options','Subscribe · £44.99 / year'));assert(a.e['.ls-plan-renewal'].textContent.includes('Billed yearly'));
  for(const [result,message] of [[{...inactive(),outcome:'pending'},'awaiting approval'],[{...inactive(),outcome:'cancelled'},'Purchase cancelled'],[{ok:false,error:{code:'store_unavailable',message:'App Store could not connect'}},'App Store could not connect']]){a.billing.purchase=result;a.go('@purchase');await tick();assert.equal(a.state().hasFullAccess,false);assert(a.e['.ls-consumer-notice'].textContent.includes(message));}
  const browser=await ready({store:makeStorage(stateSeed())});browser.go('full_access');assert.equal(browser.e['.ls-plan-price'].textContent,'$49.99 / year · USD');browser.go('@purchase');await tick();assert.equal(browser.state().hasFullAccess,false);assert(browser.e['.ls-consumer-notice'].textContent.includes('iOS app'));
 });
 await test('Only verified native active responses unlock; restore and manage call bridge',async()=>{
  const a=await ready({native:true,store:makeStorage(stateSeed())});a.go('full_access');a.billing.restore={...active(),outcome:'restored'};a.click('Restore purchases');await tick();assert.equal(a.state().hasFullAccess,true);assert.equal(a.state().current,'member_home');assert(a.calls.some(c=>c.action==='restore'));
  a.billing.subscription=active();a.go('settings');a.click('Manage subscription');await tick();assert(a.calls.some(c=>c.action==='manageSubscription'));assert.equal(a.state().hasFullAccess,true);
  a.billing.subscription=inactive();a.window.dispatchEvent({type:'littleStepsSubscriptionChanged',detail:{status:'active'}});await tick();assert.equal(a.state().hasFullAccess,false);a.go('guide_step');assert(!a.e['.th-detail'].textContent.includes(a.c.qa.data.advanced[0].steps[0].body));
  a.billing.purchase=active();a.go('@purchase');await tick();assert.equal(a.state().hasFullAccess,true);assert.equal(a.state().current,'member_home');
 });
 await test('Purchase busy state prevents duplicate requests',async()=>{
  let resolve;const a=await ready({native:true,store:makeStorage(stateSeed()),purchase:()=>new Promise(r=>resolve=r)});a.go('full_access');a.go('@purchase');a.go('@purchase');await tick();assert.equal(a.calls.filter(c=>c.action==='purchase').length,1);assert.equal(a.state().subscriptionBusy,true);assert.equal(a.e['.th-options'].children[0].disabled,true);
  resolve({...inactive(),outcome:'cancelled'});await tick();assert.equal(a.state().subscriptionBusy,false);assert.equal(a.e['.th-options'].children[0].disabled,false);
 });
 await test('Premium reading progress resumes across native relaunch without claiming a fix',async()=>{
  const a=await ready({native:true,store:makeStorage(stateSeed()),subscription:active()}),g=a.c.qa.data.advanced[0];a.go('@browse_guide',{guideId:g.id,guideStep:0,browsing:true});a.click('Open advanced guide');assert.equal(a.state().current,'guide_step');a.click(g.steps[0].successLabel);await tick();assert.equal(a.state().facts.guideStep,1);assert.equal(a.state().guideProgress[g.id].done,false);
  const b=await ready({native:true,store:a.store,subscription:active()});b.go('@member_home');b.click('Continue your guide');assert.equal(b.state().current,'guide_step');assert.equal(b.state().facts.guideStep,1);assert.equal(b.heading(),g.steps[1].title);
  b.click(g.steps[1].failureLabel);b.click('View support summary');assert.equal(b.state().current,'guide_summary');assert(b.e['.ls-guide-summary'].textContent.includes('A fix has not been confirmed.'));b.e['.ls-share-summary'].click();await tick();assert(b.calls.some(c=>c.action==='shareSummary'&&c.payload.text.includes(g.steps[1].failureLabel)));
  const locked=await ready({native:true,store:a.store,subscription:inactive()});locked.go('@member_home');assert.equal(locked.state().current,'full_access');assert.equal(locked.state().hasFullAccess,false);
 });
 await test('Settings include privacy, support and confirmed local data erasure',async()=>{
  const seed=stateSeed();seed.savedProfiles=[{category:'mobile',brand:'Apple',modelId:'iphone-15',modelLabel:'iPhone 15',software:'iOS',catalogComplete:true,nickname:'Private phone'}];
  const a=await ready({native:true,store:makeStorage(seed),subscription:active()});a.e['.ls-settings-menu'].click();assert.equal(a.state().current,'settings');a.click('Privacy');assert.equal(a.state().current,'privacy');assert(a.e['.th-detail'].textContent.includes('on this device'));a.go('support_info');a.click('Email Loop');assert.equal(a.window.location.href,'mailto:support@example.test');
  a.go('erase_data');a.click('Keep my data');assert.equal(a.state().profiles.length,1);a.go('erase_data');assert(a.e['.ls-guide-scope'].textContent.includes('subscription is not cancelled'));a.click('Erase my saved data');await tick();assert(a.calls.some(c=>c.action==='clearState'));assert.equal(a.state().current,'welcome');assert.equal(a.state().profiles.length,0);assert.equal(Object.keys(a.state().guideProgress).length,0);assert.equal(a.state().language,'en');assert.equal(a.state().hasFullAccess,true);
  const b=await ready({native:true,store:a.store,subscription:active()});assert.equal(b.state().current,'welcome');assert.equal(b.state().profiles.length,0);assert.equal(b.state().hasFullAccess,true);
 });
 await test('57 free guide graphs and 14 premium introductions remain available',async()=>{
  const a=await ready({native:true,store:makeStorage(stateSeed())}),{free,advanced,catalog}=a.c.qa.data;assert.equal(free.length,57);assert.equal(advanced.length,14);
  const terminal=new Set(['@success','@support','@advanced']);
  for(const g of free){const ids=new Set(g.steps.map(s=>s.id));assert.equal(ids.size,g.steps.length,g.id);for(const s of g.steps){assert(s.body&&s.choices.length,g.id);for(const choice of s.choices)assert(terminal.has(choice.to)||ids.has(choice.to),`${g.id}/${s.id} broken branch`);}const reachable=new Set();function visit(id){if(reachable.has(id)||terminal.has(id))return;reachable.add(id);g.steps.find(s=>s.id===id).choices.forEach(c=>visit(c.to));}visit(g.steps[0].id);assert.equal(reachable.size,g.steps.length,g.id+' unreachable steps');
   let matched=null;for(const [category,brands] of Object.entries(catalog)){for(const brand of brands){for(const model of brand.models){if(model.availability==='coming-soon')continue;const variants=[];for(const software of model.software){if(software==='Windows')variants.push({software:'Windows 11'},{software:'Windows 10'});else if(category==='printer')variants.push(...['Windows 11','Windows 10','macOS'].map(x=>({software:x,printingApp:software,sourcePlatform:'desktop'})),{software:'Mobile print app',printingApp:software,sourcePlatform:'mobile'});else variants.push({software:software==='TV settings'&&brand.brand==='Samsung'?'Samsung Smart TV':software});}for(const variant of variants){const facts={category,brand:brand.brand,modelId:model.id,modelLabel:model.label,catalogComplete:true,...variant};a.c.qa.setFacts(facts);if(a.c.qa.freeMatch(g)){matched=facts;break;}}if(matched)break;}if(matched)break;}if(matched)break;}
   assert(matched,g.id+' has no matching catalogue profile');a.c.qa.setFacts(matched);a.go('basic_issues');a.click(g.title);assert.equal(a.state().current,'basic_step');assert.equal(a.heading(),g.steps[0].title);
  }
  for(const g of advanced){assert(g.scope&&g.sourceUrl.startsWith('https://')&&g.steps.length,g.id);a.go('guide_library');const card=a.e['.th-options'].children.find(b=>a.label(b).startsWith(g.title));assert(card,g.id+' missing from library');card.click();assert.equal(a.state().current,'advanced_intro');assert(a.e['.th-options'].children[0].textContent.includes('$49.99'));assert(!a.e['.th-detail'].textContent.includes(g.steps[0].body));}
 });
 console.log(`Consumer controller: ${results.length} checks passed. This validates logic and routes; iPhone layout, StoreKit sandbox and signing still require Xcode/device verification.`);
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
