// Save.js — save/load of the semantic model (renderer-independent by construction).
//
// A save file contains GAMEPLAY and nothing else: entity logic and transforms, world
// tiles, progression and Kit state. It never contains a render profile, a camera, an asset
// path or a material — so the same save loads in 2D and in Full 3D, and a visual migration
// cannot invalidate it. That is checked, not promised: Save.schemaHash() is part of the
// migration's preservation proof (js/presentation/Migration.js).
//
//     Save.save();                 // the spec's slot
//     Save.save('slot2');
//     const data = Save.load();    // -> restore into the live model, or null
//     Save.schema()                // the machine-readable schema
//
// Storage goes through Store only (invariant: a sandbox iframe throws on localStorage).

/** @satisfies {Record<string, any>} */
const Save = {
    KEY_PREFIX: 'arc.save.',
    INDEX_KEY: 'arc.save.index',

    // --- schema -------------------------------------------------------------------------

    /**
     * The save schema: the fields a save contains. Derived from GAME_SPEC.saveState with
     * canonical defaults, so two projects with the same gameplay have the same schema.
     */
    schema() {
        const s = (GameModel.spec && GameModel.spec.saveState) || {};
        return {
            schemaVersion: Number(s.schemaVersion) || 1,
            slot: s.slot || 'autosave',
            game: GameModel.spec ? GameModel.spec.id : null,
            fields: (s.fields && s.fields.length ? s.fields : Save.DEFAULT_FIELDS).slice().sort(),
            entityFields: (s.entityFields && s.entityFields.length ? s.entityFields : Save.DEFAULT_ENTITY_FIELDS).slice().sort()
        };
    },

    DEFAULT_FIELDS: ['progression', 'entities', 'world', 'kit', 'activeScene'],
    DEFAULT_ENTITY_FIELDS: ['id', 'position', 'rotation', 'logic', 'components'],

    /** One string to compare across profiles and across a migration. */
    schemaHash() { return GameModel.hash(JSON.stringify(Save.schema())); },

    // --- serialization ---------------------------------------------------------------------

    /** The current model as a save payload (plain JSON, no engine data). */
    serialize(opts) {
        if (!GameModel.spec) throw new Error('Save.serialize: boot a model first (GameModel.boot())');
        const o = opts || {};
        const schema = Save.schema();
        const f = new Set(schema.fields);
        const data = {
            magic: 'arc-save',
            schemaVersion: schema.schemaVersion,
            game: schema.game,
            slot: o.slot || schema.slot,
            savedAt: o.savedAt || new Date().toISOString(),
            gameplayHash: GameModel.gameplayHash(),
            // Recorded for information ONLY: loading a save never changes the profile.
            presentedWith: GameModel.renderProfile()
        };
        if (f.has('progression')) data.progression = JSON.parse(JSON.stringify(GameModel.progression || {}));
        if (f.has('entities')) data.entities = GameModel.entities.map(e => e.saveSnapshot());
        if (f.has('world') && GameModel.world) data.world = GameModel.world.toSpec();
        if (f.has('activeScene')) data.activeScene = GameModel.activeScene;
        if (f.has('kit') && typeof Kit !== 'undefined') {
            const kit = {};
            for (const [k, v] of Kit._state) { try { kit[k] = JSON.parse(JSON.stringify(v)); } catch (e) { /* not JSON-able: skip */ } }
            data.kit = kit;
        }
        return data;
    },

    /** Check a payload against the live schema; returns a list of problems (empty — ok). */
    validate(data) {
        const problems = [];
        if (!data || typeof data !== 'object') return ['not an object'];
        if (data.magic !== 'arc-save') problems.push('magic != arc-save');
        const schema = Save.schema();
        if (Number(data.schemaVersion) !== schema.schemaVersion) {
            problems.push('schemaVersion ' + data.schemaVersion + ' != ' + schema.schemaVersion);
        }
        if (data.game && schema.game && data.game !== schema.game) problems.push('game ' + data.game + ' != ' + schema.game);
        if (!Array.isArray(data.entities)) problems.push('entities must be an array');
        else {
            const ids = new Set(GameModel.entities.map(e => e.id));
            for (const e of data.entities) if (!ids.has(e.id)) problems.push('unknown entity id ' + JSON.stringify(e.id));
        }
        return problems;
    },

    /**
     * Restore a payload into the live model. ids must match: a save is never allowed to
     * invent or rename entities (that would be a gameplay change).
     * @returns {{ restored: number, skipped: string[] }}
     */
    restore(data, opts) {
        const o = opts || {};
        const problems = Save.validate(data);
        const fatal = problems.filter(p => !/^unknown entity id/.test(p));
        if (fatal.length && !o.lenient) throw new Error('Save.restore: ' + fatal.join('; '));
        const skipped = problems.filter(p => /^unknown entity id/.test(p)).map(p => p.replace(/^unknown entity id /, ''));
        let n = 0;
        for (const snap of data.entities || []) {
            const e = GameModel.entity(snap.id);
            if (!e) continue;
            e.restore(snap);
            n++;
        }
        if (data.progression) GameModel.progression = JSON.parse(JSON.stringify(data.progression));
        if (data.world && GameModel.world && o.world !== false) GameModel.world.restore(data.world);
        if (data.activeScene && GameModel.scene(data.activeScene)) GameModel.activeScene = data.activeScene;
        if (data.kit && typeof Kit !== 'undefined') for (const [k, v] of Object.entries(data.kit)) Kit.state(k, v);
        return { restored: n, skipped: skipped };
    },

    // --- slots ---------------------------------------------------------------------------

    key(slot) { return Save.KEY_PREFIX + (slot || Save.schema().slot || 'autosave'); },

    /** Write a slot. false — storage refused (private mode, sandbox). */
    save(slot, opts) {
        const data = Save.serialize(Object.assign({}, opts || {}, { slot: slot || Save.schema().slot }));
        const ok = Store.set(Save.key(data.slot), JSON.stringify(data));
        if (ok) Save._index(data.slot);
        return ok ? data.slot : false;
    },

    /** Read a slot (null when there is none or it is broken). Does NOT restore. */
    read(slot) {
        return Store.getJSON(Save.key(slot || Save.schema().slot), null);
    },

    /** Read + restore. Returns the payload, or null. */
    load(slot, opts) {
        const data = Save.read(slot);
        if (!data) return null;
        Save.restore(data, opts);
        return data;
    },

    exists(slot) { return !!Save.read(slot); },

    clear(slot) { Store.remove(Save.key(slot || Save.schema().slot)); Save._index(slot, true); return true; },

    clearAll() {
        for (const s of Save.list()) Store.remove(Save.key(s));
        Store.remove(Save.INDEX_KEY);
        return true;
    },

    /** Known slot names. */
    list() { return Store.getJSON(Save.INDEX_KEY, []) || []; },

    _index(slot, remove) {
        const list = Save.list().filter(s => s !== slot);
        if (!remove) list.push(slot);
        Store.set(Save.INDEX_KEY, JSON.stringify(list));
        return list;
    },

    /** Machine-readable summary (agents, the editor, the migration report). */
    inspect() {
        return {
            schema: Save.schema(),
            schemaHash: Save.schemaHash(),
            slots: Save.list(),
            defaultSlot: Save.schema().slot
        };
    }
};
