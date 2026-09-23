// ============================================================================
//  Wanderburg — generate js/UILayout.js in the editor's byte-exact format
// ----------------------------------------------------------------------------
//  node tools/make-ui.mjs
//
//  The kit's tests/ui.test.mjs asserts that js/UILayout.js reproduces exactly what the web
//  editor's formatUI() would write (so the editor can round-trip the file). Hand-writing it is
//  a trap: one space or one digit of precision off and `node tools/check.mjs` fails. So the
//  layout is described HERE, as records, and written through the editor's own formatter.
//
//  To change the HUD: edit the records below and re-run this tool (or drag the elements in the
//  editor's UI tab — it writes the same file).
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { formatUI } from '../_utils/editor/save.mjs';

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'js', 'UILayout.js');

const T = (id, anchor, x, y, text, fontSize, color, extra) =>
    Object.assign({ id, kind: 'text', anchor, x, y, text, fontSize, color, shadow: '#120e0a', alpha: 1, visible: 1 }, extra || {});
const P = (id, anchor, x, y, w, h, fill, extra) =>
    Object.assign({ id, kind: 'panel', anchor, x, y, w, h, fill, border: '', radius: 8, alpha: 0.8, visible: 1 }, extra || {});
const B = (id, anchor, x, y, w, h, value, color, fill, extra) =>
    Object.assign({ id, kind: 'bar', anchor, x, y, w, h, value, color, fill, border: '', radius: Math.round(h / 2), alpha: 1, visible: 1 }, extra || {});
const K = (id, anchor, x, y, w, h, text, fill, extra) =>
    Object.assign({ id, kind: 'button', anchor, x, y, w, h, text, fontSize: 15, color: '#f6efe0', fill, border: '', radius: 8, alpha: 1, visible: 1 }, extra || {});

// Palette (matches WB.PAL / the CSS in index.html)
const INK = '#171310';        // panel background
const INK2 = '#241d17';       // lighter panel
const PAPER = '#f0e6d2';      // text
const GOLD = '#d8ab52';
const RED = '#a83a2c';
const GREEN = '#5f9e4a';
const STEEL = '#6f767e';
const ARCANE = '#63c8e8';

