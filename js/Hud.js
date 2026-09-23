// Hud.js — everything the player reads and clicks: the title screen, the loadout, the legacy
// (meta-progression) shop, settings, help, the draft of blueprints, pause, the run summary and
// the in-run HUD.
//
// The kit's rule stands: the HUD is DATA. Every element is a record in js/UILayout.js (which the
// web editor's UI tab writes; tools/make-ui.mjs generates it in the editor's byte-exact format),
// and this file only takes elements by id and feeds them — UI.get('hudHull').setValue(hp / max).
// Nothing here positions or styles DOM, and nothing here touches the simulation: js/Game.js
// calls showDraft(run) / updateHud(run, dt) and reads back what the player clicked.
//
// Screens are groups of record ids: Hud.show(name) hides every group but the one asked for.

// The rules and the controls, exactly as the help screen shows them. A const of its own
// (not a property assigned after the literal): the JSDoc check infers an object literal's
// type at the literal, so a late assignment would be invisible to it.
const WANDER_HELP_TEXT = [
    'ЧТО ЭТО',
    '· Замки здесь не обороняются, а ездят. Ваш замок — на колёсах, и он голодный.',
    '· Катайтесь по долине, поглощайте деревни, стада, каменоломни и рудники: это даёт МАССУ.',
    '· Масса повышает СТУПЕНЬ корпуса: больше размер, прочность и слоты под модули.',
    '· На каждой ступени вы получаете ЧЕРТЁЖ — новый модуль или уровень старого.',
    '· Бродячие крепости охотятся за вами и друг за другом. Съешьте почти все — откроются ВРАТА.',
    '· За вратами ждёт ВАРДЕН рубежа. Убейте его — и долина сменится следующей, сложнее.',
    '· Четвёртый рубеж — ЖЕЛЕЗНЫЙ ВЕНЕЦ. Снесите его, чтобы пройти игру; дальше идёт бесконечный поход.',
    '',
    'УПРАВЛЕНИЕ',
    '· W / S или ↑ / ↓ — газ и задний ход.  A / D или ← / → — поворот.',
    '· Shift или Пробел — поддать пару (тратит пар, ускоряет и усиливает таран).',
    '· Правая кнопка мыши — осмотреться.  Колесо — приблизить/отдалить.  R — вернуть камеру.',
    '· 1–4 — взять чертёж, R — сменить выбор, Esc — пропустить выбор или пауза.',
    '· M — звук, H — эта справка, Tab — скрыть интерфейс.',
    '· На телефоне: левый круг — ход и поворот, кнопка ПАР — ускорение.',
    '',
    'ТАКТИКА',
    '· Таран бесплатен: разгон с горы и удар в борт часто выгоднее перестрелки.',
    '· Орудия стреляют сами — вы выбираете, кому быть ближе. Турели крутятся, мортиры нет.',
    '· Обломки съеденного всасываются в корпус: задержитесь на месте побоища.',
    '· Корпус чинится сам, если 7 секунд никто не бьёт. Мастерская чинит прямо в бою.',
    '· Пороховые телеги взрываются. Выстрелите в неё, когда рядом вражеский замок.',
    '· Горы по краю долины непроходимы — пользуйтесь ими как стеной.',
    '· Лом копится между походами: в «Наследии» открывайте чертежи, корпуса и капитанов.'
].join('\n');

