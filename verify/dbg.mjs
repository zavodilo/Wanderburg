import { loadScripts } from '../tests/browser-scripts.mjs';
const store={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
const page = loadScripts(['js/Constants.js','libs/simplex-noise.js','js/Content.js','js/Logic.js'], { localStorage: store });
const WB = page.get('WB'); WB.Save.load();
const run = new WB.Run({ seed: 20260923, region: 0 });
console.log('t0 modules', run.player.modules.length, run.player.modules.map(m=>m.mod.id));
for (let i=0;i<20;i++){
  run.update(1/60,{throttle:1,steer:0,boost:false});
  if (run.draftPending) { console.log('frame',i,'DRAFT', run.draftPending.cards.map(c=>c.kind+':'+c.id)); run.takeDraft(0); }
  if (i%5===0) console.log('frame',i,'modules',run.player.modules.length, run.player.modules.map(m=>m.mod.id+':'+m.level).join(','), 'hp',Math.round(run.player.hp), 'mass',Math.round(run.player.mass), 'tier',run.player.tier);
}
console.log('stats dmg', run.player.stats.dmg, 'range', run.player.stats.range, 'speed', run.player.stats.speed);
