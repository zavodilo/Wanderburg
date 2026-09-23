// The claude/ folder (skills, launch.json template): linked to CLAUDE.md and reaches the users —
// GitHub web upload skips dot-prefixed names, so skills do not belong in .claude/.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from './browser-scripts.mjs';

const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const SKILLS = fs.readdirSync(path.join(ROOT, 'claude/skills'), { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => `claude/skills/${e.name}/SKILL.md`);

test('скилл из claude/skills/: front matter (name = папка, description), путь в таблице CLAUDE.md', () => {
  assert.ok(SKILLS.length > 0);
  const claudeMd = read('CLAUDE.md');
  for (const rel of SKILLS) {
    const head = read(rel).match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(head, rel + ': нет front matter');
    assert.match(head[1], new RegExp('^name: ' + rel.split('/')[2] + '$', 'm'), rel);
    assert.match(head[1], /^description: \S/m, rel);
    assert.ok(claudeMd.includes('`' + rel + '`'), 'CLAUDE.md не ведёт к ' + rel);
  }
});

test('скиллы написаны на английском: кириллицы в claude/skills/ нет', () => {
  for (const rel of SKILLS) {
    const line = read(rel).split('\n').findIndex(s => /\p{Script=Cyrillic}/u.test(s));
    assert.equal(line, -1, rel + ':' + (line + 1) + ' — кириллица');
  }
});

test('документация ведёт к скиллам в claude/skills/, а не в .claude/, и файлы на месте', () => {
  for (const rel of ['CLAUDE.md', '_utils/README.md', ...SKILLS]) {
    const text = read(rel);
    assert.doesNotMatch(text, /\.claude\/skills\/[\w-]/, rel);
    for (const [ref] of text.matchAll(/claude\/skills\/[\w-]+\/SKILL\.md/g)) {
      assert.ok(fs.existsSync(path.join(ROOT, ref)), rel + ': нет ' + ref);
    }
  }
});

test('claude/launch.json: game и editor запускают серверы набора на своём порту без браузера', () => {
  const { configurations } = JSON.parse(read('claude/launch.json'));
  for (const [name, server] of [['game', 'tools/dev-server.mjs'], ['editor', '_utils/editor/server.mjs']]) {
    const cfg = configurations.find(c => c.name === name);
    assert.ok(cfg, 'нет конфигурации ' + name);
    assert.ok(fs.existsSync(path.join(ROOT, server)), server);
    assert.deepEqual(cfg.runtimeArgs, [server, '--port=' + cfg.port, '--no-open']);
  }
});

// A project scaffolded with --no-skills ships the canon (claude/skills) but deliberately no
// generated agent copies: there is nothing to compare, so skip instead of failing its check.mjs.
const NO_AGENT_COPIES = !fs.existsSync(path.join(ROOT, '.claude', 'skills'))
    ? 'копии агентов не созданы (create-arcengine --no-skills)'
    : false;

test('.claude/skills и .agents/skills — генерированные копии канона (tools/sync-skills.mjs)', { skip: NO_AGENT_COPIES }, () => {
    const r = spawnSync(process.execPath, ['tools/sync-skills.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''));
    for (const name of SKILLS.map(rel => rel.split('/')[2])) {
        for (const target of ['.claude/skills', '.agents/skills']) {
            assert.ok(fs.existsSync(path.join(ROOT, target, name, 'SKILL.md')), target + '/' + name);
            assert.equal(read(target + '/' + name + '/SKILL.md'), read('claude/skills/' + name + '/SKILL.md'));
        }
    }
    const agents = read('AGENTS.md');
    for (const rel of SKILLS) assert.ok(agents.includes('`' + rel.split('/')[2] + '`'), 'AGENTS.md не упоминает ' + rel);
});

test('agent-manifest.json:_machine contract matches the canon (skills, entry points, checks)', () => {
    const m = JSON.parse(read('agent-manifest.json'));
    for (const rel of SKILLS) {
        assert.ok(m.skills.kit.some(s => s.name === rel.split('/')[2]), 'manifest не содержит ' + rel);
    }
    assert.ok(m.skills.vendor.names.length >= 10, 'вендорные скиллы в манифесте');
    assert.ok(m.entryPoints.agents.includes('AGENTS.md'));
    assert.match(m.checks.release, /--all/);
    assert.ok(typeof m.api.scene.length === 'number' && m.api.scene.length > 5);
});
