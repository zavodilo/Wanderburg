import { loadScripts } from '../tests/browser-scripts.mjs';
const store={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
const page = loadScripts(['js/Constants.js','libs/simplex-noise.js','js/Content.js','js/Logic.js'], { localStorage: store });
const WB = page.get('WB'); WB.Save.load();
const run = new WB.Run({ seed: 20260923, region: 0 });
const p = run.player;
const bySrc = {};
const orig = run.damage.bind(run);
run.damage = (e, amount, o) => {
  if (e === p) { const k = (o && o.kind) || '?'; bySrc[k] = (bySrc[k]||0) + amount; }
  return orig(e, amount, o);
};
let last = p.hp;
for (let i=0;i<60*20 && !run.over;i++){
  run.update(1/60,{throttle:1,steer:Math.sin(i/90)*0.7,boost:i%600>480});
  if (run.draftPending) run.takeDraft(0);
  const d = last - p.hp; last = p.hp;
  if (i%120===0) console.log('t='+(i/60).toFixed(0)+'s hp',Math.round(p.hp),'/',p.maxHp,'tier',p.tier,'mods',p.modules.map(m=>m.mod.id+':'+m.level).join(','),'pos',Math.round(p.x)+','+Math.round(p.y),'h',p.h.toFixed(0),'speed',Math.round(p.speed));
}
console.log('damage taken by kind:', Object.entries(bySrc).sort((a,b)=>b[1]-a[1]).map(e=>e[0]+'='+Math.round(e[1])).join(' '));
console.log('total', Math.round(Object.values(bySrc).reduce((a,b)=>a+b,0)), 'hp', Math.round(p.hp), 'over', run.over);
