import { loadScripts } from '../tests/browser-scripts.mjs';
const store={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
const page = loadScripts(['js/Constants.js','libs/simplex-noise.js','js/Content.js','js/Logic.js'], { localStorage: store });
const WB = page.get('WB'); WB.Save.load();
const run = new WB.Run({ seed: 20268640, region: 0 });
const p = run.player, r = run.region;
console.log('player at', Math.round(p.x), Math.round(p.y), 'hp', p.hp, 'speed', Math.round(p.stats.speed));
console.log('castles:');
for (const c of r.castles) if (c!==p) console.log('  ', c.kind, 'tier',c.tier, 'hp',Math.round(c.hp), 'at', Math.round(c.x),Math.round(c.y), 'dist', Math.round(WB.M.dist(c.x,c.y,p.x,p.y)), 'mods', c.modules.map(m=>m.mod.short+'L'+m.level).join(','));
console.log('knights:', r.entities.filter(e=>e.type==='knight').map(k=>Math.round(WB.M.dist(k.x,k.y,p.x,p.y))).join(' '));
console.log('villages:', r.entities.filter(e=>e.type==='village').map(v=>Math.round(WB.M.dist(v.x,v.y,p.x,p.y))).join(' '));
const bySrc={};
const orig = run.damage.bind(run);
run.damage=(e,a,o)=>{ if(e===p){const k=(o&&o.kind)||'?'; bySrc[k]=(bySrc[k]||0)+a;} return orig(e,a,o); };
for (let i=0;i<60*14 && !run.over;i++){
  run.update(1/60,{throttle:1,steer:0.3,boost:false});
  if(i%60===0) console.log('t='+(i/60)+'s hp',Math.round(p.hp),'pos',Math.round(p.x)+','+Math.round(p.y),'threat',JSON.stringify(run.threat(900).hunters),'near',run.threat(900).near?run.threat(900).near.kind:'-');
}
console.log('damage by kind:', JSON.stringify(Object.fromEntries(Object.entries(bySrc).map(e=>[e[0],Math.round(e[1])]))));
