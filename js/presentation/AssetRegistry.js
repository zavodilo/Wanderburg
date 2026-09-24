// AssetRegistry.js — semantic asset roles with per-profile variants and fallbacks.
//
// Gameplay never points at a file. It points at a ROLE:
//
//     player.visual          enemy.zombie.visual        world.tree.visual
//     weapon.pistol.visual   ui.cursor.sprite           audio.step
//
// The registry maps a role to one variant per render profile and resolves it with a
// fallback chain, so a missing asset degrades instead of breaking the game or blocking a
// migration (canon: manifest/asset-schema.json, manifest/render-profiles.json):
//
//     full3d player model missing -> lowpoly model -> isometric model -> primitive
//                                   capsule -> generated debug placeholder
//     2d sprite missing           -> generated placeholder sprite
//
// Resolution never throws: `resolve()` always answers, and says HOW (resolvedBy). That is
// what lets an AI migrate the STRUCTURE of a game first and replace placeholders with
// production assets later.

/** @typedef {{ role: string, profile: string, type: string, asset: string | null, resolvedBy: string, fallbackFrom: string | null, chain: string[], placeholder: any | null, missing: boolean, clips: any | null, frames: any | null, size: any | null, generated: boolean, kind: string | null, overlay: string | null }} AssetResolution */

