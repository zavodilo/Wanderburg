// profile-panel.js — the editor's VISUAL PROFILE / VARIANT surface.
//
// The editor shows the three concepts of the architecture separately:
//
//     PROJECT   one Master Project (js/GameSpec.js): the shared game model
//     PROFILE   a type of presentation (manifest/render-profiles.json): 2d … full3d
//     VARIANT   one concrete presentation of this project (presentation/variants/*.json)
//
// Switching the variant in the toolbar re-presents the editor's view LIVE (ground, sprites
// or models, lighting) without touching any source file and without stealing the editor's
// own camera. "Convert…" previews a migration plan (dry run) and applies it: the target
// variant is created/updated, the source variant stays, and the result is written back
// through the editor server (POST /api/save-variant, /api/save-journal,
// /api/regenerate-variants).

/** @satisfies {Record<string, any>} */
const ProfilePanel = {
    lab: null,
    /** @type {any | null} the last previewed plan */
    plan: null,

    init(lab) {
        ProfilePanel.lab = lab;
        const vs = /** @type {HTMLSelectElement | null} */ (document.getElementById('variant-select'));
        const tp = /** @type {HTMLSelectElement | null} */ (document.getElementById('target-profile'));
        if (!vs || !tp) return;
        // the profile ladder for the convert target
        tp.innerHTML = RenderProfile.ids().map(id => {
            const p = RenderProfile.info(id);
            return '<option value="' + id + '">' + p.name + ' (' + p.projection + ')</option>';
        }).join('');
        vs.addEventListener('change', () => ProfilePanel.setVariant(vs.value));
        tp.addEventListener('change', () => ProfilePanel.refresh());
        document.getElementById('btn-preview-migration').addEventListener('click', () => ProfilePanel.preview());
        document.getElementById('btn-apply-migration').addEventListener('click', () => ProfilePanel.apply());
        document.getElementById('btn-create-all').addEventListener('click', () => ProfilePanel.createAll());
        document.getElementById('btn-convert').addEventListener('click', () => { PaneTabs.show('profile'); ProfilePanel.refresh(); });
        window.addEventListener('lang-changed', () => ProfilePanel.refresh());
        ProfilePanel.refresh();
    },

    /** Fill the toolbar select and mark the active variant. */
    fillSelect() {
        const vs = document.getElementById('variant-select');
        if (!vs) return;
        const cur = Variant.currentId();
        const sel = /** @type {HTMLSelectElement} */ (vs);
        sel.innerHTML = Variant.list().map(v =>
            '<option value="' + v.id + '"' + (v.id === cur ? ' selected' : '') + (v.enabled === false ? ' disabled' : '') + '>' +
            v.profile + ' — ' + v.name + '</option>').join('');
    },

    /** Present another variant in the editor view (no camera theft, no file writes). */
    setVariant(id) {
        if (!Variant.has(id)) return;
        try {
            PlayArcRuntime.setVariant(id, { apply: false });
            RenderProfile.apply({ skipCamera: true });
        } catch (e) {
            Toast.show('variant: ' + ((e && e.message) || e), true);
        }
        ProfilePanel.refresh();
    },

    target() {
        const tp = /** @type {HTMLSelectElement | null} */ (document.getElementById('target-profile'));
        return tp ? tp.value : null;
    },

    // --- the panel body -------------------------------------------------------------------

    refresh() {
        ProfilePanel.fillSelect();
        const title = document.getElementById('profile-title');
        const body = document.getElementById('profile-body');
        if (!body) return;
        const ctx = PlayArcRuntime.context();
        const v = Variant.current();
        const p = v ? RenderProfile.info(v.profile) : null;
        if (title) {
            title.innerHTML =
                '<div class="pp-row"><b>' + I18N.t('var.project') + '</b> ' + esc((Variant.project && Variant.project.name) || '-') +
                ' <span class="dim">(' + esc((Variant.project && Variant.project.id) || '') + ')</span></div>' +
                '<div class="pp-row"><b>' + I18N.t('var.profile') + '</b> ' + esc(v ? v.profile : '-') +
                ' <span class="dim">' + esc(p ? p.projection + ' · ' + (p.geometry || '') : '') + '</span></div>' +
                '<div class="pp-row"><b>' + I18N.t('var.variant') + '</b> ' + esc(v ? v.name : '-') + '</div>';
        }
        const rows = [];
        if (p) {
            rows.push(['capabilities', (p.capabilities || []).join(', ')]);
            const budget = RenderProfile.checkBudget(v.profile);
            rows.push([I18N.t('var.budget'), (p.performanceBudget.tier || '') + ' · maxDrawCalls ' + p.performanceBudget.maxDrawCalls +
                ' · maxPolycount ' + p.performanceBudget.maxPolycount + ' · maxTextureMB ' + p.performanceBudget.maxTextureMemoryMB +
                (budget.warnings.length ? ' · ' + budget.warnings.join('; ') : '')]);
            const missing = AssetRegistry.missing(v.profile);
            rows.push([I18N.t('var.missing'), missing.length
                ? missing.slice(0, 8).map(m => m.role + ' (' + m.resolvedBy + ')').join(', ') + (missing.length > 8 ? '…' : '')
                : I18N.t('var.none')]);
            rows.push([I18N.t('var.camera'), ((RenderProfile.config().camera) || {}).mode + ' · ' + ((RenderProfile.config().camera) || {}).projection]);
            rows.push([I18N.t('var.lighting'), (Lighting.get().preset || '-')]);
            rows.push([I18N.t('var.entities'), GameModel.entities.length + ' · ids: ' + GameModel.entities.map(e => e.id).join(', ')]);
            rows.push([I18N.t('var.shared'), 'gameplay ' + GameModel.gameplayHash() + ' · save ' + Save.schemaHash()]);
            const variants = Variant.list();
            rows.push([I18N.t('var.variants'), variants.map(x => x.profile + (x.id === Variant.currentId() ? '*' : '')).join(', ')]);
        }
        const journal = Variant.migrationJournal();
        if (journal.length) {
            const last = journal[journal.length - 1];
            rows.push([I18N.t('var.journal'), journal.length + ' · ' + I18N.t('var.last') + ': ' + last.from + ' → ' + last.to + ' (' + last.status + ', ' + (last.timestamp || '').slice(0, 19) + ')']);
        }
        body.innerHTML = '<table class="pp-table">' + rows.map(r =>
            '<tr><td class="pp-k">' + esc(String(r[0])) + '</td><td class="pp-v">' + esc(String(r[1])) + '</td></tr>').join('') + '</table>' +
            (ProfilePanel.plan ? ProfilePanel.renderPlan(ProfilePanel.plan) : '');
    },

    renderPlan(plan) {
        const c = plan.counts || {};
        return '<div class="pp-plan"><b>' + I18N.t('var.plan') + ' ' + esc(plan.from) + ' → ' + esc(plan.to) + '</b>' +
            '<div>' + I18N.t('var.planCounts') + ': ' +
            esc('entities ' + c.entities + ' · preserved ' + c.preserved + ' · replacements ' + c.visualReplacements +
                ' · missing ' + c.missingAssets + ' · fallback geometry ' + c.fallbackGeometry +
                ' · camera ' + c.cameraChanges + ' · lighting ' + c.lightingChanges + ' · gameplay files ' + c.gameplayFilesChanged) + '</div>' +
            (plan.generated && plan.generated.length ? '<div>' + I18N.t('var.generated') + ': ' + esc(plan.generated.join(', ')) + '</div>' : '') +
            (plan.fallbacks && plan.fallbacks.length ? '<div>' + I18N.t('var.fallbacks') + ': ' + esc(plan.fallbacks.slice(0, 10).join(', ')) + '</div>' : '') +
            (plan.warnings && plan.warnings.length ? '<div class="pp-warn">' + plan.warnings.map(esc).join('<br>') + '</div>' : '') +
            '</div>';
    },

    // --- conversion ---------------------------------------------------------------------------

    preview() {
        const to = ProfilePanel.target();
        if (!to) return;
        try {
            ProfilePanel.plan = Migration.plan(Variant.currentId(), to);
        } catch (e) {
            Toast.show('plan: ' + ((e && e.message) || e), true);
            return;
        }
        ProfilePanel.refresh();
    },

    /** Apply the migration and persist the new variant + journal (non-destructive). */
    async apply() {
        const to = ProfilePanel.target();
        if (!to) return;
        if (!ProfilePanel.plan || ProfilePanel.plan.to !== to) ProfilePanel.preview();
        let report = null;
        try {
            report = Migration.convert({ source: Variant.currentId(), profile: to, by: 'editor' });
        } catch (e) {
            Toast.show('convert: ' + ((e && e.message) || e), true);
            return;
        }
        if (!report.ok) { Toast.show('convert: ' + report.error, true); return; }
        // persist: the target variant, the journal, then the generated project files
        const okSave = await ProfilePanel.post('/api/save-variant', { variant: Variant.get(report.targetVariant) });
        const okJournal = await ProfilePanel.post('/api/save-journal', { journal: Migration.journal() });
        const okGen = await ProfilePanel.post('/api/regenerate-variants', {});
        if (!(okSave && okJournal && okGen)) { Toast.show(I18N.t('var.saveFailed'), true); return; }
        Toast.show(I18N.t('var.converted') + ' ' + report.from + ' → ' + report.to);
        ProfilePanel.plan = null;
        PlayArcRuntime.setVariant(report.targetVariant, { apply: false });
        RenderProfile.apply({ skipCamera: true });
        ProfilePanel.refresh();
    },

    /** "Create All Visual Variants": one variant per profile, all sharing this game model. */
    async createAll() {
        const created = Variant.createAll({ by: 'editor' });
        const variants = Variant.list();
        const ok = await ProfilePanel.post('/api/save-variants', { variants: variants });
        const okGen = await ProfilePanel.post('/api/regenerate-variants', {});
        if (!(ok && okGen)) { Toast.show(I18N.t('var.saveFailed'), true); return; }
        Toast.show(I18N.t('var.createdAll') + ': ' + created.map(c => c.profile).join(', '));
        ProfilePanel.refresh();
    },

    async post(path, payload) {
        try {
            const r = await fetch(path, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!r.ok) { console.error(path, r.status); return false; }
            const j = await r.json();
            return !!j.ok;
        } catch (e) {
            console.error(path, e);
            return false;
        }
    },

    /**
     * The editor is the canon for object placement: keep the shared game model in sync with
     * the location records the gizmo moves, so every variant sees the same world.
     */
    syncFromEditor() {
        const lab = ProfilePanel.lab;
        if (!lab || !lab.location) return 0;
        let n = 0;
        for (const rec of lab.location.objects) {
            const e = GameModel.entity(rec.def.name) || (rec.def.tag ? GameModel.entity(rec.def.tag) : null);
            if (!e) continue;
            const pos = Coords.fromMap({ x: rec.def.x, y: rec.def.y, h: rec.def.h });
            if (!Coords.equals(pos, e.position, 0.01)) {
                e.setPosition(pos);
                e.rotation = Coords.rotFromMap(rec.def.rot);
                e.scale = Coords.from({ x: (rec.def.scale || [1, 1, 1])[0], y: (rec.def.scale || [1, 1, 1])[1], z: (rec.def.scale || [1, 1, 1])[2] });
                VisualEntity.update(e.id);
                n++;
            }
        }
        return n;
    }
};

/** Escape for innerHTML (the panel renders ids and paths from the project). */
function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
