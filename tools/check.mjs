// ============================================================================
//  ArcEngine — code check: types (tsc) and tests (node --test)
// ----------------------------------------------------------------------------
//  node tools/check.mjs            fast: types, tests, generated-canon drift (skills, scene
//                                  manifest, render profiles + project variants)
//  node tools/check.mjs --all      RELEASE GATE: + profile matrix + headless render/visual/variants
//  node tools/check.mjs --types    types only
//  node tools/check.mjs --tests    tests only
//  node tools/check.mjs --skills   generated canon only (skills, manifest, variants drift)
//  node tools/check.mjs --profiles the headless profile/migration matrix (tools/profile-matrix.mjs)
//  node tools/check.mjs --render   headless render gate (puppeteer)
//  node tools/check.mjs --visual   headless visual smoke (puppeteer)
//  node tools/check.mjs --variants every variant in a real browser (puppeteer)
//
//  A flag that matches no step is an ERROR, not a silent pass: `check --profiles` used to run
//  nothing at all and still print "Всё прошло", which is the worst possible answer from a gate.
//
//  Types: TypeScript checks the JS via JSDoc — tsconfig.json (game) and
//  _utils/editor/tsconfig.json (editor). TypeScript is not a project dependency:
//  npx takes it from the npm cache (the first run downloads it). PlayCanvas types —
//  libs/playcanvas.d.ts, own declarations — globals.d.ts. None of this goes into the archive.
//
//  Tests: tests/*.test.mjs — logic without 3D: Store, Terrain3D.heightAt, the asset
//  scanner, the editor's writing of Constants.js and Objects.js (_utils/editor/save.mjs),
//  the link between the claude/skills/ skills and CLAUDE.md.
// ============================================================================
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const TSC = 'npx --yes -p typescript@7.0.2 tsc';

const C = { r: '\x1b[0m', b: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', cyn: '\x1b[36m' };

const STEPS = [
  { flag: '--types', title: 'типы игры', run: () => spawnSync(TSC + ' -p tsconfig.json', { cwd: ROOT, shell: true, stdio: 'inherit' }) },
  { flag: '--types', title: 'типы редактора', run: () => spawnSync(TSC + ' -p _utils/editor/tsconfig.json', { cwd: ROOT, shell: true, stdio: 'inherit' }) },
  { flag: '--tests', title: 'тесты', run: () => spawnSync(process.execPath, ['--test', 'tests/*.test.mjs'], { cwd: ROOT, stdio: 'inherit', shell: true }) },
  { flag: '--skills', title: 'синхронность скиллов', run: () => spawnSync(process.execPath, ['tools/sync-skills.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' }) },
  { flag: '--skills', title: 'манифест сцены', run: () => spawnSync(process.execPath, ['tools/manifest.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' }) },
  // Generated canon, part 3: project.json + js/presentation/Variants.js + presentation/profiles/*
  // must match manifest/render-profiles.json and presentation/variants/*.json on disk.
  { flag: '--skills', title: 'профили и варианты (drift)', run: () => spawnSync(process.execPath, ['tools/render-profiles.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' }) },
  { flag: '--skills', title: 'варианты проекта (drift)', run: () => spawnSync(process.execPath, ['tools/variants.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' }) },
  { flag: '--profiles', title: 'матрица профилей и конверсий', run: () => spawnSync(process.execPath, ['tools/profile-matrix.mjs'], { cwd: ROOT, stdio: 'inherit' }) },
  { flag: '--render', title: 'headless render gate', run: () => spawnSync(process.execPath, ['tools/headless-gate.mjs', '--render'], { cwd: ROOT, stdio: 'inherit' }) },
  { flag: '--visual', title: 'headless visual smoke', run: () => spawnSync(process.execPath, ['tools/headless-gate.mjs', '--visual'], { cwd: ROOT, stdio: 'inherit' }) },
  { flag: '--variants', title: 'варианты в браузере', run: () => spawnSync(process.execPath, ['tools/headless-gate.mjs', '--variants'], { cwd: ROOT, stdio: 'inherit' }) },
];
// --all: the release gate — every step above (render/visual need puppeteer, dev-only).
const ALL = process.argv.includes('--all');

const DEFAULT_STEPS = ['--types', '--tests', '--skills'];
const KNOWN = ['--types', '--tests', '--skills', '--profiles', '--render', '--visual', '--variants'];
// Anything that looks like a flag and is not known is a typo, not a reason to run the defaults.
const passed = process.argv.slice(2).filter(a => a.startsWith('--') && a !== '--json');
for (const f of passed) {
  if (!KNOWN.includes(f) && !ALL) { console.error('check: неизвестный флаг ' + f + ' (известны: ' + KNOWN.join(', ') + ', --all)'); process.exit(1); }
}
const requested = passed.filter(f => KNOWN.includes(f));
const only = ALL ? KNOWN : (requested.length ? requested : DEFAULT_STEPS);
// A requested flag with no step behind it would print a green "all passed" without checking
// anything. Fail loudly instead — that is the whole point of a gate.
for (const f of only) {
  if (!STEPS.some(st => st.flag === f)) { console.error('check: флаг ' + f + ' не запускает ни одной проверки'); process.exit(1); }
}
const failed = [];
console.log('\n' + C.cyn + C.b + '  ArcEngine' + C.r + ' ' + C.dim + '— проверка' + C.r);
for (const step of STEPS) {
  if (only.length && !only.includes(step.flag)) continue;
  console.log('\n' + C.b + '  ' + step.title + C.r);
  const r = step.run();
  if (r.status === 0) {
    console.log('  ' + C.grn + 'ok' + C.r);
  } else {
    failed.push(step.title);
    console.log('  ' + C.red + 'FAIL' + C.r + (r.error ? ' ' + r.error.message : ''));
  }
}
console.log('\n' + (failed.length
  ? C.red + C.b + '  Не прошло: ' + failed.join(', ') + C.r
  : C.grn + C.b + '  Всё прошло.' + C.r) + '\n');
process.exit(failed.length ? 1 : 0);
