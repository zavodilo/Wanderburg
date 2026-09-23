// globals.d.ts — types for the tsc check (check.bat). Not part of the runtime or the archive.
// Here is what cannot be described with JSDoc in a classic script: fields the code attaches to
// foreign objects, and records shared by the game and the editor.

// The kit's bookkeeping on top of engine objects (PlayCanvas classes come from
// libs/playcanvas.d.ts; these interfaces extend them for the JSDoc check).
/** StandardMaterial with the kit's group/toon marks (World3D.applyMaterialConstants). */
interface ArcMaterial extends pc.StandardMaterial {
    /** { group: 'ground' | 'prop' | 'actor', outer?, specPower? }. */
    arc?: { group?: string; outer?: boolean; specPower?: number };
    /** Toon chunks attached (World3D.toon.attach). */
    arcToon?: boolean;
}
/** Entity with the kit's metadata: a model part (pivot/axes) or a location object link. */
interface ArcNode extends pc.Entity {
    meta?: {
        part?: string;
        pivot?: number[];
        axes?: { x: number[]; y: number[]; z: number[] };
        locationObject?: LocationObject;
    };
}
/** Mesh with the kit's caches (ink ribbon, locked positions). */
interface ArcMesh extends pc.Mesh {
    _arcPosCache?: Float32Array;
    _arcInkCache?: { angle: number; mesh: pc.Mesh | null };
}

interface Window {
    /** main.js: the game's location, camera and game logic — for the console and game code. */
    app?: { location: Location3D; camera: CameraController; game: Game | null };
}

/** UI_LAYOUT record (UILayout.js, written by the editor's UI tab); fields by kind — UI.DEFAULTS. */
interface UIRecord {
    id: string;
    /** 'text' | 'panel' | 'bar' | 'button' */
    kind: string;
    /** One of 9 screen points: 'top-left' … 'bottom-right' */
    anchor: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
    text?: string;
    fontSize?: number;
    /** Text color; bar — the filled part. '#rrggbb' */
    color?: string;
    shadow?: string;
    fill?: string;
    border?: string;
    radius?: number;
    /** Bar fill 0..1 */
    value?: number;
    alpha?: number;
    /** 0 — hidden until the game calls show() */
    visible?: number;
}

/** LOCATION_OBJECTS record (Objects.js, written by the editor). */
interface LocationObjectDef {
    name: string;
    /** Path from the game root: assets/models/….fbx */
    model: string;
    /** 'actor' — a main object of the frame, 'prop' — scenery */
    kind: string;
    x: number;
    y: number;
    /** px above the ground */
    h: number;
    /** [x, y, z] degrees; y — heading */
    rot: number[];
    scale: number[];
    anim?: { part: string; axis: string; speed: number; dir: string };
    /** Looped animation clip of a glTF model ('idle'); none — the rest pose. */
    clip?: string;
    /** Procedural3D kind used when `model` is missing/unreadable ('tree' | 'rock' | …). */
    fallback?: string;
    /** A group name for game code: location.findByTag('coin'). */
    tag?: string;
    /** Placed but not in the scene until location.setHidden(rec, false). */
    hidden?: boolean;
    /** A sound standing at the object (Sound3D): src — assets/sounds/…, looped unless loop is false. */
    sound?: { src: string; volume?: number; loop?: boolean; falloffMin?: number; falloffMax?: number };
}

/** Location object: Location3D.objects. */
interface LocationObject {
    def: LocationObjectDef;
    /** Model root entity; null until it has loaded or if it was not found. */
    mesh: pc.Entity | null;
    error: string | null;
    loaded: Promise<LocationObject>;
    /** Part spin state (Location3D.spinPart). */
    spin?: {
        name: string;
        root: pc.Entity;
        mesh: pc.Entity | null;
        angle: number;
        axis: pc.Vec3;
    } | null;
    /** The clip Location3D.playClip last asked for and the model root it asked. */
    clip?: string;
    /** True when the model file was missing and Procedural3D built a stand-in. */
    fallbackUsed?: boolean;
    clipRoot?: pc.Entity | null;
    /** The playing def.sound and what it was started from (Location3D.updateSound). */
    sound?: SoundHandle | null;
    soundKey?: string;
}

