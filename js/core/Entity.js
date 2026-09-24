// Entity.js — a logical entity of the semantic core (renderer-independent).
//
// An entity is a STABLE LOGICAL IDENTITY plus its state:
//
//     { id: 'player', type: 'character',
//       logic: { health: 100, speed: 5 },
//       visual: { role: 'player.visual' } }
//
// `id` never changes: not on a rename in the editor, not on a render profile migration,
// not on a save/load round trip. `logic` is gameplay and no presentation code writes it.
// `visual` is presentation and no gameplay code reads it — it names an asset ROLE
// (js/presentation/AssetRegistry.js) or, rarely, an explicit per-profile override.
//
// There is no pc.Entity here and there never will be: the engine binding is
// js/presentation/VisualEntity.js + js/engine/Visual3D.js.

/** @typedef {ArcVec3Like} EntityVec */

class ArcEntity {
    /** @param {any} spec */
    constructor(spec) {
        const s = Entity.validate(spec);
        /** Stable logical identity. */
        this.id = s.id;
        this.type = s.type;
        this.name = s.name || s.id;
        /** @type {string[]} */
        this.tags = (s.tags || []).slice();
        /** @type {string | null} */
        this.scene = s.scene || null;
        /** @type {EntityVec} canonical { x, y, z } — y is height, 0 in a flat 2D world */
        this.position = Coords.from(s.position);
        /** @type {EntityVec} degrees, y is the heading */
        this.rotation = Coords.from(s.rotation);
        /** @type {EntityVec} */
        this.scale = s.scale ? Coords.from(s.scale) : { x: 1, y: 1, z: 1 };
        /** Gameplay state. Presentation never writes this. */
        this.logic = JSON.parse(JSON.stringify(s.logic || {}));
        /** Named logic components: { Health: { max: 100 }, Inventory: { slots: 12 } } */
        this.components = JSON.parse(JSON.stringify(s.components || {}));
        /** Presentation reference: { role?, representation?, renderLayer?, drawOrder?, zIndex?, size?, animation?, profiles? } */
        this.visual = JSON.parse(JSON.stringify(s.visual || {}));
        /** Filled by the presentation layer, never by gameplay: the current visual binding id. */
        this.visualBinding = null;
    }

    // --- logic state --------------------------------------------------------------

    /** Read a logic field: entity.get('health'). */
    get(key) { return this.logic[key]; }

    /** Write a logic field (creates it when absent). */
    set(key, value) { this.logic[key] = value; return this; }

    /** Numeric helper: entity.inc('health', -10). */
    inc(key, delta) {
        const n = Number(this.logic[key]) || 0;
        this.logic[key] = n + (Number(delta) || 0);
        return this.logic[key];
    }

    has(key) { return Object.prototype.hasOwnProperty.call(this.logic, key); }

    /** A logic component by name (null when absent). */
    component(name) { return this.components[name] || null; }

    /** Add/replace a logic component: entity.add('Health', { max: 100 }). */
    add(name, data) {
        if (!ArcEntity.COMPONENT_NAME.test(String(name))) throw new Error('Entity.add: bad component name ' + JSON.stringify(name));
        this.components[String(name)] = JSON.parse(JSON.stringify(data == null ? {} : data));
        return this.components[String(name)];
    }

    hasComponent(name) { return Object.prototype.hasOwnProperty.call(this.components, String(name)); }

    hasTag(tag) { return this.tags.indexOf(String(tag)) >= 0; }

    addTag(tag) { if (!this.hasTag(tag)) this.tags.push(String(tag)); return this; }

    // --- transform ----------------------------------------------------------------

    /** @param {EntityVec} v canonical position */
    setPosition(v) { this.position = Coords.from(v); return this; }

    /** @param {EntityVec} d */
    moveBy(d) { this.position = Coords.add(this.position, Coords.from(d)); return this; }

    /** Heading in degrees around Y (0 — +x, 90 — +z). */
    heading() { return this.rotation.y; }

    setHeading(deg) { this.rotation.y = Number(deg) || 0; return this; }

    /** Unit facing direction on the x/z plane. */
    forward() { return Coords.fromHeading(this.rotation.y); }

    // --- presentation -------------------------------------------------------------

    /** The asset role this entity dresses as (null — it has no visual). */
    role() { return this.visual && this.visual.role ? String(this.visual.role) : null; }

    /**
     * What the entity wants to look like in a profile, BEFORE the registry resolves it:
     * an explicit visual.profiles[profileId] override wins, then the role, then the
     * profile's default representation for the entity type.
     * @param {string} profileId
     */
    visualRequest(profileId) {
        const v = this.visual || {};
        const prof = (typeof RENDER_PROFILES !== 'undefined' && RENDER_PROFILES.profiles[profileId]) || null;
        const override = v.profiles && v.profiles[profileId] ? v.profiles[profileId] : null;
        const type = (override && override.type) || v.representation ||
            (prof && prof.entityRepresentations && prof.entityRepresentations.byType[this.type]) || 'none';
        return {
            entityId: this.id,
            type: type,
            role: this.role(),
            asset: override && override.asset ? String(override.asset) : null,
            kind: override && override.kind ? String(override.kind) : null,
            size: override && override.size ? override.size.slice() : (v.size ? v.size.slice() : null),
            renderLayer: v.renderLayer || (prof && prof.depth && prof.depth.model === 'declarative' ? 'world' : null),
            drawOrder: typeof v.drawOrder === 'number' ? v.drawOrder : null,
            zIndex: typeof v.zIndex === 'number' ? v.zIndex : null,
            animation: v.animation || null
        };
    }

