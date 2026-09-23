import { loadScripts } from '../tests/browser-scripts.mjs';
const store={_d:{},getItem(k){return this._d[k]??null},setItem(k,v){this._d[k]=String(v)},removeItem(k){delete this._d[k]}};
const page = loadScripts(['js/Constants.js','libs/simplex-noise.js','js/Content.js','js/Logic.js'], { localStorage: store });
const WB = page.get('WB'); WB.Save.load();
const run = new WB.Run({ seed: 7, region: 0 });
const r = run.region;
const p = run.player;
const f = r.entities.find(e=>e.type==='castle' && e.kind==='fortress');
console.log('fortress found', !!f, 'dist', Math.round(WB.M.dist(p.x,p.y,f.x,f.y)));
f.x = p.x + 300; f.y = p.y; p.heading = 0;
console.log('module0', JSON.stringify({id:p.modules[0].mod.id, slot:p.modules[0].slot, cd:p.modules[0].cd, aim:p.modules[0].aim, n:p.modules.length}));
const st = p.stats;
console.log('stats.range', st.range, 'reach stat', WB.moduleStat(p.modules[0].mod,1,'reach'));
for (let i=0;i<20;i++){
  run.update(1/60,{throttle:0,steer:0,boost:false});
  f.x = p.x + 300; f.y = p.y;
  const tgt = run.findTarget(p, p.modules[0], WB.moduleStat(p.modules[0].mod,1,'reach')*st.range);
  const m0=p.modules[0];
  const dev = WB.M.angleDelta(p.heading + WB.SLOT_ANGLE(m0.slot, p.modules.length), m0.aim||0);
  console.log('f',i,'cd',m0.cd.toFixed(3),'aim',(m0.aim||0).toFixed(3),'dev',dev.toFixed(3),'dist',Math.round(WB.M.dist(p.x,p.y,f.x,f.y)),'target',tgt?tgt.type:'NONE','proj',run.projectiles.length,'ev',run.events.map(e=>e.type).join(','));
}
