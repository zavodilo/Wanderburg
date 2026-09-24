// create-arcengine: the scaffold copies the kit, overlays the starter and regenerates
// the agent skill copies inside the target. No network, no npm — pure fs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from './browser-scripts.mjs';

const cli = (args) => spawnSync(process.execPath, ['tools/create-arcengine.mjs', ...args],
    { cwd: ROOT, encoding: 'utf8' });

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'arc-scaffold-'));
// create-arcengine.mjs does not copy scaffold/ into a generated game, so these tests have
// nothing to run on there: skip instead of failing a game's check.mjs with ENOENT.
const NO_SCAFFOLD = !fs.existsSync(path.join(ROOT, 'scaffold', 'starters'))
    ? 'scaffold/ не поставляется в собранные игры (create-arcengine исключает его)'
    : false;

test('скаффолд: survival-стартер копирует набор, оверлей и скиллы агентов', { skip: NO_SCAFFOLD }, () => {
    const dir = tmp();
    const r = cli([dir, '--starter', 'survival']);
    assert.equal(r.status, 0, r.stderr);
    for (const f of ['index.html', 'js/engine/World3D.js', 'js/core/SceneAPI.js', 'js/core/SceneSchema.js',
        'libs/playcanvas.min.js', 'assets/models/character.glb', '_utils/editor/server.mjs',
        'tools/check.mjs', 'claude/skills/world3d/SKILL.md', 'claude/vendor/playcanvas/LICENSE',
        'AGENTS.md', '.agents/skills/world3d/SKILL.md', '.claude/skills/world3d/SKILL.md',
        '.cursor/rules/arcengine.mdc', 'STARTER.md', 'LICENSE', 'NOTICE']) {
        assert.ok(fs.existsSync(path.join(dir, f)), f);
    }
    const game = fs.readFileSync(path.join(dir, 'js/Game.js'), 'utf8');
    assert.match(game, /survival starter/);
    assert.match(game, /Scene\.spawn/);
    const objects = fs.readFileSync(path.join(dir, 'js/Objects.js'), 'utf8');
    assert.match(objects, /hero/);
    // the target is self-sufficient: its own sync-skills runs from its own tools/
    const check = spawnSync(process.execPath, ['tools/sync-skills.mjs', '--check'], { cwd: dir, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
});

// The scaffolded game is a DIFFERENT project than the kit sample: its own id, its own variants,
// and its own test run. Regression: the sample's project.json/variants used to travel with the
// scaffold, so a new game presented itself as "ArcEngine Sample" and the kit's pipeline tests
// (which are copied into it) failed out of the box.
test('скаффолд: проект получает СВОЮ презентацию и проходит собственные тесты пайплайна', { skip: NO_SCAFFOLD }, () => {
    const dir = tmp();
    const r = cli([dir, '--starter', 'survival']);
    assert.equal(r.status, 0, r.stderr);
    const spec = fs.readFileSync(path.join(dir, 'js', 'GameSpec.js'), 'utf8');
    const id = /id:\s*'([a-z0-9-]+)'/.exec(spec)[1];
    const project = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    assert.equal(project.id, id, 'project.json is the starter project, not the kit sample');
    assert.notEqual(project.id, 'arcengine-sample');
    const variants = fs.readdirSync(path.join(dir, 'presentation', 'variants')).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')).sort();
    assert.equal(variants.length, 5, 'one variant per render profile');
    assert.deepEqual(variants, project.variants.slice().sort());
    for (const v of variants) assert.ok(v.startsWith(id + '-'), v + ' belongs to the project ' + id);
    assert.ok(project.defaultVariant && project.defaultVariant.startsWith(id + '-'), 'the default variant is the project\'s own');
    // no drift: the generated runtime file matches the disk canon
    const check = spawnSync(process.execPath, ['tools/variants.mjs', '--check'], { cwd: dir, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    // and the copied pipeline tests pass in the new project as they are
    const tests = spawnSync(process.execPath, ['--test', 'tests/variants.test.mjs', 'tests/core-model.test.mjs', 'tests/pipeline-layers.test.mjs'],
        { cwd: dir, encoding: 'utf8' });
    assert.equal(tests.status, 0, (tests.stdout || '').split('\n').filter(l => /^not ok/.test(l)).join('\n') + tests.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('скаффолд: empty + --no-skills — без копий агентов, сцена пуста', { skip: NO_SCAFFOLD }, () => {
    const dir = tmp();
    const r = cli([dir, '--starter', 'empty', '--no-skills']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(dir, '.agents')), '.agents не создан с --no-skills');
    assert.ok(!fs.existsSync(path.join(dir, 'AGENTS.md')));
    const objects = fs.readFileSync(path.join(dir, 'js/Objects.js'), 'utf8');
    // the starter's Objects.js is what the editor's formatter writes (formatObjects([])):
    // an empty list spans two lines there, so accept whitespace inside the brackets
    assert.match(objects, /LOCATION_OBJECTS = \[\s*\]/);
    const game = fs.readFileSync(path.join(dir, 'js/Game.js'), 'utf8');
    assert.match(game, /empty starter/);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('скаффолд: непустая цель без --overwrite отклоняется', { skip: NO_SCAFFOLD }, () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'x');
    const r = cli([dir]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not empty/);
    fs.rmSync(dir, { recursive: true, force: true });
});