const layout = [
    // =============================== TITLE =============================================
    T('titleBig', 'middle-center', 0, -186, 'WANDERBURG', 66, GOLD, { shadow: '#1a1208' }),
    T('titleSub', 'middle-center', 0, -122, 'Замок на колёсах пожирает долину', 17, PAPER, { alpha: 0.85 }),
    T('titleVer', 'middle-center', 0, -98, 'v1.0.0 · ArcEngine · PlayCanvas 2', 11, PAPER, { alpha: 0.45 }),
    K('btnStart', 'middle-center', -210, -46, 200, 50, 'В ПОХОД', GREEN),
    K('btnLoadout', 'middle-center', 10, -46, 200, 50, 'СНАРЯЖЕНИЕ', STEEL),
    K('btnLegacy', 'middle-center', -210, 16, 200, 46, 'НАСЛЕДИЕ', INK2),
    K('btnHelp', 'middle-center', 10, 16, 200, 46, 'ПРАВИЛА И КЛАВИШИ', INK2),
    K('btnSettings', 'middle-center', 0, 84, 200, 40, 'НАСТРОЙКИ', INK2, { fontSize: 13 }),
    T('titleScrap', 'middle-center', 0, 142, 'ЛОМ: 0', 15, GOLD),
    T('titleStats', 'middle-center', 0, 166, '', 12, PAPER, { alpha: 0.6 }),
    T('titleHint', 'bottom-center', 0, 22, 'Колесо — приблизить · Правая кнопка мыши — осмотреться', 11, PAPER, { alpha: 0.45 }),

    // =============================== LOADOUT ===========================================
    T('loadTitle', 'top-center', 0, 22, 'СНАРЯЖЕНИЕ', 25, GOLD),
    P('loadChassisP', 'top-left', 60, 76, 560, 250, INK, { radius: 12, border: '#3a2f24' }),
    T('loadChassisH', 'top-left', 80, 92, 'КОРПУС', 14, PAPER, { alpha: 0.6 }),
    T('loadChassisN', 'top-left', 80, 118, '', 21, GOLD),
    T('loadChassisD', 'top-left', 80, 152, '', 13, PAPER, { alpha: 0.9 }),
    T('loadChassisS', 'top-left', 80, 236, '', 13, ARCANE),
    K('loadChassisB', 'top-left', 400, 268, 200, 42, 'ДРУГОЙ КОРПУС  ▸', INK2),
    P('loadCaptainP', 'top-left', 660, 76, 560, 250, INK, { radius: 12, border: '#3a2f24' }),
    T('loadCaptainH', 'top-left', 680, 92, 'КАПИТАН', 14, PAPER, { alpha: 0.6 }),
    T('loadCaptainN', 'top-left', 680, 118, '', 21, GOLD),
    T('loadCaptainD', 'top-left', 680, 152, '', 13, PAPER, { alpha: 0.9 }),
    K('loadCaptainB', 'top-left', 1000, 268, 200, 42, 'ДРУГОЙ КАПИТАН  ▸', INK2),
    T('loadSeed', 'top-center', 0, 350, '', 13, PAPER, { alpha: 0.6 }),
    K('btnRoll', 'middle-center', -320, 250, 190, 44, 'НОВЫЙ СИД', INK2),
    K('btnGo', 'middle-center', -95, 244, 190, 56, 'В ДОЛИНУ', GREEN),
    K('btnBackLoad', 'middle-center', 130, 250, 190, 44, '◂  НАЗАД', INK2),

    // =============================== LEGACY ============================================
    T('legTitle', 'top-center', 0, 22, 'НАСЛЕДИЕ', 25, GOLD),
    T('legScrap', 'top-center', 0, 56, '', 15, PAPER),
    P('legListP', 'top-center', 0, 88, 920, 430, INK, { radius: 12, border: '#3a2f24' }),
    T('legList', 'top-left', 200, 104, '', 13, PAPER),
    T('legHint', 'top-center', 0, 536, '↑ / ↓ — выбрать · Enter — купить · Esc — назад', 12, PAPER, { alpha: 0.6 }),
    K('legUp', 'top-left', 1150, 120, 60, 40, '▲', INK2),
    K('legDown', 'top-left', 1150, 176, 60, 40, '▼', INK2),
    K('legBuy', 'top-left', 1130, 240, 100, 46, 'КУПИТЬ', GREEN),
    K('legBack', 'top-left', 1130, 300, 100, 42, 'НАЗАД', INK2),
    K('legWipe', 'bottom-left', 24, 24, 210, 40, 'СБРОСИТЬ ПРОГРЕСС', RED, { alpha: 0.75, fontSize: 12 }),

    // =============================== SETTINGS ==========================================
    T('setTitle', 'top-center', 0, 26, 'НАСТРОЙКИ', 25, GOLD),
    P('setPanel', 'top-center', 0, 84, 560, 300, INK, { radius: 12, border: '#3a2f24' }),
    T('setList', 'top-left', 380, 108, '', 14, PAPER),
    K('setPrev', 'top-center', -180, 300, 120, 44, '◂', INK2),
    K('setNext', 'top-center', 60, 300, 120, 44, '▸', INK2),
    K('setBack', 'top-center', 0, 420, 200, 46, 'НАЗАД', STEEL),

    // =============================== HELP ==============================================
    T('helpTitle', 'top-center', 0, 20, 'ПРАВИЛА И КЛАВИШИ', 25, GOLD),
    P('helpPanel', 'top-center', 0, 62, 980, 500, INK, { radius: 12, border: '#3a2f24' }),
    T('helpText', 'top-left', 170, 82, '', 13, PAPER),
    K('helpBack', 'top-center', 0, 596, 200, 44, 'НАЗАД', STEEL),

    // =============================== RUN END ===========================================
    P('endDim', 'middle-center', 0, 0, 1280, 720, '#0b0908', { alpha: 0.78, radius: 0, visible: 0 }),
    T('endTitle', 'middle-center', 0, -196, '', 46, RED),
    P('endPanel', 'middle-center', 0, -40, 620, 250, INK, { radius: 12, border: '#3a2f24', alpha: 0.92 }),
    T('endStats', 'middle-center', 0, -120, '', 15, PAPER),
    T('endMods', 'middle-center', 0, 40, '', 12, PAPER, { alpha: 0.75 }),
    T('endScrap', 'middle-center', 0, 96, '', 16, GOLD),
    K('endAgain', 'middle-center', -215, 168, 200, 50, 'ЕЩЁ РАЗ', GREEN),
    K('endMenu', 'middle-center', 15, 168, 200, 50, 'В МЕНЮ', INK2),

    // =============================== VICTORY ===========================================
    T('winTitle', 'middle-center', 0, -200, 'ЖЕЛЕЗНЫЙ ВЕНЕЦ ПОВЕРЖЕН', 40, GOLD),
    T('winText', 'middle-center', 0, -140, '', 16, PAPER),
    K('winEndless', 'middle-center', -215, 168, 200, 50, 'ПРОДОЛЖИТЬ ПОХОД', GREEN),
    K('winMenu', 'middle-center', 15, 168, 200, 50, 'В МЕНЮ', INK2),

    // =============================== DRAFT =============================================
    P('draftDim', 'middle-center', 0, 0, 1280, 720, '#0b0908', { alpha: 0.74, radius: 0, visible: 0 }),
    T('draftTitle', 'top-center', 0, 74, 'ЧЕРТЁЖ', 32, GOLD),
    T('draftSub', 'top-center', 0, 122, '', 14, PAPER, { alpha: 0.85 }),
    // card 1..4 (x = -496 + i*252) — the panel, then its texts and button
    P('cardP1', 'top-left', 144, 168, 236, 292, INK2, { radius: 12, border: '#4a3b2a', visible: 0 }),
    T('cardN1', 'top-left', 160, 186, '', 17, GOLD),
    T('cardL1', 'top-left', 160, 214, '', 11, ARCANE, { alpha: 0.9 }),
    T('cardD1', 'top-left', 160, 238, '', 12, PAPER, { alpha: 0.85 }),
    T('cardS1', 'top-left', 160, 352, '', 12, PAPER, { alpha: 0.8 }),
    K('cardB1', 'top-left', 160, 404, 204, 40, 'ВЗЯТЬ  [1]', GREEN, { visible: 0 }),
    P('cardP2', 'top-left', 396, 168, 236, 292, INK2, { radius: 12, border: '#4a3b2a', visible: 0 }),
    T('cardN2', 'top-left', 412, 186, '', 17, GOLD),
    T('cardL2', 'top-left', 412, 214, '', 11, ARCANE, { alpha: 0.9 }),
    T('cardD2', 'top-left', 412, 238, '', 12, PAPER, { alpha: 0.85 }),
    T('cardS2', 'top-left', 412, 352, '', 12, PAPER, { alpha: 0.8 }),
    K('cardB2', 'top-left', 412, 404, 204, 40, 'ВЗЯТЬ  [2]', GREEN, { visible: 0 }),
    P('cardP3', 'top-left', 648, 168, 236, 292, INK2, { radius: 12, border: '#4a3b2a', visible: 0 }),
    T('cardN3', 'top-left', 664, 186, '', 17, GOLD),
    T('cardL3', 'top-left', 664, 214, '', 11, ARCANE, { alpha: 0.9 }),
    T('cardD3', 'top-left', 664, 238, '', 12, PAPER, { alpha: 0.85 }),
    T('cardS3', 'top-left', 664, 352, '', 12, PAPER, { alpha: 0.8 }),
    K('cardB3', 'top-left', 664, 404, 204, 40, 'ВЗЯТЬ  [3]', GREEN, { visible: 0 }),
    P('cardP4', 'top-left', 900, 168, 236, 292, INK2, { radius: 12, border: '#4a3b2a', visible: 0 }),
    T('cardN4', 'top-left', 916, 186, '', 17, GOLD),
    T('cardL4', 'top-left', 916, 214, '', 11, ARCANE, { alpha: 0.9 }),
    T('cardD4', 'top-left', 916, 238, '', 12, PAPER, { alpha: 0.85 }),
    T('cardS4', 'top-left', 916, 352, '', 12, PAPER, { alpha: 0.8 }),
    K('cardB4', 'top-left', 916, 404, 204, 40, 'ВЗЯТЬ  [4]', GREEN, { visible: 0 }),
    K('draftReroll', 'bottom-center', -120, 132, 220, 42, 'СМЕНИТЬ ВЫБОР', INK2, { visible: 0 }),
    K('draftSkip', 'bottom-center', 120, 132, 220, 42, 'ПРОПУСТИТЬ', INK2, { visible: 0 }),
    T('draftNote', 'bottom-center', 0, 96, '', 12, PAPER, { alpha: 0.6, visible: 0 }),

    // =============================== PAUSE =============================================
    T('pauseTitle', 'middle-center', 0, -120, 'ПАУЗА', 34, GOLD, { visible: 0 }),
    K('pauseResume', 'middle-center', 0, -46, 240, 48, 'ПРОДОЛЖИТЬ', GREEN, { visible: 0 }),
    K('pauseRestart', 'middle-center', 0, 14, 240, 44, 'НАЧАТЬ ЗАНОВО', INK2, { visible: 0 }),
    K('pauseSettings', 'middle-center', 0, 68, 240, 44, 'НАСТРОЙКИ', INK2, { visible: 0 }),
    K('pauseMenu', 'middle-center', 0, 122, 240, 44, 'ВЫЙТИ В МЕНЮ', RED, { visible: 0 }),

    // =============================== IN-RUN HUD ========================================
    P('hudPanel', 'top-left', 12, 12, 292, 100, INK, { radius: 10, alpha: 0.68, border: '#3a2f24' }),
    T('hudTier', 'top-left', 24, 20, '', 15, GOLD),
    B('hudHull', 'top-left', 24, 46, 240, 13, 1, '#6aa84f', '#20241c'),
    B('hudSteam', 'top-left', 24, 64, 240, 8, 1, '#8fb6c9', '#20241c'),
    B('hudMass', 'top-left', 24, 78, 240, 8, 0, '#c9a24a', '#20241c'),
    T('hudMassTxt', 'top-left', 24, 92, '', 11, PAPER, { alpha: 0.75 }),
    T('hudRegion', 'top-center', 0, 14, '', 15, PAPER, { alpha: 0.9 }),
    T('hudObjective', 'top-center', 0, 38, '', 12, GOLD, { alpha: 0.9 }),
    T('hudScrap', 'top-center', 0, 58, '', 11, PAPER, { alpha: 0.6 }),
    P('bossPanel', 'top-center', 0, 82, 560, 34, INK, { alpha: 0.72, radius: 8, border: '#5a2a20', visible: 0 }),
    B('bossBar', 'top-center', 0, 88, 540, 11, 1, '#c0392b', '#241a18', { visible: 0 }),
    T('bossName', 'top-center', 0, 102, '', 12, '#f0c0b0', { visible: 0 }),
    P('minimap', 'top-right', 14, 14, 168, 168, '#141a14', { radius: 10, alpha: 0.82, border: '#3a2f24' }),
    T('threat', 'middle-right', 20, -40, '', 14, '#ff8a6a', { visible: 0 }),
    P('toastPanel', 'bottom-center', 0, 96, 720, 30, INK, { radius: 15, alpha: 0, visible: 0 }),
    T('toast', 'bottom-center', 0, 102, '', 14, PAPER, { alpha: 0, visible: 0 }),
    T('hintBar', 'bottom-left', 16, 16, '', 11, PAPER, { alpha: 0.45 }),
    T('fps', 'bottom-right', 14, 14, '', 11, PAPER, { alpha: 0.4 }),
    P('joyBase', 'bottom-left', 44, 44, 132, 132, '#1b1712', { radius: 66, alpha: 0, visible: 0 }),
    K('btnBoost', 'bottom-right', 40, 60, 116, 116, 'ПАР', RED, { radius: 58, alpha: 0, visible: 0, fontSize: 17 })
];

const r = formatUI(layout);
if (!r.ok) {
    console.error('make-ui: формат отклонён — ' + JSON.stringify(r));
    process.exit(1);
}
fs.writeFileSync(OUT, r.src, 'utf8');
console.log('make-ui: js/UILayout.js — ' + r.count + ' элементов (' + r.src.length + ' байт)');