    // --- serialization ------------------------------------------------------------

    /** A plain JSON copy of everything (spec-shaped: feeds GameModel.toSpec()). */
    snapshot() {
        return {
            id: this.id, type: this.type, name: this.name, tags: this.tags.slice(),
            scene: this.scene,
            position: Coords.clone(this.position),
            rotation: Coords.clone(this.rotation),
            scale: Coords.clone(this.scale),
            logic: JSON.parse(JSON.stringify(this.logic)),
            components: JSON.parse(JSON.stringify(this.components)),
            visual: JSON.parse(JSON.stringify(this.visual))
        };
    }

    /** Only what a save file keeps: identity + logic + components + transform. */
    saveSnapshot() {
        return {
            id: this.id,
            position: Coords.clone(this.position),
            rotation: Coords.clone(this.rotation),
            logic: JSON.parse(JSON.stringify(this.logic)),
            components: JSON.parse(JSON.stringify(this.components))
        };
    }

    /** Restore logic/transform from a save snapshot. `visual` is deliberately untouched:
     *  loading a save must not depend on (or change) the render profile. */
    restore(snap) {
        if (!snap || snap.id !== this.id) throw new Error('Entity.restore: id mismatch (' + (snap && snap.id) + ' != ' + this.id + ')');
        if (snap.position) this.position = Coords.from(snap.position);
        if (snap.rotation) this.rotation = Coords.from(snap.rotation);
        if (snap.logic) this.logic = JSON.parse(JSON.stringify(snap.logic));
        if (snap.components) this.components = JSON.parse(JSON.stringify(snap.components));
        return this;
    }

    /** Patch several fields at once (the transactional Edit path uses it). */
    patch(p) {
        const d = p || {};
        if (d.position != null) this.setPosition(d.position);
        if (d.rotation != null) this.rotation = Coords.from(d.rotation);
        if (d.scale != null) this.scale = Coords.from(d.scale);
        if (d.logic != null) Object.assign(this.logic, JSON.parse(JSON.stringify(d.logic)));
        if (d.components != null) Object.assign(this.components, JSON.parse(JSON.stringify(d.components)));
        if (d.tags != null) this.tags = d.tags.slice();
        if (d.scene !== undefined) this.scene = d.scene || null;
        if (d.visual != null) this.visual = JSON.parse(JSON.stringify(Object.assign({}, this.visual, d.visual)));
        return this.snapshot();
    }
}

ArcEntity.COMPONENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @satisfies {Record<string, any>} */
const Entity = {
    /** The canonical entity types (canon: manifest/render-profiles.json). */
    TYPES: (typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.entityTypes : []).slice(),

    ID: /^[A-Za-z_][A-Za-z0-9_-]{0,47}$/,

    /** Validate a spec without building an entity; returns the normalized spec. */
    validate(spec) {
        const s = spec || {};
        if (typeof s.id !== 'string' || !Entity.ID.test(s.id)) {
            throw new Error('Entity: id must match ' + Entity.ID + ' (a stable logical identity), got ' + JSON.stringify(s.id));
        }
        const types = typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.entityTypes : Entity.TYPES;
        if (types.length && types.indexOf(s.type) < 0) {
            throw new Error('Entity ' + s.id + ': type must be one of ' + types.join(', ') + ', got ' + JSON.stringify(s.type));
        }
        if (s.tags != null && !Array.isArray(s.tags)) throw new Error('Entity ' + s.id + ': tags must be an array');
        if (s.logic != null && (typeof s.logic !== 'object' || Array.isArray(s.logic))) throw new Error('Entity ' + s.id + ': logic must be an object');
        if (s.visual != null && (typeof s.visual !== 'object' || Array.isArray(s.visual))) throw new Error('Entity ' + s.id + ': visual must be an object');
        if (s.visual && s.visual.profiles && typeof RENDER_PROFILES !== 'undefined') {
            for (const k of Object.keys(s.visual.profiles)) {
                if (!RENDER_PROFILES.profiles[k]) throw new Error('Entity ' + s.id + ': visual.profiles has an unknown profile ' + JSON.stringify(k));
            }
        }
        return s;
    },

    /** @param {any} spec @returns {ArcEntity} */
    create(spec) { return new ArcEntity(spec); },

    /** @returns {boolean} */
    is(v) { return v instanceof ArcEntity; },

    /** Build entities from a spec list, refusing duplicate ids. @returns {ArcEntity[]} */
    fromSpec(list) {
        const out = [];
        const seen = new Set();
        for (const spec of list || []) {
            if (seen.has(spec && spec.id)) throw new Error('Entity.fromSpec: duplicate id ' + JSON.stringify(spec && spec.id));
            seen.add(spec.id);
            out.push(new ArcEntity(spec));
        }
        return out;
    }
};
