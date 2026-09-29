'use strict';
// Build-time scope, identical for every user. The original cross-platform source
// remains in app/fragment.html; it is never copied into the iOS bundle.
const fs=require('node:fs'), vm=require('node:vm');
const original=fs.readFileSync(process.argv[2],'utf8');
const script=original.match(/<script>([\s\S]*?)<\/script>/)[1];
const marker='(() => {\n  const root';
const start=script.indexOf(marker);
if(start<0)throw new Error('Controller boundary missing');
const ctx={}; vm.createContext(ctx);
vm.runInContext(script.slice(0,start)+';this.data={TECH_CATALOG_META,TECH_CATALOG,FREE_GUIDES,ADVANCED_GUIDES,BRAND_VISUALS,SOFTWARE_VISUALS,PAID_MODEL_GUIDES};',ctx,{timeout:5000});
const data=JSON.parse(JSON.stringify(ctx.data));
const labels={tv:'Apple TV',mobile:'iPhone & iPad',laptop:'MacBook',desktop:'Mac desktops',apps:'iCloud',other:'Apple Watch & AirPods'};
for(const category of Object.keys(data.TECH_CATALOG)) {
 const brands=data.TECH_CATALOG[category].filter(b=>b.brand==='Apple');
 if(brands.length)data.TECH_CATALOG[category]=brands;else delete data.TECH_CATALOG[category];
}
for(const key of ['FREE_GUIDES','ADVANCED_GUIDES']) data[key]=data[key].filter(g=>g.brands?.includes('Apple'));
data.BRAND_VISUALS={Apple:data.BRAND_VISUALS.Apple};
data.SOFTWARE_VISUALS=Object.fromEntries(Object.entries(data.SOFTWARE_VISUALS).filter(([k])=>/^(iOS|iPadOS|macOS|tvOS|watchOS|iCloud|Apple)/.test(k)));
for(const groups of Object.values(data.TECH_CATALOG))for(const group of groups)for(const model of group.models) model.software=model.software.filter(x=>! /Android|Windows|ChromeOS|Linux/.test(x));
for(const guide of data.FREE_GUIDES)if(guide.id==='free-airpods-connect')guide.scope='AirPods earbuds connecting to iPhone or iPad. Use the official Apple guide for other supported Apple devices.';
const ids=new Set(data.ADVANCED_GUIDES.map(g=>g.id));
data.PAID_MODEL_GUIDES=Object.fromEntries(Object.entries(data.PAID_MODEL_GUIDES).map(([k,v])=>[k,v.filter(id=>ids.has(id))]).filter(([,v])=>v.length));
data.TECH_CATALOG_META.coverage='Apple devices and software';
let body=script.slice(start);
// Evaluate only the static, pure node definitions, then compile a smaller map.
const nodeStart=body.indexOf('  const nodes = {');
const nodeEnd=body.indexOf('  // Catalogues and guides');
const nodeCtx={};vm.createContext(nodeCtx);
vm.runInContext(body.slice(nodeStart,nodeEnd)+';this.result=nodes;',nodeCtx,{timeout:1000});
const nodes=JSON.parse(JSON.stringify(nodeCtx.result));
const disallowed=/Netflix|Android|Windows|Chromebook|ChromeOS|HP|Samsung|Google|Canon|Epson|Brother|Xbox|PlayStation|Nintendo/;
for(const [key,node] of Object.entries(nodes)) if(disallowed.test(JSON.stringify(node)))delete nodes[key];
const route={tv:'tv_types',mobile:'mobile_types',laptop:'laptop_types',desktop:'desktop_types',apps:'apps_types',other:'other_types'};
nodes.start={q:'What needs a little help?',detail:'Choose your Apple device or describe the problem.',choices:Object.entries(labels).map(([category,label])=>[label,route[category],false,{category,brand:'Apple',deviceLabel:label}]),unsure:'choose'};
nodes.choose={q:'What are you trying to do?',detail:'Pick the Apple device or software you need help with.',choices:nodes.start.choices};
for(const [category,key] of Object.entries(route))nodes[key]={q:'Choose your device.',choices:[[labels[category],'@route',false,{category,brand:'Apple'}]]};
// Legacy physical-printer routes are outside this edition.
for(const key of Object.keys(nodes))if(key.startsWith('printer'))delete nodes[key];
for(const node of Object.values(nodes)) {
 if(node.choices)node.choices=node.choices.filter(c=>c[1].startsWith('@')||nodes[c[1]]);
 if(node.unsure&&!nodes[node.unsure])delete node.unsure;
}
body=body.slice(0,nodeStart)+'  const nodes = '+JSON.stringify(nodes)+';\n'+body.slice(nodeEnd);
body=body.replace(/  const categoryLabels=.*?;\n/,'  const categoryLabels='+JSON.stringify(labels)+';\n');
body=body.replace(/  const generalSoftware=.*?;\n/,'  const generalSoftware='+JSON.stringify({tv:['tvOS','Not sure'],mobile:['iOS','iPadOS','Not sure'],laptop:['macOS','Not sure'],desktop:['macOS','Not sure'],apps:['iOS','iPadOS','macOS','Not sure'],other:['Device settings','Not sure']})+';\n');
body=body.replace(/  const PRIMARY_BRANDS=\{[\s\S]*?\n  \};/,'  const PRIMARY_BRANDS='+JSON.stringify(Object.fromEntries(Object.keys(labels).map(k=>[k,['Apple']])) )+';');
body=body.replace("wizardChoice('Another brand',()=>draftAdvance('custom_brand'),{neutral:true});",'');
body=body.replace("wizardChoice('I’m not sure',()=>draftAdvance('model',{brand:'Not sure'}),{neutral:true});",'');
body=body.replace(",select('Another / not sure','catalog_custom',{customKind:'brand'})",'');
// Retain legacy data in storage without exposing unsupported routes in this edition.
body=body.replace('  const savedProfiles=[];', '  const savedProfiles=[]; const retainedProfiles=[]; const retainedProgress={};');
body=body.replace("for(const profile of saved.savedProfiles||[])if(TECH_CATALOG[profile.category]&&typeof profile.modelLabel==='string')savedProfiles.push(cleanProfile(profile));", "for(const profile of saved.savedProfiles||[])if(typeof profile.modelLabel==='string'){if(TECH_CATALOG[profile.category]&&profile.brand==='Apple')savedProfiles.push(cleanProfile(profile));else retainedProfiles.push(cleanProfile(profile));}");
body=body.replace('savedProfiles:savedProfiles.map(cleanProfile),guideProgress,', 'savedProfiles:[...savedProfiles,...retainedProfiles].map(cleanProfile),guideProgress:{...retainedProgress,...guideProgress},');
body=body.replace('if(!guide||!value||!value.facts||!Number.isInteger(value.step))continue;', 'if(!guide){retainedProgress[id]=value;continue;}if(!value||!value.facts||!Number.isInteger(value.step))continue;');
body=body.replace('savedProfiles.splice(0);for(const key', 'savedProfiles.splice(0);retainedProfiles.splice(0);for(const id of Object.keys(retainedProgress))delete retainedProgress[id];for(const key');
// No old device may supply an unsupported resume route.
body=body.replace(/  function legacyRouteProblem\(\)\{[\s\S]*?\n  \}/, "  function legacyRouteProblem(){return 'device_details';}");
body=body.replace(/  function createCategoryArt\(category\)\{[\s\S]*?\n  \}/, "  function createCategoryArt(category){return createBrandSelectionArt(category,'Apple');}");
body=body.replace("detail:'Loop helps you work through everyday technology problems, with a source link and coverage notes for every guide.'", "detail:'Loop provides guided troubleshooting for Apple devices and software. It does not sell parts, book repairs or perform physical repairs.'");
body=body.replace("detail:'Choose your tech, follow small checks, and save your devices for next time. No account needed.'", "detail:'Choose your Apple device, follow small checks, and save it for next time. No account needed. Loop provides troubleshooting guides, not physical repairs or replacement parts.'");
const suggest=`function suggestTechHelp(input){
 if(typeof input!=='string')return [];
 const q=input.toLowerCase();
 const issue=/charg|power|battery/.test(q)?'power':/wi.?fi|connect|bluetooth|internet/.test(q)?'connection':/sound|audio/.test(q)?'sound':/sign|password|account/.test(q)?'signin':/slow|freez/.test(q)?'slow':null;
 const matches=[['mobile','iPhone or iPad',/iphone|ipad|phone|tablet/],['laptop','MacBook',/macbook|laptop/],['desktop','Mac',/imac|mac mini|mac studio|desktop|computer/],['tv','Apple TV',/apple tv/],['apps','iCloud',/icloud|apple account/],['other','Apple Watch or AirPods',/airpods|apple watch/]];
 return matches.filter(([, ,pattern])=>pattern.test(q)).map(([category,deviceLabel])=>({category,brand:'Apple',deviceLabel,issue,label:deviceLabel+(issue?' · '+issue:' · Get help')}));
}\n`;
const compiled=Object.entries(data).map(([k,v])=>'const '+k+' = '+JSON.stringify(v)+';').join('\n')+'\n'+suggest+body;
let result=original.replace(/<script>[\s\S]*?<\/script>/,()=>'<script>\n'+compiled+'\n</script>');
result=result.replace(/e\.g\.[^"<>]*(?:Netflix|printer)[^"<>]*/gi,'e.g. My iPhone cannot connect to Wi-Fi');
fs.writeFileSync(process.argv[3],result);
console.log('Apple edition: '+Object.keys(data.TECH_CATALOG).length+' categories, '+data.FREE_GUIDES.length+' basic guides, '+data.ADVANCED_GUIDES.length+' advanced guides.');