/** @satisfies {Record<string, any>} */
const AssetRegistry = {
    /** @type {Map<string, any>} role -> registry record */
    _roles: new Map(),
    /** @type {Set<string> | null} the files that exist (set by the tooling; null — trust the spec) */
    _files: null,
    /** @type {Map<string, any>} role -> profile -> variant, the ACTIVE variant's visual mapping */
    _overlay: new Map(),
    /** @type {string | null} the name of the active mapping set */
    _overlayName: null,
    /** Placeholder textures/geometry the engine already generated, by cache key. */
    _generated: new Map(),

    ROLE: /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/,
    PROFILE_KEY: '2.5d',

    // --- registration --------------------------------------------------------------------

    /** Load the spec list (GAME_SPEC.assets). Replaces the registry. */
    fromSpec(list) {
        AssetRegistry._roles.clear();
        for (const rec of list || []) AssetRegistry.register(rec.role, rec);
        return AssetRegistry.roles().length;
    },

    /** Register or update a role. def — manifest/asset-schema.json#/definitions/role. */
    register(role, def) {
        const id = String(role || (def && def.role));
        if (!AssetRegistry.ROLE.test(id)) throw new Error('AssetRegistry: a role is a dotted lowercase name (player.visual), got ' + JSON.stringify(role));
        const d = def || {};
        const rec = AssetRegistry._roles.get(id) || { role: id };
        rec.kind = d.kind || rec.kind || (/(^|\.)(sprite|audio|ui|data)$/.test(id) ? id.split('.').pop() : 'visual');
        if (d.entityType) rec.entityType = d.entityType;
        if (d.tags) rec.tags = d.tags.slice();
        rec.variants = Object.assign({}, rec.variants || {}, d.variants || {});
        if (d.fallbackChain) rec.fallbackChain = d.fallbackChain.slice();
        if (d.placeholder) rec.placeholder = Object.assign({}, rec.placeholder || {}, d.placeholder);
        for (const p of Object.keys(rec.variants)) {
            if (!AssetRegistry.profiles().includes(p)) throw new Error('AssetRegistry ' + id + ': unknown profile ' + JSON.stringify(p));
            AssetRegistry.validateVariant(id, p, rec.variants[p]);
        }
        AssetRegistry._roles.set(id, rec);
        return JSON.parse(JSON.stringify(rec));
    },

    validateVariant(role, profileId, v) {
        if (!v || typeof v !== 'object') throw new Error('AssetRegistry ' + role + '[' + profileId + ']: a variant is an object');
        if (v.type && !AssetRegistry.repTypes().includes(v.type)) {
            throw new Error('AssetRegistry ' + role + '[' + profileId + ']: unknown representation type ' + JSON.stringify(v.type));
        }
        if (v.asset != null && typeof v.asset === 'string' && !/^assets\//.test(v.asset)) {
            throw new Error('AssetRegistry ' + role + '[' + profileId + ']: asset must be a literal path from the game root (assets/…), got ' + JSON.stringify(v.asset));
        }
        if (v.type === 'primitive' && !v.kind) throw new Error('AssetRegistry ' + role + '[' + profileId + ']: a primitive variant needs a kind (box, crate, tree, rock, pole, capsule)');
        return true;
    },

    /** A role record (null when unknown). */
    get(role) { const r = AssetRegistry._roles.get(String(role)); return r ? JSON.parse(JSON.stringify(r)) : null; },

    has(role) { return AssetRegistry._roles.has(String(role)); },

    /** Every role as plain data, sorted. */
    roles() {
        return [...AssetRegistry._roles.values()].map(r => JSON.parse(JSON.stringify(r)))
            .sort((a, b) => (a.role < b.role ? -1 : 1));
    },

    /** Drop a role (a migration never does this: conversions are non-destructive). */
    unregister(role) { return AssetRegistry._roles.delete(String(role)); },

    /** Set/replace one variant of a role (what a migration writes). */
    setVariant(role, profileId, variant) {
        const rec = AssetRegistry._roles.get(String(role));
        if (!rec) throw new Error('AssetRegistry.setVariant: unknown role ' + JSON.stringify(role));
        if (!AssetRegistry.profiles().includes(profileId)) throw new Error('AssetRegistry.setVariant: unknown profile ' + JSON.stringify(profileId));
        AssetRegistry.validateVariant(role, profileId, variant);
        rec.variants[profileId] = JSON.parse(JSON.stringify(variant));
        return JSON.parse(JSON.stringify(rec.variants[profileId]));
    },

    /** The variant declared for a profile (null when the role has none). */
    variant(role, profileId) {
        const rec = AssetRegistry._roles.get(String(role));
        const v = rec && rec.variants[profileId];
        return v ? JSON.parse(JSON.stringify(v)) : null;
    },

    // --- canon ---------------------------------------------------------------------------

    profiles() { return typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.order.slice() : ['2d', '2.5d', 'isometric3d', 'lowpoly3d', 'full3d']; },

    repTypes() { return typeof RENDER_PROFILES !== 'undefined' ? Object.keys(RENDER_PROFILES.representationTypes) : ['sprite', 'billboard', 'model', 'primitive', 'tile', 'terrain', 'particle', 'none']; },

    profile(profileId) { return typeof RENDER_PROFILES !== 'undefined' ? RENDER_PROFILES.profiles[profileId] || null : null; },

    /** The dimension of a profile (2, 2.5, 3) — fallbacks prefer the same or a lower one. */
    dimension(profileId) {
        if (typeof RENDER_PROFILES === 'undefined') return 3;
        return RENDER_PROFILES.dimension[profileId] != null ? RENDER_PROFILES.dimension[profileId] : 3;
    },

    // --- resolution ------------------------------------------------------------------------

    /**
     * The profile order to try for a role: its own explicit chain, otherwise the ladder
     * from the target toward simpler profiles, then the richer ones (a model can still be
     * shown in a 2.5D world). The chain always ends in a generated placeholder.
     */
    fallbackChain(role, profileId) {
        const rec = AssetRegistry._roles.get(String(role));
        if (rec && Array.isArray(rec.fallbackChain) && rec.fallbackChain.length) {
            const c = rec.fallbackChain.slice();
            if (!c.includes(profileId)) c.unshift(profileId);
            return c;
        }
        const all = AssetRegistry.profiles();
        const target = AssetRegistry.dimension(profileId);
        const same = all.filter(p => AssetRegistry.dimension(p) === target && p !== profileId);
        const lower = all.filter(p => AssetRegistry.dimension(p) < target);
        const higher = all.filter(p => AssetRegistry.dimension(p) > target);
        // nearer on the ladder first
        const byDistance = (a, b) => Math.abs(all.indexOf(a) - all.indexOf(profileId)) - Math.abs(all.indexOf(b) - all.indexOf(profileId));
        return [profileId].concat(same.sort(byDistance), lower.sort(byDistance), higher.sort(byDistance));
    },

    /** Is a representation type usable in this profile? */
    allowedIn(type, profileId) {
        const prof = AssetRegistry.profile(profileId);
        if (!prof) return true;
        if (type === 'none') return true;
        const allowed = prof.entityRepresentations.allowed || [];
        // A billboard is a sprite that faces the camera: a profile with sprites takes them.
        if (type === 'billboard' && allowed.includes('sprite')) return true;
        if (type === 'sprite' && allowed.includes('billboard')) return true;
        return allowed.includes(type);
    },

    /** Coerce a resolved representation into something the target profile can draw. */
    coerce(type, profileId) {
        if (AssetRegistry.allowedIn(type, profileId)) return type;
        const prof = AssetRegistry.profile(profileId);
        const allowed = (prof && prof.entityRepresentations.allowed) || [];
        if (type === 'model' || type === 'terrain') return allowed.includes('primitive') ? 'primitive' : (allowed.includes('billboard') ? 'billboard' : (allowed[0] || 'sprite'));
        if (type === 'billboard') return allowed.includes('sprite') ? 'sprite' : (allowed[0] || 'sprite');
        if (type === 'sprite') return allowed.includes('billboard') ? 'billboard' : (allowed[0] || 'model');
        return allowed[0] || type;
    },

    /**
     * Resolve a role for a profile. ALWAYS answers (see AssetResolution): the last resort
     * is a generated placeholder, so a missing asset never breaks a scene or a migration.
     * @returns {AssetResolution}
     */
    resolve(role, profileId, opts) {
        const o = opts || {};
        const pid = profileId || (typeof GameModel !== 'undefined' ? GameModel.renderProfile() : '2d');
        const prof = AssetRegistry.profile(pid);
        const rec = AssetRegistry._roles.get(String(role));
        const base = {
            role: String(role), profile: pid, type: 'none', asset: null,
            resolvedBy: 'unresolved', fallbackFrom: null, chain: [], placeholder: null,
            missing: true, clips: null, frames: null, size: null, generated: false,
            kind: null, overlay: null
        };
        if (!rec) {
            // An unknown role still gets a placeholder: the game shows SOMETHING and the
            // report lists the role as missing.
            base.type = AssetRegistry.defaultTypeFor(o.entityType || 'prop', pid);
            base.placeholder = AssetRegistry.placeholder(null, pid, o.entityType || 'prop', String(role));
            base.chain = AssetRegistry.fallbackChain(String(role), pid);
            return base;
        }
        const chain = AssetRegistry.fallbackChain(rec.role, pid);
        base.chain = chain;
        // the active variant's visual mapping wins over the shared registry
        const ov = AssetRegistry.overlayVariant(rec.role, pid);
        if (ov && AssetRegistry.exists(ov.asset)) {
            // A variant's mapping overrides the shared registry's FILE choice; everything the
            // shared variant still knows (size, frames, clips) carries over underneath it.
            const declared = rec.variants[pid] || {};
            const type = ov.type || declared.type || AssetRegistry.defaultTypeFor(rec.entityType || o.entityType || 'prop', pid);
            const size = ov.size || declared.size;
            const clips = ov.clips || declared.clips;
            const frames = ov.frames || declared.frames;
            return Object.assign({}, base, {
                type: AssetRegistry.coerce(type, pid),
                asset: ov.asset || null,
                resolvedBy: 'variant',
                overlay: AssetRegistry._overlayName,
                missing: false,
                clips: clips ? JSON.parse(JSON.stringify(clips)) : null,
                frames: frames ? JSON.parse(JSON.stringify(frames)) : null,
                size: size ? size.slice() : null,
                generated: !!(ov.generated || declared.generated),
                kind: ov.kind || declared.kind || null
            });
        }
        for (const p of chain) {
            const v = rec.variants[p];
            if (!v) continue;
            const type = v.type || AssetRegistry.defaultTypeFor(rec.entityType || o.entityType || 'prop', p);
            if (!AssetRegistry.exists(v.asset)) continue;
            // A fallback must still be drawable in the TARGET profile: a 3D model is not a
            // fallback for a sprite-only 2D profile (there the placeholder is the answer).
            if (!AssetRegistry.allowedIn(type, pid)) continue;
            const out = Object.assign({}, base, {
                type: AssetRegistry.coerce(type, pid),
                asset: v.asset || null,
                resolvedBy: p === pid ? 'variant' : 'fallback',
                fallbackFrom: p === pid ? null : p,
                missing: false,
                clips: v.clips ? JSON.parse(JSON.stringify(v.clips)) : null,
                frames: v.frames ? JSON.parse(JSON.stringify(v.frames)) : null,
                size: v.size ? v.size.slice() : null,
                generated: !!v.generated,
                kind: v.kind || null
            });
            // A coerced model in a sprite-only profile keeps its file but is drawn as a
            // billboard/primitive; the report says so through `type`.
            return out;
        }
        // nothing on the chain: the placeholder
        base.type = AssetRegistry.defaultTypeFor(rec.entityType || o.entityType || 'prop', pid);
        base.placeholder = AssetRegistry.placeholder(rec, pid, rec.entityType || o.entityType || 'prop', rec.role);
        base.resolvedBy = 'placeholder';
        return base;
    },

    /** The profile's default representation for an entity type. */
    defaultTypeFor(entityType, profileId) {
        const prof = AssetRegistry.profile(profileId);
        if (!prof) return 'none';
        return prof.entityRepresentations.byType[entityType] || prof.entityRepresentations.primary || 'none';
    },

    /**
     * What to show when no file resolves: a generated placeholder. Sprites get a canvas
     * texture with the role name (engine/Sprite2D.js), 3D gets Procedural3D geometry.
     */
    placeholder(rec, profileId, entityType, role) {
        const declared = (rec && rec.placeholder) || null;
        const kind = (declared && declared.kind) || AssetRegistry.PRIMITIVE_FOR[entityType] || 'box';
        const prof = AssetRegistry.profile(profileId);
        const flat = !prof || prof.projection === 'orthographic' && AssetRegistry.dimension(profileId) < 3;
        return {
            kind: flat && kind !== 'tile' ? 'sprite' : kind,
            primitive: AssetRegistry.PRIMITIVE_FOR[entityType] || 'box',
            color: (declared && declared.color) || AssetRegistry.colorFor(role || (rec && rec.role) || 'asset'),
            label: (declared && declared.label) || String(role || (rec && rec.role) || 'asset'),
            size: (declared && declared.size) || null,
            generated: true
        };
    },

    /** entityType -> a Procedural3D-ish stand-in kind. */
    PRIMITIVE_FOR: {
        character: 'capsule', creature: 'capsule', prop: 'crate', structure: 'box',
        vehicle: 'box', projectile: 'pole', item: 'crate', terrain: 'tile', effect: 'pole'
    },

    /** A stable color from a role name, so placeholders are tellable apart. */
    colorFor(role) {
        const h = (typeof GameModel !== 'undefined' ? GameModel.hash(role) : String(role).length.toString(16));
        const n = parseInt(h, 16) || 0;
        const hue = (n % 360);
        return AssetRegistry.hslToHex(hue, 0.45, 0.55);
    },

    hslToHex(h, s, l) {
        const f = (n) => {
            const k = (n + h / 30) % 12;
            const a = s * Math.min(l, 1 - l);
            const v = l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
            return ('0' + Math.round(255 * v).toString(16)).slice(-2);
        };
        return '#' + f(0) + f(8) + f(4);
    },

    // --- variant overlay ------------------------------------------------------------------------
    // A variant's visualMappings override the SHARED registry without changing it: the
    // registry stays one (gameplay and every other variant read the same roles), the active
    // variant only says which file dresses which role in its profile.

    /** Install a mapping set: { role: { profileId: { type, asset, … } } }. null clears it. */
    setOverlay(map, name) {
        AssetRegistry._overlay.clear();
        AssetRegistry._overlayName = name || null;
        for (const [role, perProfile] of Object.entries(map || {})) {
            if (!perProfile || typeof perProfile !== 'object') continue;
            AssetRegistry._overlay.set(String(role), JSON.parse(JSON.stringify(perProfile)));
        }
        return AssetRegistry._overlay.size;
    },

    overlay() {
        const out = {};
        for (const [role, m] of AssetRegistry._overlay) out[role] = JSON.parse(JSON.stringify(m));
        return out;
    },

    overlayName() { return AssetRegistry._overlayName; },

    /** The overlay entry for a role/profile (null — the shared registry decides). */
    overlayVariant(role, profileId) {
        const m = AssetRegistry._overlay.get(String(role));
        const v = m && m[profileId];
        return v ? JSON.parse(JSON.stringify(v)) : null;
    },

    // --- file index --------------------------------------------------------------------------

    /**
     * Tell the registry which asset files really exist. The tooling (tools/migrate.mjs,
     * tools/headless-gate.mjs) scans assets/ and calls this; in the browser it stays null
     * and every declared variant is trusted (a load error still falls back at the engine).
     */
    setFileIndex(files) {
        AssetRegistry._files = files == null ? null : new Set(files.map(String));
        return AssetRegistry._files ? AssetRegistry._files.size : null;
    },

    fileIndex() { return AssetRegistry._files ? [...AssetRegistry._files] : null; },

    /** Does an asset path exist? (no index — trust the declaration; a null path is a primitive/none) */
    exists(asset) {
        if (asset == null) return true;
        if (!AssetRegistry._files) return true;
        return AssetRegistry._files.has(String(asset));
    },

    // --- reports -----------------------------------------------------------------------------

    /** Roles whose target variant is missing or resolved through a fallback/placeholder. */
    missing(profileId) {
        const pid = profileId || (typeof GameModel !== 'undefined' ? GameModel.renderProfile() : null);
        const out = [];
        for (const rec of AssetRegistry._roles.values()) {
            const r = AssetRegistry.resolve(rec.role, pid);
            if (r.missing || r.resolvedBy !== 'variant') out.push({ role: rec.role, profile: pid, resolvedBy: r.resolvedBy, type: r.type, asset: r.asset });
        }
        return out;
    },

    /** Roles with no variant at all for a profile (a migration will generate these). */
    withoutVariant(profileId) {
        return [...AssetRegistry._roles.values()].filter(r => !r.variants[profileId]).map(r => r.role);
    },

    /** The asset path a role resolves to in a profile (null — placeholder). */
    path(role, profileId) { const r = AssetRegistry.resolve(role, profileId); return r.asset; },

    /** Every role/variant pair as flat rows (the editor's asset table, migration reports). */
    table() {
        const rows = [];
        for (const rec of AssetRegistry.roles()) {
            for (const p of AssetRegistry.profiles()) {
                const v = rec.variants[p];
                rows.push({ role: rec.role, profile: p, type: v && v.type ? v.type : null, asset: v ? v.asset || null : null, generated: !!(v && v.generated) });
            }
        }
        return rows;
    },

    /** Machine-readable summary. */
    inspect(profileId) {
        const pid = profileId || (typeof GameModel !== 'undefined' ? GameModel.renderProfile() : null);
        const missing = AssetRegistry.missing(pid);
        return {
            roles: AssetRegistry._roles.size,
            profile: pid,
            variants: AssetRegistry.table().filter(r => r.asset || r.type).length,
            missing: missing.length,
            missingRoles: missing.map(m => m.role),
            placeholders: missing.filter(m => m.resolvedBy === 'placeholder').length,
            fallbacks: missing.filter(m => m.resolvedBy === 'fallback').length,
            fileIndex: AssetRegistry._files ? AssetRegistry._files.size : null
        };
    },

    /** Digest for the migration proof: the registry itself may change, gameplay may not. */
    digest() { return AssetRegistry.roles().map(r => r.role); },

    /** The whole registry as spec data (GAME_SPEC.assets). */
    toSpec() { return AssetRegistry.roles(); },

    /** Remember a generated placeholder (the engine reuses the texture/geometry). */
    markGenerated(key, info) { AssetRegistry._generated.set(String(key), info || true); return key; },

    generated() { return [...AssetRegistry._generated.keys()]; }
};