/** @satisfies {Record<string, any>} */
const Hud = {
    HELP_TEXT: WANDER_HELP_TEXT,
    SCREENS: {
        title: ['titleBig', 'titleSub', 'titleVer', 'btnStart', 'btnLoadout', 'btnLegacy', 'btnHelp', 'btnSettings', 'titleScrap', 'titleStats', 'titleHint'],
        loadout: ['loadTitle', 'loadChassisP', 'loadChassisH', 'loadChassisN', 'loadChassisD', 'loadChassisS', 'loadChassisB',
            'loadCaptainP', 'loadCaptainH', 'loadCaptainN', 'loadCaptainD', 'loadCaptainB', 'loadSeed', 'btnRoll', 'btnGo', 'btnBackLoad'],
        legacy: ['legTitle', 'legScrap', 'legListP', 'legList', 'legHint', 'legUp', 'legDown', 'legBuy', 'legBack', 'legWipe'],
        settings: ['setTitle', 'setPanel', 'setList', 'setPrev', 'setNext', 'setBack'],
        help: ['helpTitle', 'helpPanel', 'helpText', 'helpBack'],
        end: ['endDim', 'endTitle', 'endPanel', 'endStats', 'endMods', 'endScrap', 'endAgain', 'endMenu'],
        win: ['endDim', 'winTitle', 'winText', 'endPanel', 'endStats', 'endMods', 'endScrap', 'winEndless', 'winMenu'],
        draft: ['draftDim', 'draftTitle', 'draftSub', 'draftReroll', 'draftSkip', 'draftNote',
            'cardP1', 'cardN1', 'cardL1', 'cardD1', 'cardS1', 'cardB1',
            'cardP2', 'cardN2', 'cardL2', 'cardD2', 'cardS2', 'cardB2',
            'cardP3', 'cardN3', 'cardL3', 'cardD3', 'cardS3', 'cardB3',
            'cardP4', 'cardN4', 'cardL4', 'cardD4', 'cardS4', 'cardB4'],
        pause: ['pauseTitle', 'pauseResume', 'pauseRestart', 'pauseSettings', 'pauseMenu'],
        // The in-run HUD is on top of the world in every playing state.
        run: ['hudPanel', 'hudTier', 'hudHull', 'hudSteam', 'hudMass', 'hudMassTxt', 'hudRegion',
            'hudObjective', 'hudScrap', 'minimap', 'hintBar', 'fps']
    },

    /** What is on screen now; js/Game.js reads it to decide whether the world simulates. */
    screen: 'none',
    /** Set by the screens the player navigates with the keyboard (legacy, settings). */
    cursor: 0,
    page: 0,
    setRow: 0,
    /** What the player picked in the loadout screen. */
    chassis: null,
    captain: null,
    seed: 0,
    /** Callbacks js/Game.js installs. */
    on: {},

    // --- plumbing ---------------------------------------------------------------------------
    el(id) { return UI.get(id) || null; },

    text(id, s) { const e = this.el(id); if (e) e.setText(s == null ? '' : String(s)); },

    showEl(id, on) { const e = this.el(id); if (e) e.show(!!on); },

    /** Wrap a string to `n` columns on word boundaries (the HUD has no layout engine). */
    wrap(s, n) {
        const words = String(s).split(/\s+/);
        const lines = [];
        let cur = '';
        for (const w of words) {
            if (!cur.length) cur = w;
            else if (cur.length + 1 + w.length <= n) cur += ' ' + w;
            else { lines.push(cur); cur = w; }
        }
        if (cur.length) lines.push(cur);
        return lines.join('\n');
    },

    /** Switch screens: hide every record of every other screen, show this one's. */
    show(name) {
        this.screen = name;
        const want = this.SCREENS[name] || [];
        const keep = new Set(want);
        // The in-run HUD stays visible while playing (and behind the draft/pause overlays).
        const playing = name === 'play' || name === 'draft' || name === 'pause' || name === 'settings';
        for (const id of this.SCREENS.run) if (playing) keep.add(id);
        for (const list of Object.values(this.SCREENS)) {
            for (const id of list) {
                const e = this.el(id);
                if (!e) continue;
                if (keep.has(id)) e.show(true);
                else e.show(false);
            }
        }
        // Overlays that start hidden in UILayout.js and belong to exactly one screen.
        if (name === 'play') {
            for (const id of ['endDim', 'draftDim', 'bossPanel', 'bossBar', 'bossName', 'threat', 'toast', 'toastPanel']) this.showEl(id, false);
            this.showEl('joyBase', false);
            this.showEl('btnBoost', false);
            if (typeof IS_MOBILE !== 'undefined' && IS_MOBILE) { this.showEl('joyBase', true); this.showEl('btnBoost', true); }
        }
        if (name === 'draft') {
            this.showEl('draftDim', true);
            this.showEl('draftReroll', true);
            this.showEl('draftSkip', true);
            this.showEl('draftNote', true);
        }
        if (name === 'end' || name === 'win') this.showEl('endDim', true);
        if (name === 'pause') {
            this.showEl('pauseTitle', true); this.showEl('pauseResume', true);
            this.showEl('pauseRestart', true); this.showEl('pauseSettings', true); this.showEl('pauseMenu', true);
        }
    },

    // --- wiring (called once from Game) ----------------------------------------------------------
    bind(game) {
        const on = (id, fn) => {
            const e = this.el(id);
            if (e) e.onClick(() => { WanderAudio.click(); fn(); });
        };
        on('btnStart', () => game.startRun(false));
        on('btnLoadout', () => this.openLoadout());
        on('btnLegacy', () => this.openLegacy());
        on('btnHelp', () => this.openHelp());
        on('btnSettings', () => this.openSettings());
        on('loadChassisB', () => this.cycleChassis());
        on('loadCaptainB', () => this.cycleCaptain());
        on('btnRoll', () => { this.seed = this.rollSeed(); this.renderLoadout(); });
        on('btnGo', () => game.startRun(true));
        on('btnBackLoad', () => this.openTitle());
        on('legUp', () => this.moveCursor(-1));
        on('legDown', () => this.moveCursor(1));
        on('legBuy', () => this.buySelected());
        on('legBack', () => this.openTitle());
        on('legWipe', () => this.wipeProgress());
        on('setPrev', () => this.bumpSetting(-1));
        on('setNext', () => this.bumpSetting(1));
        on('setBack', () => this.closeSettings());
        on('helpBack', () => this.openTitle());
        on('endAgain', () => game.startRun(false));
        on('endMenu', () => game.toMenu());
        on('winEndless', () => game.continueEndless());
        on('winMenu', () => game.toMenu());
        on('pauseResume', () => game.resume());
        on('pauseRestart', () => game.startRun(false));
        on('pauseSettings', () => { this._settingsFrom = 'pause'; this.openSettings(); });
        on('pauseMenu', () => game.toMenu());
        on('draftReroll', () => game.rerollDraft());
        on('draftSkip', () => game.skipDraft());
        for (let i = 1; i <= 4; i++) {
            const n = i;
            on('cardB' + n, () => game.takeDraft(n - 1));
        }
        // The card panels themselves are clickable too (a bigger target than the button).
        for (let i = 1; i <= 4; i++) {
            const n = i, e = this.el('cardP' + n);
            if (e && e.el) {
                e.el.style.pointerEvents = 'auto';
                e.el.style.cursor = 'pointer';
                e.el.addEventListener('click', () => { WanderAudio.click(); game.takeDraft(n - 1); });
            }
        }
    },

    // --- title ------------------------------------------------------------------------------------
    openTitle() {
        const meta = WB.Save.meta || WB.Save.load();
        const s = meta.stats;
        this.text('titleScrap', 'ЛОМ: ' + meta.scrap + '  ·  Наследие ' + meta.legacy.length + '/' + WB.LEGACY.length);
        const best = s.bestRegion > 0 ? 'лучший рубеж: ' + (s.bestRegion + 1) : 'походов ещё не было';
        this.text('titleStats',
            'походов: ' + s.runs + '  ·  побед: ' + s.wins + '  ·  ' + best +
            '\nпоглощено массы: ' + Math.round(s.massTotal) + '  ·  снесено крепостей: ' + s.kills +
            '  ·  в игре: ' + Hud.clock(s.playTime));
        this.text('titleVer', 'v' + (typeof GAME_VERSION !== 'undefined' ? GAME_VERSION : '1.0.0') + ' · ArcEngine · PlayCanvas 2');
        this.show('title');
        WanderAudio.music('musicMenu');
    },

    clock(sec) {
        const s = Math.max(0, Math.round(sec || 0));
        const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
        return (h > 0 ? h + ' ч ' : '') + m + ' мин';
    },

    // --- loadout ------------------------------------------------------------------------------------
    rollSeed() {
        // A seed from the clock is fine here: it is the player's choice, not the simulation.
        return (Date.now() % 1000000) ^ (Math.round(performance.now()) * 7919);
    },

    openLoadout() {
        const meta = WB.Save.meta;
        if (!this.chassis) this.chassis = WB.CHASSIS[0];
        if (!this.captain) this.captain = WB.CAPTAINS[0];
        if (!this.seed) this.seed = this.rollSeed();
        // A chassis or a captain that got locked (a wiped save) falls back to the free one.
        if (!WB.chassisUnlocked(this.chassis, meta)) this.chassis = WB.CHASSIS[0];
        if (!WB.captainUnlocked(this.captain, meta)) this.captain = WB.CAPTAINS[0];
        this.renderLoadout();
        this.show('loadout');
    },

    renderLoadout() {
        const meta = WB.Save.meta;
        const ch = this.chassis, cap = this.captain;
        this.text('loadChassisN', ch.name + (WB.chassisUnlocked(ch, meta) ? '' : '  (закрыто)'));
        this.text('loadChassisD', this.wrap(ch.desc, 52));
        this.text('loadChassisS', 'Слотов модулей: ' + ch.slots +
            '   ·   Старт: ' + (WB.startModuleOf(ch) ? WB.startModuleOf(ch).name : '—'));
        this.text('loadCaptainN', cap.name + (WB.captainUnlocked(cap, meta) ? '' : '  (закрыто)'));
        this.text('loadCaptainD', this.wrap(cap.desc, 52));
        this.text('loadSeed', 'сид похода: ' + (this.seed >>> 0) + '   ·   лом: ' + meta.scrap);
    },

    cycleChassis() {
        const meta = WB.Save.meta;
        const list = WB.CHASSIS.filter(c => WB.chassisUnlocked(c, meta));
        const i = list.indexOf(this.chassis);
        this.chassis = list[(i + 1) % list.length];
        this.renderLoadout();
        WanderAudio.click();
    },

    cycleCaptain() {
        const meta = WB.Save.meta;
        const list = WB.CAPTAINS.filter(c => WB.captainUnlocked(c, meta));
        const i = list.indexOf(this.captain);
        this.captain = list[(i + 1) % list.length];
        this.renderLoadout();
        WanderAudio.click();
    },

    // --- legacy -------------------------------------------------------------------------------------
    openLegacy() {
        this.cursor = 0;
        this.page = 0;
        this.renderLegacy();
        this.show('legacy');
    },

    legacyRows() { return 11; },

    renderLegacy() {
        const meta = WB.Save.meta, rows = this.legacyRows();
        const pages = Math.max(1, Math.ceil(WB.LEGACY.length / rows));
        this.page = WB.M.clamp(this.page, 0, pages - 1);
        this.cursor = WB.M.clamp(this.cursor, 0, WB.LEGACY.length - 1);
        if (Math.floor(this.cursor / rows) !== this.page) this.page = Math.floor(this.cursor / rows);
        this.text('legScrap', 'ЛОМ: ' + meta.scrap + '   ·   куплено ' + meta.legacy.length + ' из ' + WB.LEGACY.length +
            '   ·   страница ' + (this.page + 1) + '/' + pages);
        const lines = [];
        for (let i = this.page * rows; i < Math.min(WB.LEGACY.length, (this.page + 1) * rows); i++) {
            const l = WB.LEGACY[i];
            const owned = WB.Save.has(l.id);
            const afford = meta.scrap >= l.cost;
            const mark = i === this.cursor ? '▸ ' : '   ';
            lines.push(mark + (owned ? '✓ ' : afford ? '• ' : '✗ ') + l.name +
                '  —  ' + (owned ? 'куплено' : l.cost + ' лома') + '\n      ' + l.desc);
        }
        this.text('legList', lines.join('\n'));
        const sel = WB.LEGACY[this.cursor];
        const buy = this.el('legBuy');
        if (buy) buy.setText(sel && !WB.Save.has(sel.id) ? 'КУПИТЬ (' + sel.cost + ')' : 'КУПЛЕНО');
    },

    moveCursor(d) {
        this.cursor = WB.M.clamp(this.cursor + d, 0, WB.LEGACY.length - 1);
        this.renderLegacy();
        WanderAudio.click();
    },

    buySelected() {
        const l = WB.LEGACY[this.cursor];
        if (!l) return;
        if (WB.Save.has(l.id)) { WanderAudio.error(); return; }
        if (WB.Save.buy(l.id)) {
            WanderAudio.buy();
            this.text('legScrap', 'ЛОМ: ' + WB.Save.meta.scrap);
        } else WanderAudio.error();
        this.renderLegacy();
    },

    wipeProgress() {
        WB.Save.reset();
        this.chassis = WB.CHASSIS[0];
        this.captain = WB.CAPTAINS[0];
        this.renderLegacy();
        WanderAudio.error();
    },

    // --- settings -----------------------------------------------------------------------------------
    SETTINGS: [
        { key: 'sfx', name: 'Громкость эффектов', steps: [0, 0.25, 0.5, 0.75, 1] },
        { key: 'music', name: 'Громкость музыки', steps: [0, 0.25, 0.5, 0.75, 1] },
        { key: 'shake', name: 'Тряска камеры', steps: [0, 1] }
    ],

    openSettings() {
        this.setRow = 0;
        this._settingsFrom = this.screen === 'pause' ? 'pause' : 'title';
        this.renderSettings();
        this.show('settings');
    },

    /** Where the settings screen was opened from: 'pause' or 'title'. */
    settingsFrom() { return this._settingsFrom || 'title'; },

    closeSettings() {
        if (this._settingsFrom === 'pause') this.show('pause');
        else this.openTitle();
    },

    renderSettings() {
        const meta = WB.Save.meta, set = meta.settings;
        const lines = [];
        for (let i = 0; i < this.SETTINGS.length; i++) {
            const s = this.SETTINGS[i];
            const v = set[s.key] == null ? 1 : set[s.key];
            const label = s.steps.indexOf(v) >= 0 ? (s.steps.length === 2 ? (v ? 'вкл' : 'выкл') : Math.round(v * 100) + '%') : String(v);
            lines.push((i === this.setRow ? '▸ ' : '   ') + s.name + ':  ' + label + '      ◂  ▸');
        }
        lines.push('');
        lines.push('   Прогресс и настройки хранятся в этом браузере (localStorage).');
        this.text('setList', lines.join('\n'));
    },

    bumpSetting(dir) {
        const s = this.SETTINGS[this.setRow];
        if (!s) return;
        const meta = WB.Save.meta, set = meta.settings;
        const cur = set[s.key] == null ? 1 : set[s.key];
        let i = s.steps.indexOf(cur);
        if (i < 0) i = s.steps.length - 1;
        i = WB.M.clamp(i + dir, 0, s.steps.length - 1);
        set[s.key] = s.steps[i];
        WB.Save.persist();
        WanderAudio.applyVolumes();
        WanderAudio.click();
        this.renderSettings();
    },

    // --- help -----------------------------------------------------------------------------------------
    openHelp() {
        this.text('helpText', this.wrap(Hud.HELP_TEXT, 96).replace(/\n· /g, '\n· '));
        this.show('help');
    },

    // --- draft ----------------------------------------------------------------------------------------
    /**
     * Show the draft the run is offering.
     * @param {any} run WBRun
     * @param {number} rerollsLeft free rerolls
     */
    showDraft(run, rerollsLeft) {
        const d = run.draftPending;
        if (!d) return;
        const p = run.player;
        const why = d.reason === 'tier' ? 'Новая ступень корпуса: ' + p.tier + ' · слотов ' + p.modules.length + '/' + p.slots : 'Выбор';
        this.text('draftTitle', 'ЧЕРТЁЖ');
        this.text('draftSub', why);
        for (let i = 0; i < 4; i++) {
            const card = d.cards[i];
            const n = i + 1;
            this.showEl('cardP' + n, !!card);
            this.showEl('cardB' + n, !!card);
            if (!card) continue;
            const mod = card.mod;
            this.text('cardN' + n, card.name || (mod ? mod.name : '—'));
            this.text('cardL' + n, card.kind === 'new' ? 'НОВЫЙ МОДУЛЬ'
                : card.kind === 'upgrade' ? 'УРОВЕНЬ ' + card.level + ' из ' + WB.MOD_MAX_LEVEL
                    : card.kind === 'repair' ? 'РЕМОНТ' : 'ЛОМ');
            this.text('cardD' + n, this.wrap(card.desc || (mod ? mod.desc : ''), 34));
            this.text('cardS' + n, card.kind === 'new' || card.kind === 'upgrade' ? this.moduleStats(mod, card.level) : '');
            const btn = this.el('cardB' + n);
            if (btn) btn.setText('ВЗЯТЬ  [' + n + ']');
            const panel = this.el('cardP' + n);
            if (panel && mod) {
                const rare = ['', ' #b08ad8', ' #d8a24a'][mod.rarity || 0];
                panel.def.border = rare ? rare.trim() : '#4a3b2a';
                panel.apply();
            }
        }
        const cost = run.rerollCost();
        const rr = this.el('draftReroll');
        if (rr) rr.setText(rerollsLeft > 0 ? 'СМЕНИТЬ (бесплатно: ' + rerollsLeft + ')' : 'СМЕНИТЬ: ' + cost + ' массы');
        const skip = this.el('draftSkip');
        if (skip) skip.setText('ПРОПУСТИТЬ: +' + Math.round(p.maxHp * WB.num('DRAFT_SKIP_HEAL', 0.12)) + ' корпуса');
        this.text('draftNote', 'КЛАВИШИ 1–4 · R — сменить · Esc — пропустить');
        this.show('draft');
    },

    /** The numbers of a module at a level, one per line — what the card shows. */
    moduleStats(mod, level) {
        if (!mod) return '';
        const rows = [];
        const stat = (key, fmt) => {
            const v = WB.moduleStat(mod, level, key);
            if (v) rows.push(fmt(v));
        };
        stat('power', v => 'урон ' + Math.round(v));
        stat('rate', v => 'темп ' + (1 / v).toFixed(2) + '/с');
        stat('reach', v => 'дальность ' + Math.round(v));
        stat('aoe', v => 'по площади ' + Math.round(v));
        stat('pierce', v => 'пробивает ' + Math.round(v));
        stat('units', v => 'ос в рое ' + Math.round(v));
        stat('repair', v => 'ремонт ' + Math.round(v) + '/с');
        stat('steam', v => 'пара +' + Math.round(v));
        stat('walls', v => 'корпус +' + Math.round(v));
        stat('kegPower', v => 'взрыв ' + Math.round(v));
        stat('burn', v => 'тлеет ' + Math.round(v) + '/с');
        const pct = (key, label) => {
            const v = WB.moduleStat(mod, level, key);
            if (v) rows.push(label + ' ' + (v > 0 && v < 3 ? '+' + Math.round(v * 100) + '%' : Math.round(v)));
        };
        pct('speed', 'скорость');
        pct('accel', 'тяга');
        pct('plate', 'броня');
        pct('ramPower', 'таран');
        pct('massBonus', 'масса');
        pct('scrapBonus', 'лом');
        pct('steamFlow', 'рег. пара');
        pct('sight', 'дальность');
        pct('villageBonus', 'масса с деревень');
        if (mod.stun) rows.push('оглушает ' + mod.stun + ' с');
        return rows.slice(0, 5).join('\n');
    },

    // --- run summary ----------------------------------------------------------------------------------
    /**
     * The run is over: show what it was worth. `scrap` is what js/Game.js has already booked
     * into the save — the HUD only displays it, it never writes to WB.Save.
     */
    showEnd(summary, scrap) {
        const won = summary.won;
        this.text('endTitle', won ? 'ПОБЕДА' : 'ЗАМОК РАЗРУШЕН');
        const e = this.el('endTitle');
        if (e) { e.def.color = won ? '#d8ab52' : '#c0483a'; e.apply(); }
        this.text('endStats',
            'Рубежей пройдено: ' + summary.regions + (won ? '' : '  (пал на ' + (summary.regionIndex + 1) + '-м)') +
            '\nСтупень корпуса: ' + summary.tier +
            '\nПоглощено массы: ' + summary.mass +
            '\nСнесено крепостей и рыцарей: ' + summary.kills +
            '\nДеревень съедено: ' + summary.villages +
            '\nУрона нанесено: ' + summary.damage +
            '\nВремя похода: ' + this.clock(summary.time));
        this.text('endMods', 'Модули: ' + (summary.modules.length
            ? summary.modules.map(m => m.name + ' ' + m.level).join(' · ')
            : '—'));
        this.text('endScrap', 'ЛОМА ДОБЫТО: +' + Math.round(scrap || 0) + '   ·   всего ' + WB.Save.meta.scrap);
        if (won) {
            this.text('winText', 'Железный Венец пал. Долина ваша — но за ней ещё одна.');
            this.text('endTitle', 'ПОБЕДА');
            this.show('win');
        } else this.show('end');
    },

    // --- the in-run HUD ---------------------------------------------------------------------------------
    _lastRegion: -1,
    _toastT: 0,

    /**
     * Feed the HUD from the run. Cheap: called every frame, but it only writes when a value
     * actually changed (the DOM write is what costs, not the compare).
     */
    updateHud(run, dt) {
        const p = run.player;
        if (!p) return;
        this._set('hudTier', 'СТУПЕНЬ ' + p.tier + '   ' + Math.round(p.hp) + ' / ' + p.maxHp);
        this._bar('hudHull', p.hp / p.maxHp);
        this._bar('hudSteam', p.steam / (p.stats ? p.stats.steamMax : 100));
        const next = WB.tierMass(p.tier + 1), prev = WB.tierMass(p.tier);
        this._bar('hudMass', next === Infinity ? 1 : (p.mass - prev) / Math.max(1, next - prev));
        this._set('hudMassTxt', 'МАССА ' + Math.round(p.mass) + (next === Infinity ? '  (предел)' : '  /  ' + Math.round(next)) +
            '   ·   модулей ' + p.modules.length + '/' + p.slots);
        if (run.regionIndex !== this._lastRegion) {
            this._lastRegion = run.regionIndex;
            const b = run.region.biome;
            this._set('hudRegion', (run.regionIndex + 1) + '-й РУБЕЖ · ' + b.name.toUpperCase());
        }
        const left = run.fortressesLeft;
        const gate = run.region.gate;
        this._set('hudObjective', run.bossActive
            ? 'ВАРДЕН: ' + (run.boss ? Math.max(0, Math.round(run.boss.hp)) : 0)
            : gate && gate.open
                ? 'ВРАТА ОТКРЫТЫ — идите к вардену'
                : 'КРЕПОСТЕЙ ОСТАЛОСЬ: ' + left + '  ·  врата откроются при ' + Math.min(WB.num('GATE_FORTRESSES', 1), Math.max(0, left - 1)));
        this._set('hudScrap', 'лом похода: ' + run.runScrap() + '   ·   время ' + this.clock(run.totals.time));

        // The boss bar.
        const boss = run.boss;
        const bossOn = !!(boss && boss.alive && run.bossActive);
        this.showEl('bossPanel', bossOn);
        this.showEl('bossBar', bossOn);
        this.showEl('bossName', bossOn);
        if (bossOn) {
            this._bar('bossBar', boss.hp / boss.maxHp);
            this._set('bossName', boss.name + (boss.ai && boss.ai.enrage ? '  ·  ЯРОСТЬ' : ''));
        }

        // A threat marker when something is hunting the player.
        const th = run.threat(900);
        const danger = th.near && th.dist < 700;
        this.showEl('threat', !!danger);
        if (danger) this._set('threat', '⚔ ' + (th.near.boss ? 'ВАРДЕН' : 'КРЕПОСТЬ') + '  ' + th.dist + ' px');

        // The toast (objective hints, region names).
        if (this._toastT > 0) {
            this._toastT -= dt;
            if (this._toastT <= 0) { this.showEl('toast', false); this.showEl('toastPanel', false); }
        }
        this._set('fps', Math.round(World3D.fps()) + ' fps');
    },

    toast(text, sec) {
        this.text('toast', text);
        this.showEl('toast', true);
        this.showEl('toastPanel', true);
        this._toastT = sec || 4;
    },

    /** Write a text only when it changed (a setText rebuilds the element's DOM styles). */
    _cache: {},
    _set(id, s) {
        const v = String(s);
        if (this._cache[id] === v) return;
        this._cache[id] = v;
        this.text(id, v);
    },

    _barCache: {},
    _bar(id, v) {
        const q = Math.round(WB.M.clamp(v, 0, 1) * 200) / 200;
        if (this._barCache[id] === q) return;
        this._barCache[id] = q;
        const e = this.el(id);
        if (e) e.setValue(q);
    },

    /** The hint line at the bottom left: controls on desktop, the touch note on mobile. */
    setHint(text) { this.text('hintBar', text); }
};

