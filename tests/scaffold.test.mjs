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
    for (const f of ['index.html', 'js/World3D.js', 'js/SceneAPI.js', 'js/SceneSchema.js',
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
