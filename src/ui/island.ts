import { REWARDS, SOURCES, shelterTier, type GatherSource, type RewardItem } from "../engine/camp.js";
import { Rng } from "../engine/rng.js";

/**
 * A walkable top-down island drawn on a canvas, with no image assets.
 *
 * The player walks with WASD / arrow keys or by tapping, and interacts with castaways,
 * landmarks, palms, fruit trees and fishing rocks by walking up to them and pressing E
 * (or tapping again). Computer castaways walk out to do their real chores for the day.
 */

export type Interaction =
  | { kind: "castaway"; id: string }
  | { kind: "bonfire" }
  | { kind: "dig" }
  | { kind: "hut" }
  | { kind: "arena" }
  | { kind: "resource"; index: number };

export interface IslandCastaway {
  id: string;
  name: string;
  crew: string;
  isYou: boolean;
  /** A computer castaway's real chore today: how many trips to which kind of spot. */
  job?: { source: GatherSource; trips: number } | null;
}

/** What the island needs to know to draw a camp. */
export interface IslandCamp {
  materials: number;
  food: number;
  items: RewardItem[];
}

export interface IslandOptions {
  castaways: IslandCastaway[];
  merged: boolean;
  yourCrew: string;
  /** Fixed for the whole season, so the trees stay where they are. */
  worldSeed: number;
  /** Changes every round: who wanders where. */
  seed: number;
  onInteract: (what: Exclude<Interaction, { kind: "resource" }>) => void;
  /** Called with a line like "Ana and Bo slipped off to talk." */
  onRumor: (text: string) => void;
  /** One trip to gather. Returns how much was brought back, or null if they're too tired. */
  onGather: (id: string, source: GatherSource) => number | null;
  /** Live state of a camp, for drawing its shelter, food and gear. */
  camp: (crew: string) => IslandCamp;
  /** 0 at the start of your day, 1 when your energy is spent. Sets the light. */
  dayProgress: () => number;
}

interface Work {
  res: Resource;
  start: number;
  end: number;
}

interface Walker {
  id: string;
  name: string;
  crew: string;
  isYou: boolean;
  x: number;
  y: number;
  tx: number;
  ty: number;
  wait: number;
  facing: 1 | -1;
  bubble: { text: string; until: number } | null;
  pairedWith: string | null;
  job: { source: GatherSource; trips: number; startAt: number } | null;
  target: Resource | null;
  work: Work | null;
  look: { skin: string; hair: string; hairStyle: number };
}

interface Landmark {
  kind: "bonfire" | "dig" | "hut" | "arena";
  x: number;
  y: number;
  label: string;
  crew?: string;
}

interface Resource {
  index: number;
  kind: GatherSource;
  x: number;
  y: number;
  size: number;
  /** Trips left this round (fishing never runs out). */
  left: number;
  max: number;
  lean: number;
  phase: number;
  hue: number;
}

interface Floater {
  x: number;
  y: number;
  text: string;
  color: string;
  start: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  size: number;
}

const WORLD_W = 2000;
const WORLD_H = 1400;
const CX = 1000;
const CY = 700;
const RX = 880;
const RY = 570;
const SPEED = 200; // world px per second
const REACH = 60;
/** How far you can see. Castaways further away are hidden, so nobody can track who wanders off to dig. */
export const VISION = 250;
const WORK_MS: Record<GatherSource, number> = { palm: 900, fruit: 700, fish: 1700 };
const TREE_YIELD: Record<GatherSource, number> = { palm: 4, fruit: 3, fish: Infinity };

export const CREW_COLORS: Record<string, string> = {
  Coral: "#ff7f6b",
  Driftwood: "#e0b36e",
  merged: "#5fd3c2",
};

const SKIN = ["#f3cfa8", "#e3b088", "#c98c5f", "#a96c45", "#7c4a2d", "#5c3620"];
const HAIR = ["#22160f", "#3d2618", "#6e4322", "#b88a4a", "#141414", "#8a5636", "#d8c39a"];

function wobble(theta: number): number {
  return 1 + 0.07 * Math.sin(3 * theta) + 0.045 * Math.sin(7 * theta + 1.3);
}

/** Normalised distance from the island centre: 1 is the waterline. */
function islandRadius(x: number, y: number): number {
  const dx = (x - CX) / RX;
  const dy = (y - CY) / RY;
  return Math.hypot(dx, dy) / wobble(Math.atan2(dy, dx));
}

function shorePoint(theta: number, scale: number): [number, number] {
  const w = wobble(theta);
  return [CX + Math.cos(theta) * RX * w * scale, CY + Math.sin(theta) * RY * w * scale];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export class Island {
  private ctx: CanvasRenderingContext2D;
  private walkers = new Map<string, Walker>();
  private landmarks: Landmark[] = [];
  private resources: Resource[] = [];
  private terrain: HTMLCanvasElement;
  private keys = new Set<string>();
  private moveTarget: { x: number; y: number } | null = null;
  private pendingInteract: Interaction | null = null;
  private raf = 0;
  private last = 0;
  private rng: Rng;
  private cam = { x: CX, y: CY };
  private toast: { text: string; until: number } | null = null;
  private nearby: Interaction | null = null;
  private floaters: Floater[] = [];
  private particles: Particle[] = [];
  private disposed = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: IslandOptions,
  ) {
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    this.rng = new Rng(opts.seed);
    this.buildWorld();
    this.terrain = this.paintTerrain();
    this.bindInput();
    this.resize();
    const me = this.you();
    this.cam = { x: me.x, y: me.y };
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  // ---------- public ----------

  say(id: string, text: string, ms = 4500): void {
    const w = this.walkers.get(id);
    if (w) w.bubble = { text, until: performance.now() + ms };
  }

  showToast(text: string, ms = 2800): void {
    this.toast = { text, until: performance.now() + ms };
  }

  /** Programmatic interaction with whatever is in reach (used by the on-screen button). */
  interact(): void {
    const what = this.nearby;
    if (!what) return;
    if (what.kind === "resource") this.startWork(this.you(), this.resources[what.index]!, performance.now());
    else this.opts.onInteract(what);
  }

  /** What the player can currently interact with, for the on-screen prompt. */
  get prompt(): string | null {
    return this.nearby ? this.describe(this.nearby) : null;
  }

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    for (const fn of this.cleanup) fn();
  }

  // ---------- world ----------

  private campFor(crew: string): { x: number; y: number } {
    if (this.opts.merged || crew === "merged") return { x: 1000, y: 760 };
    if (crew === "Coral") return { x: 560, y: 760 };
    if (crew === "Driftwood") return { x: 1440, y: 760 };
    const a = (hash(crew) % 628) / 100;
    return { x: CX + Math.cos(a) * 400, y: CY + Math.sin(a) * 250 };
  }

  private crewsOnIsland(): string[] {
    return this.opts.merged ? ["merged"] : [...new Set(this.opts.castaways.map((c) => c.crew))];
  }

  private buildWorld(): void {
    // The layout comes from the season's seed, so trees and rocks stay put from round to round.
    const world = new Rng(this.opts.worldSeed);
    for (const crew of this.crewsOnIsland()) {
      const c = this.campFor(crew);
      this.landmarks.push({ kind: "bonfire", x: c.x, y: c.y, label: crew === "merged" ? "Merged camp" : `${crew} camp`, crew });
    }
    this.landmarks.push({ kind: "hut", x: 1000, y: 330, label: "Confession hut" });
    this.landmarks.push({ kind: "arena", x: 1000, y: 1150, label: "Challenge beach" });
    for (const theta of [3.5, 5.6, 0.55, 2.4]) {
      const [x, y] = shorePoint(theta, 0.92);
      this.landmarks.push({ kind: "dig", x, y, label: "Dig spot" });
    }

    const add = (kind: GatherSource, x: number, y: number, size: number) =>
      this.resources.push({
        index: this.resources.length,
        kind,
        x,
        y,
        size,
        left: TREE_YIELD[kind],
        max: TREE_YIELD[kind],
        lean: (world.next() - 0.5) * 0.5,
        phase: world.next() * Math.PI * 2,
        hue: world.next(),
      });

    // Fishing rocks all around the shore.
    for (let i = 0; i < 9; i++) {
      const theta = (i / 9) * Math.PI * 2 + 0.3;
      const [x, y] = shorePoint(theta, 0.985);
      if (this.landmarks.some((l) => Math.hypot(l.x - x, l.y - y) < 120)) continue;
      add("fish", x, y, 1);
    }

    const clear = (x: number, y: number, gap: number) =>
      !this.landmarks.some((l) => Math.hypot(l.x - x, l.y - y) < (l.kind === "bonfire" ? 170 : 100)) &&
      !this.resources.some((r) => Math.hypot(r.x - x, r.y - y) < gap);

    // Fruit trees grow inland.
    for (let tries = 0; tries < 2000 && this.resources.filter((r) => r.kind === "fruit").length < 34; tries++) {
      const x = 150 + world.next() * 1700;
      const y = 150 + world.next() * 1100;
      if (islandRadius(x, y) > 0.72 || !clear(x, y, 60)) continue;
      add("fruit", x, y, 0.85 + world.next() * 0.35);
    }
    // A lot of palms: the whole island is a palm forest, thicker inland.
    for (let tries = 0; tries < 6000 && this.resources.filter((r) => r.kind === "palm").length < 170; tries++) {
      const x = 120 + world.next() * 1760;
      const y = 120 + world.next() * 1160;
      const r = islandRadius(x, y);
      if (r > 0.9 || !clear(x, y, 50)) continue;
      if (r > 0.8 && world.chance(0.5)) continue;
      add("palm", x, y, 0.85 + world.next() * 0.4);
    }

    for (const c of this.opts.castaways) {
      const home = this.campFor(c.crew);
      const angle = this.rng.next() * Math.PI * 2;
      const x = home.x + Math.cos(angle) * 80;
      const y = home.y + Math.sin(angle) * 55 + 30;
      const h = hash(c.id + c.name);
      this.walkers.set(c.id, {
        ...c,
        x,
        y,
        tx: x,
        ty: y,
        wait: this.rng.next() * 2,
        facing: 1,
        bubble: null,
        pairedWith: null,
        job: c.job && c.job.trips > 0 ? { ...c.job, startAt: 2 + this.rng.next() * 8 } : null,
        target: null,
        work: null,
        look: { skin: SKIN[h % SKIN.length]!, hair: HAIR[(h >> 4) % HAIR.length]!, hairStyle: (h >> 8) % 3 },
      });
    }
  }

  // ---------- terrain (painted once) ----------

  private paintTerrain(): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = WORLD_W;
    c.height = WORLD_H;
    const g = c.getContext("2d") as CanvasRenderingContext2D;
    const r = new Rng(this.opts.worldSeed ^ 0x5eed);
    const blob = (scale: number, jag = 0) => {
      g.beginPath();
      for (let i = 0; i <= 240; i++) {
        const theta = (i / 240) * Math.PI * 2;
        const j = jag ? jag * (Math.sin(theta * 23) * 0.5 + Math.sin(theta * 41 + 2) * 0.3 + Math.sin(theta * 67 + 1) * 0.2) : 0;
        const [x, y] = shorePoint(theta, scale + j);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.closePath();
    };
    const radial = (inner: string, outer: string, scale: number) => {
      const grad = g.createRadialGradient(CX, CY, 0, CX, CY, Math.max(RX, RY) * scale);
      grad.addColorStop(0, inner);
      grad.addColorStop(1, outer);
      return grad;
    };

    // Shallows and reef.
    blob(1.16);
    g.fillStyle = "rgba(64,196,205,0.30)";
    g.fill();
    blob(1.08);
    g.fillStyle = "rgba(90,214,214,0.45)";
    g.fill();
    // Wet sand, then dry sand.
    blob(1.012);
    g.fillStyle = "#c9b27c";
    g.fill();
    blob(0.995);
    g.fillStyle = radial("#f1dca6", "#e6cf93", 1);
    g.fill();
    // Sand speckles and shells.
    g.save();
    blob(0.995);
    g.clip();
    for (let i = 0; i < 5000; i++) {
      const x = r.next() * WORLD_W;
      const y = r.next() * WORLD_H;
      g.fillStyle = r.chance(0.5) ? "rgba(160,130,80,0.18)" : "rgba(255,250,230,0.35)";
      g.fillRect(x, y, 2, 2);
    }
    for (let i = 0; i < 60; i++) {
      const theta = r.next() * Math.PI * 2;
      const [x, y] = shorePoint(theta, 0.9 + r.next() * 0.08);
      g.fillStyle = r.chance(0.5) ? "#fff4e6" : "#f2b8a8";
      g.beginPath();
      g.ellipse(x, y, 3, 2, r.next() * 3, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();

    // Grass, with a ragged edge where it meets the sand, and darker jungle inland.
    blob(0.875, 0.018);
    g.fillStyle = "rgba(90,140,60,0.55)";
    g.fill();
    blob(0.86, 0.02);
    g.fillStyle = radial("#4e8f3a", "#69a74a", 0.9);
    g.fill();
    g.save();
    blob(0.86, 0.02);
    g.clip();
    for (let i = 0; i < 420; i++) {
      const x = r.next() * WORLD_W;
      const y = r.next() * WORLD_H;
      const rad = 20 + r.next() * 70;
      g.fillStyle = ["rgba(40,100,40,0.18)", "rgba(120,170,70,0.16)", "rgba(70,120,45,0.2)"][r.int(3)]!;
      g.beginPath();
      g.ellipse(x, y, rad, rad * 0.7, r.next() * 3, 0, Math.PI * 2);
      g.fill();
    }
    blob(0.62, 0.03);
    g.fillStyle = "rgba(30,80,35,0.22)";
    g.fill();
    // Grass tufts.
    g.strokeStyle = "rgba(30,70,25,0.45)";
    g.lineWidth = 1.4;
    for (let i = 0; i < 2600; i++) {
      const x = r.next() * WORLD_W;
      const y = r.next() * WORLD_H;
      g.beginPath();
      g.moveTo(x - 3, y);
      g.lineTo(x - 1, y - 6);
      g.moveTo(x, y);
      g.lineTo(x + 1, y - 7);
      g.moveTo(x + 3, y);
      g.lineTo(x + 4, y - 5);
      g.stroke();
    }
    g.restore();

    // Dirt paths between camps, the hut, the challenge beach and the nearest fishing rocks.
    const hut = this.landmarks.find((l) => l.kind === "hut")!;
    const arena = this.landmarks.find((l) => l.kind === "arena")!;
    const path = (ax: number, ay: number, bx: number, by: number, bend: number) => {
      for (const [w, col] of [
        [26, "rgba(150,115,70,0.35)"],
        [16, "rgba(196,160,104,0.75)"],
      ] as const) {
        g.strokeStyle = col;
        g.lineWidth = w;
        g.lineCap = "round";
        g.beginPath();
        g.moveTo(ax, ay);
        g.quadraticCurveTo((ax + bx) / 2 + bend, (ay + by) / 2 + 30, bx, by);
        g.stroke();
      }
    };
    for (const l of this.landmarks.filter((x) => x.kind === "bonfire")) {
      path(l.x, l.y, hut.x, hut.y + 20, l.x < CX ? -60 : 60);
      path(l.x, l.y, arena.x, arena.y - 20, l.x < CX ? -40 : 40);
      const fish = this.resources.filter((x) => x.kind === "fish").sort((a, b) => Math.hypot(a.x - l.x, a.y - l.y) - Math.hypot(b.x - l.x, b.y - l.y))[0];
      if (fish) path(l.x, l.y, fish.x, fish.y, 0);
    }

    // Camp clearings.
    for (const l of this.landmarks.filter((x) => x.kind === "bonfire")) {
      const grad = g.createRadialGradient(l.x, l.y, 10, l.x, l.y, 150);
      grad.addColorStop(0, "rgba(205,170,115,0.95)");
      grad.addColorStop(0.75, "rgba(195,160,105,0.75)");
      grad.addColorStop(1, "rgba(195,160,105,0)");
      g.fillStyle = grad;
      g.beginPath();
      g.ellipse(l.x, l.y - 20, 165, 120, 0, 0, Math.PI * 2);
      g.fill();
    }

    // Flowers and rocks.
    for (let i = 0; i < 260; i++) {
      const x = r.next() * WORLD_W;
      const y = r.next() * WORLD_H;
      if (islandRadius(x, y) > 0.82) continue;
      if (this.landmarks.some((l) => Math.hypot(l.x - x, l.y - y) < 120)) continue;
      g.fillStyle = ["#ffd166", "#ef476f", "#ffffff", "#c77dff"][r.int(4)]!;
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        g.arc(x + (r.next() - 0.5) * 12, y + (r.next() - 0.5) * 8, 2, 0, Math.PI * 2);
        g.fill();
      }
    }
    for (let i = 0; i < 70; i++) {
      const theta = r.next() * Math.PI * 2;
      const [x, y] = r.chance(0.6) ? shorePoint(theta, 0.88 + r.next() * 0.1) : [150 + r.next() * 1700, 150 + r.next() * 1100];
      if (islandRadius(x, y) > 1) continue;
      if (this.landmarks.some((l) => Math.hypot(l.x - x, l.y - y) < 110)) continue;
      const s = 6 + r.next() * 12;
      g.fillStyle = "rgba(0,0,0,0.18)";
      g.beginPath();
      g.ellipse(x + 3, y + 4, s, s * 0.55, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#8f8a80";
      g.beginPath();
      g.ellipse(x, y, s, s * 0.65, r.next(), 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.beginPath();
      g.ellipse(x - s * 0.3, y - s * 0.25, s * 0.45, s * 0.25, 0, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }

  // ---------- input ----------

  private bindInput(): void {
    const typing = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const k = e.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k)) {
        this.keys.add(k);
        this.moveTarget = null;
        this.pendingInteract = null;
        e.preventDefault();
      }
      if (k === "e" || k === " ") {
        this.keys.add("e");
        if (!e.repeat) this.interact();
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      this.keys.delete(k === " " ? "e" : k);
    };
    const blur = () => this.keys.clear();
    const click = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left + this.cam.x - rect.width / 2;
      const y = e.clientY - rect.top + this.cam.y - rect.height / 2;
      const target = this.thingAt(x, y);
      if (target && this.nearby && JSON.stringify(target) === JSON.stringify(this.nearby)) {
        this.interact();
        return;
      }
      this.moveTarget = { x, y };
      this.pendingInteract = target;
    };
    const resize = () => this.resize();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    this.canvas.addEventListener("pointerdown", click);
    this.cleanup.push(
      () => window.removeEventListener("keydown", down),
      () => window.removeEventListener("keyup", up),
      () => window.removeEventListener("blur", blur),
      () => window.removeEventListener("resize", resize),
      () => this.canvas.removeEventListener("pointerdown", click),
    );
  }

  private thingAt(x: number, y: number): Interaction | null {
    for (const w of this.walkers.values()) {
      if (!w.isYou && this.canSee(w) && Math.hypot(w.x - x, w.y - y + 12) < 24) return { kind: "castaway", id: w.id };
    }
    for (const l of this.landmarks) {
      if (Math.hypot(l.x - x, l.y - y) < 44) return { kind: l.kind } as Interaction;
    }
    let best: { d: number; r: Resource } | null = null;
    for (const r of this.resources) {
      // Tapping the crown of a tree counts as well as its trunk.
      const d = Math.min(Math.hypot(r.x - x, r.y - y), Math.hypot(r.x - x, r.y - 40 * r.size - y));
      if (d < 30 && (!best || d < best.d)) best = { d, r };
    }
    return best ? { kind: "resource", index: best.r.index } : null;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 460;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ---------- simulation ----------

  /** Whether the player can see this castaway right now (line of sight is a simple radius). */
  canSee(w: { x: number; y: number }): boolean {
    const me = this.you();
    return Math.hypot(w.x - me.x, w.y - me.y) <= VISION;
  }

  private you(): Walker {
    for (const w of this.walkers.values()) if (w.isYou) return w;
    throw new Error("No player walker");
  }

  /** Where a castaway stands to work at a spot. */
  private standPoint(r: Resource, side: number): { x: number; y: number } {
    if (r.kind === "fish") {
      const dx = CX - r.x;
      const dy = CY - r.y;
      const d = Math.hypot(dx, dy);
      return { x: r.x + (dx / d) * 34 + side * 10, y: r.y + (dy / d) * 26 };
    }
    return { x: r.x + side * 20, y: r.y + 8 };
  }

  private startWork(w: Walker, r: Resource, now: number): void {
    if (w.work) return;
    if (r.left <= 0) {
      if (w.isYou) this.showToast(r.kind === "palm" ? "This palm is stripped bare for today. Try another." : "No ripe fruit left on this tree today.");
      return;
    }
    w.facing = r.x >= w.x ? 1 : -1;
    w.work = { res: r, start: now, end: now + WORK_MS[r.kind] };
  }

  private finishWork(w: Walker, now: number): void {
    const work = w.work!;
    w.work = null;
    const r = work.res;
    if (r.left <= 0) return;
    const got = this.opts.onGather(w.id, r.kind);
    const visible = w.isYou || this.canSee(w);
    if (got === null) {
      if (w.isYou) this.showToast("You're worn out for today. Talk, scheme, or head to the challenge.", 3500);
      if (w.job) w.job = null;
      return;
    }
    r.left -= 1;
    if (visible) {
      const supply = SOURCES[r.kind].supply;
      this.floaters.push({
        x: w.x,
        y: w.y - 40,
        text: supply === "wood" ? `+${got} materials` : `+${got} food`,
        color: supply === "wood" ? "#ffe3a3" : "#b8f5a0",
        start: now,
      });
      this.burst(r, now);
    }
    if (w.isYou && this.keys.has("e") && r.left > 0) this.startWork(w, r, now);
    if (w.job) {
      w.job.trips -= 1;
      if (w.job.trips <= 0) w.job = null;
      if (r.left <= 0 || !w.job) w.target = null;
      w.wait = 0.2;
    }
  }

  private burst(r: Resource, now: number): void {
    const colors = r.kind === "palm" ? ["#3f8a43", "#6dbb55", "#8a6a3d"] : r.kind === "fruit" ? ["#ff9f1c", "#ffd166", "#4a9c40"] : ["#bfefff", "#ffffff"];
    const top = r.kind === "fish" ? r.y : r.y - 50 * r.size;
    for (let i = 0; i < 9; i++) {
      this.particles.push({
        x: r.x + (Math.random() - 0.5) * 20,
        y: top + (Math.random() - 0.5) * 16,
        vx: (Math.random() - 0.5) * 80,
        vy: -40 - Math.random() * 60,
        life: 0,
        max: 0.6 + Math.random() * 0.5,
        color: colors[i % colors.length]!,
        size: 2 + Math.random() * 3,
      });
    }
    void now;
  }

  private step(dt: number, now: number): void {
    const me = this.you();
    let dx = 0;
    let dy = 0;
    if (this.keys.has("w") || this.keys.has("arrowup")) dy -= 1;
    if (this.keys.has("s") || this.keys.has("arrowdown")) dy += 1;
    if (this.keys.has("a") || this.keys.has("arrowleft")) dx -= 1;
    if (this.keys.has("d") || this.keys.has("arrowright")) dx += 1;
    if (!dx && !dy && this.moveTarget) {
      const tx = this.moveTarget.x - me.x;
      const ty = this.moveTarget.y - me.y;
      const dist = Math.hypot(tx, ty);
      const stopAt = this.pendingInteract ? REACH * 0.6 : 4;
      if (dist <= stopAt) {
        this.moveTarget = null;
        if (this.pendingInteract) {
          const what = this.pendingInteract;
          this.pendingInteract = null;
          this.nearby = what;
          this.interact();
        }
      } else {
        dx = tx / dist;
        dy = ty / dist;
      }
    }
    if (dx || dy) {
      me.work = null; // walking away stops the work
      const len = Math.hypot(dx, dy);
      if (dx) me.facing = dx > 0 ? 1 : -1;
      this.tryMove(me, (dx / len) * SPEED * dt, (dy / len) * SPEED * dt);
    }
    if (me.work && now >= me.work.end) this.finishWork(me, now);

    for (const w of this.walkers.values()) {
      if (w.isYou) continue;
      if (w.bubble && w.bubble.until < now) w.bubble = null;
      if (w.work) {
        if (now >= w.work.end) this.finishWork(w, now);
        continue;
      }
      const tx = w.tx - w.x;
      const ty = w.ty - w.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 3) {
        const s = Math.min(dist, SPEED * 0.55 * dt);
        if (Math.abs(tx) > 1) w.facing = tx > 0 ? 1 : -1;
        this.tryMove(w, (tx / dist) * s, (ty / dist) * s);
        if (Math.hypot(w.tx - w.x, w.ty - w.y) > dist - s * 0.3) {
          // Stuck against the shore: give up on this spot.
          w.tx = w.x;
          w.ty = w.y;
          w.target = null;
        }
        continue;
      }
      if (w.target && w.job && !w.pairedWith) {
        this.startWork(w, w.target, now);
        if (!w.work) w.target = null;
        continue;
      }
      if ((w.wait -= dt) <= 0) {
        if (w.job && !w.pairedWith && w.job.startAt <= now / 1000 - this.startTime) this.goToWork(w);
        else this.pickWanderTarget(w);
      }
    }

    if (this.rng.chance(dt * 0.05)) this.startSideConversation(now);

    for (const p of this.particles) {
      p.life += dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 160 * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
    this.floaters = this.floaters.filter((f) => now - f.start < 1400);

    this.nearby = me.work ? null : this.findNearby(me);
    this.cam.x += (me.x - this.cam.x) * Math.min(1, dt * 6);
    this.cam.y += (me.y - this.cam.y) * Math.min(1, dt * 6);
  }

  private startTime = performance.now() / 1000;

  /** A castaway with a chore heads for the nearest spot that still has something to give. */
  private goToWork(w: Walker): void {
    const job = w.job!;
    const home = this.campFor(w.crew);
    const options = this.resources.filter((r) => r.kind === job.source && r.left > 0);
    if (!options.length) {
      w.job = null;
      return this.pickWanderTarget(w);
    }
    // Prefer spots near their own camp, with a little randomness so they spread out.
    const score = (r: Resource) => Math.hypot(r.x - w.x, r.y - w.y) * 0.6 + Math.hypot(r.x - home.x, r.y - home.y) * 0.4 + this.rng.next() * 160;
    const r = options.sort((a, b) => score(a) - score(b))[0]!;
    const p = this.standPoint(r, this.rng.chance(0.5) ? 1 : -1);
    w.target = r;
    w.tx = p.x;
    w.ty = p.y;
  }

  private tryMove(w: Walker, dx: number, dy: number): void {
    const nx = w.x + dx;
    const ny = w.y + dy;
    if (islandRadius(nx, ny) < 0.96) {
      w.x = nx;
      w.y = ny;
    } else if (islandRadius(nx, w.y) < 0.96) {
      w.x = nx;
    } else if (islandRadius(w.x, ny) < 0.96) {
      w.y = ny;
    }
  }

  /**
   * Castaways leave camp for all sorts of reasons (water, firewood, fishing, a walk, a dig),
   * so being away from camp never gives a searcher away on its own.
   */
  private pickWanderTarget(w: Walker): void {
    if (w.pairedWith) {
      const other = this.walkers.get(w.pairedWith);
      if (other) other.pairedWith = null;
      w.pairedWith = null;
    }
    const roll = this.rng.next();
    const home = this.campFor(w.crew);
    let target: { x: number; y: number } | null = null;
    if (roll < 0.12) {
      const spot = this.rng.pick(this.landmarks.filter((l) => l.kind === "dig"));
      target = { x: spot.x + (this.rng.next() - 0.5) * 30, y: spot.y + (this.rng.next() - 0.5) * 20 };
    } else if (roll < 0.4) {
      for (let i = 0; i < 12 && !target; i++) {
        const x = 150 + this.rng.next() * 1700;
        const y = 150 + this.rng.next() * 1100;
        if (islandRadius(x, y) < 0.93) target = { x, y };
      }
    }
    for (let i = 0; i < 10 && !target; i++) {
      const angle = this.rng.next() * Math.PI * 2;
      const r = 50 + this.rng.next() * 120;
      const x = home.x + Math.cos(angle) * r;
      const y = home.y + Math.sin(angle) * r * 0.7 + 20;
      if (islandRadius(x, y) < 0.9) target = { x, y };
    }
    if (target) {
      w.tx = target.x;
      w.ty = target.y;
    }
    w.wait = 1.5 + this.rng.next() * 4;
  }

  /** Two castaways from the same camp wander off together. Everyone can see it; nobody hears it. */
  private startSideConversation(now: number): void {
    const free = [...this.walkers.values()].filter((w) => !w.isYou && !w.pairedWith && !w.work && !w.target);
    const a = free.length ? this.rng.pick(free) : null;
    if (!a) return;
    const partners = free.filter((w) => w !== a && w.crew === a.crew);
    if (!partners.length) return;
    const b = this.rng.pick(partners);
    const home = this.campFor(a.crew);
    const angle = this.rng.next() * Math.PI * 2;
    const x = home.x + Math.cos(angle) * 200;
    const y = home.y + Math.sin(angle) * 150;
    if (islandRadius(x, y) > 0.9) return;
    a.pairedWith = b.id;
    b.pairedWith = a.id;
    a.tx = x - 14;
    b.tx = x + 14;
    a.ty = b.ty = y;
    a.wait = b.wait = 6;
    a.bubble = { text: "…", until: now + 7000 };
    b.bubble = { text: "…", until: now + 7000 };
    // You only learn about it if you can see them leave together.
    if (this.canSee(a) && this.canSee(b)) this.opts.onRumor(`You notice ${a.name} and ${b.name} slip off to talk.`);
  }

  private findNearby(me: Walker): Interaction | null {
    let best: { d: number; what: Interaction } | null = null;
    const consider = (d: number, what: Interaction) => {
      if (d < REACH && (!best || d < best.d)) best = { d, what };
    };
    for (const w of this.walkers.values()) {
      if (w.isYou) continue;
      consider(Math.hypot(w.x - me.x, w.y - me.y) - 8, { kind: "castaway", id: w.id });
    }
    for (const l of this.landmarks) {
      if (l.kind === "bonfire" && !this.opts.merged && l.crew !== this.opts.yourCrew) continue;
      consider(Math.hypot(l.x - me.x, l.y - me.y) - 10, { kind: l.kind } as Interaction);
    }
    for (const r of this.resources) {
      const p = this.standPoint(r, me.x >= r.x ? 1 : -1);
      // A stripped tree only gets offered if nothing better is in reach.
      const d = Math.min(Math.hypot(r.x - me.x, r.y - me.y), Math.hypot(p.x - me.x, p.y - me.y)) + (r.left > 0 ? 4 : 40);
      consider(d, { kind: "resource", index: r.index });
    }
    return (best as { d: number; what: Interaction } | null)?.what ?? null;
  }

  private describe(what: Interaction): string {
    switch (what.kind) {
      case "castaway":
        return `Talk to ${this.walkers.get(what.id)?.name ?? "them"}`;
      case "bonfire":
        return this.opts.merged ? "Talk to the whole camp" : "Talk to your crew";
      case "dig":
        return "Dig for a relic";
      case "hut":
        return "Record a confessional";
      case "arena":
        return "Start the challenge";
      case "resource": {
        const r = this.resources[what.index]!;
        if (r.kind === "palm") return r.left > 0 ? `Cut fronds and branches for the shelter (${r.left} left here)` : "Stripped bare for today";
        if (r.kind === "fruit") return r.left > 0 ? `Pick fruit (${r.left} left here)` : "No ripe fruit left today";
        return "Fish from the rocks (2 energy)";
      }
    }
  }

  // ---------- drawing ----------

  private frame(t: number): void {
    if (this.disposed) return;
    const dt = Math.min(0.05, (t - (this.last || t)) / 1000);
    this.last = t;
    this.step(dt, t);
    this.draw(t);
    this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  private draw(t: number): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const ox = Math.round(w / 2 - this.cam.x);
    const oy = Math.round(h / 2 - this.cam.y);
    const view = { x0: -ox - 120, y0: -oy - 160, x1: -ox + w + 120, y1: -oy + h + 160 };

    // Ocean.
    const sea = ctx.createLinearGradient(0, 0, 0, h);
    sea.addColorStop(0, "#0e4a6b");
    sea.addColorStop(1, "#0b3a57");
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 2;
    for (let y = Math.floor(view.y0 / 40) * 40; y < view.y1; y += 40) {
      ctx.beginPath();
      for (let x = view.x0; x <= view.x1; x += 24) {
        const yy = y + Math.sin(x / 70 + t / 1100 + y * 0.13) * 5;
        if (x === view.x0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // Sun glints.
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    for (let i = 0; i < 40; i++) {
      const gx = ((i * 397) % WORLD_W) + Math.sin(t / 1300 + i) * 30 - 200;
      const gy = ((i * 211) % WORLD_H) + Math.cos(t / 1700 + i * 2) * 20 - 100;
      if (islandRadius(gx, gy) < 1.1) continue;
      const a = (Math.sin(t / 400 + i * 1.7) + 1) / 2;
      if (a < 0.6) continue;
      ctx.fillRect(gx, gy, 6 * a, 1.5);
    }

    ctx.drawImage(this.terrain, 0, 0);

    // Surf along the shore.
    for (const [scale, alpha, width] of [
      [1.0 + 0.012 * Math.sin(t / 900), 0.55, 3],
      [1.03 + 0.015 * Math.sin(t / 900 + 1.5), 0.25, 2],
    ] as const) {
      ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i <= 160; i++) {
        const theta = (i / 160) * Math.PI * 2;
        const [x, y] = shorePoint(theta, scale + 0.004 * Math.sin(theta * 13 + t / 500));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Ground-level things: dig spots and fishing rocks.
    for (const l of this.landmarks) if (l.kind === "dig") this.drawDig(l, t);
    for (const r of this.resources) if (r.kind === "fish") this.drawFishingRocks(r, t);

    // Everything with height, sorted so things further down the screen draw in front.
    const drawables: { y: number; draw: () => void }[] = [];
    for (const r of this.resources) {
      if (r.kind === "fish" || r.x < view.x0 || r.x > view.x1 || r.y < view.y0 || r.y > view.y1) continue;
      drawables.push({ y: r.y, draw: () => (r.kind === "palm" ? this.drawPalm(r, t) : this.drawFruitTree(r, t)) });
    }
    for (const l of this.landmarks) {
      if (l.kind === "bonfire") this.campDrawables(l, t, drawables);
      if (l.kind === "hut") drawables.push({ y: l.y, draw: () => this.drawHut(l, t) });
      if (l.kind === "arena") drawables.push({ y: l.y, draw: () => this.drawArena(l, t) });
    }
    const seen = [...this.walkers.values()].filter((wk) => wk.isYou || this.canSee(wk));
    for (const wk of seen) drawables.push({ y: wk.y, draw: () => this.drawWalker(wk, t) });
    drawables.sort((a, b) => a.y - b.y);
    for (const d of drawables) d.draw();

    for (const p of this.particles) {
      ctx.globalAlpha = 1 - p.life / p.max;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // Light: the afternoon turns golden, then dusk, as your energy for the day runs out.
    const day = Math.min(1, Math.max(0, this.opts.dayProgress()));
    if (day > 0.35) {
      const k = (day - 0.35) / 0.65;
      ctx.fillStyle = `rgba(255,150,60,${0.1 * Math.min(1, k * 1.6)})`;
      ctx.fillRect(0, 0, w, h);
      if (k > 0.6) {
        ctx.fillStyle = `rgba(40,30,100,${0.28 * (k - 0.6) / 0.4})`;
        ctx.fillRect(0, 0, w, h);
      }
    }
    // Firelight glows through the dusk.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const l of this.landmarks.filter((x) => x.kind === "bonfire")) {
      const fx = l.x + ox;
      const fy = l.y + oy;
      const glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, 110 + Math.sin(t / 120) * 6);
      glow.addColorStop(0, `rgba(255,150,60,${0.18 + day * 0.2})`);
      glow.addColorStop(1, "rgba(255,150,60,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(fx - 130, fy - 130, 260, 260);
    }
    ctx.restore();

    // Line of sight: everything beyond your vision fades into shadow.
    const me = this.you();
    const sx = me.x + ox;
    const sy = me.y + oy;
    const fog = ctx.createRadialGradient(sx, sy, VISION * 0.72, sx, sy, VISION);
    fog.addColorStop(0, "rgba(6,16,26,0)");
    fog.addColorStop(1, "rgba(6,16,26,0.55)");
    ctx.fillStyle = fog;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(ox, oy);
    for (const wk of seen) if (wk.bubble) this.drawBubble(wk.x, wk.y - 58, wk.bubble.text);
    for (const f of this.floaters) {
      const k = (t - f.start) / 1400;
      ctx.globalAlpha = 1 - k;
      ctx.font = "700 14px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillText(f.text, f.x + 1, f.y - k * 30 + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - k * 30);
    }
    ctx.globalAlpha = 1;
    if (me.work) this.drawProgress(me.x, me.y - 62, (t - me.work.start) / (me.work.end - me.work.start));
    ctx.restore();

    // HUD: prompt and toast.
    const prompt = this.prompt;
    if (prompt) this.drawPill(w / 2, h - 28, `E / tap: ${prompt}`, "#f2a541", "#1a1206");
    if (this.toast && this.toast.until > t) this.drawPill(w / 2, 28, this.toast.text, "rgba(13,23,32,0.9)", "#eef3f6");
  }

  // ---------- trees and spots ----------

  private drawPalm(r: Resource, t: number): void {
    const ctx = this.ctx;
    const s = r.size;
    const height = 54 * s;
    const sway = Math.sin(t / 1400 + r.phase) * 2.5;
    const topX = r.x + r.lean * 26 * s + sway;
    const topY = r.y - height;
    // Shadow.
    ctx.fillStyle = "rgba(10,40,10,0.22)";
    ctx.beginPath();
    ctx.ellipse(r.x + 16 * s, r.y + 4, 30 * s, 11 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    // Trunk: curved, tapered, ringed.
    const midX = r.x + r.lean * 6 * s;
    const midY = r.y - height * 0.55;
    ctx.strokeStyle = "#7b5a35";
    ctx.lineCap = "round";
    ctx.lineWidth = 7 * s;
    ctx.beginPath();
    ctx.moveTo(r.x, r.y);
    ctx.quadraticCurveTo(midX, midY, topX, topY);
    ctx.stroke();
    ctx.strokeStyle = "#9c7748";
    ctx.lineWidth = 3 * s;
    ctx.beginPath();
    ctx.moveTo(r.x - 1, r.y - 2);
    ctx.quadraticCurveTo(midX - 1, midY, topX - 1, topY);
    ctx.stroke();
    ctx.strokeStyle = "rgba(60,40,20,0.5)";
    ctx.lineWidth = 1.2;
    for (let i = 1; i < 6; i++) {
      const k = i / 6;
      const x = (1 - k) * (1 - k) * r.x + 2 * (1 - k) * k * midX + k * k * topX;
      const y = (1 - k) * (1 - k) * r.y + 2 * (1 - k) * k * midY + k * k * topY;
      ctx.beginPath();
      ctx.moveTo(x - 3.5 * s, y);
      ctx.lineTo(x + 3.5 * s, y + 1);
      ctx.stroke();
    }
    // Crown: fewer fronds as the palm gets stripped.
    const fronds = r.left <= 0 ? 3 : 4 + Math.round((r.left / r.max) * 4);
    const dark = r.left <= 0 ? "#6f7d3a" : r.hue > 0.5 ? "#2e7a3a" : "#357f33";
    const light = r.left <= 0 ? "#8e9a4c" : "#58a845";
    for (let i = 0; i < fronds; i++) {
      const a = (i / fronds) * Math.PI * 2 + r.phase + Math.sin(t / 1200 + i) * 0.04;
      const len = (38 + (i % 2) * 8) * s;
      const ex = topX + Math.cos(a) * len;
      const ey = topY + Math.sin(a) * len * 0.55 + 8 * s;
      const nx = -Math.sin(a) * 9 * s;
      const ny = Math.cos(a) * 5 * s;
      ctx.fillStyle = i % 2 ? dark : light;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo((topX + ex) / 2 + nx, (topY + ey) / 2 + ny - 6 * s, ex, ey);
      ctx.quadraticCurveTo((topX + ex) / 2 - nx, (topY + ey) / 2 - ny - 2 * s, topX, topY);
      ctx.fill();
      ctx.strokeStyle = "rgba(20,60,20,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(topX, topY);
      ctx.quadraticCurveTo((topX + ex) / 2, (topY + ey) / 2 - 4 * s, ex, ey);
      ctx.stroke();
    }
    if (r.left > 0) {
      ctx.fillStyle = "#6b4a24";
      for (const [cx, cy] of [
        [-3, 3],
        [3, 4],
        [0, 6],
      ] as const) {
        ctx.beginPath();
        ctx.arc(topX + cx * s, topY + cy * s, 3 * s, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  private drawFruitTree(r: Resource, t: number): void {
    const ctx = this.ctx;
    const s = r.size;
    const sway = Math.sin(t / 1600 + r.phase) * 1.2;
    ctx.fillStyle = "rgba(10,40,10,0.25)";
    ctx.beginPath();
    ctx.ellipse(r.x + 10 * s, r.y + 3, 30 * s, 12 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#6a4a2a";
    ctx.fillRect(r.x - 4 * s, r.y - 22 * s, 8 * s, 22 * s);
    const cy = r.y - 38 * s;
    const blobs: [number, number, number, string][] = [
      [-14, 4, 17, "#2f6b2c"],
      [14, 4, 17, "#2f6b2c"],
      [0, -8, 20, "#3b7e35"],
      [-7, 2, 16, "#46913d"],
      [8, -2, 15, "#4f9b42"],
    ];
    for (const [bx, by, br, col] of blobs) {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(r.x + bx * s + sway, cy + by * s, br * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    ctx.arc(r.x - 6 * s + sway, cy - 12 * s, 9 * s, 0, Math.PI * 2);
    ctx.fill();
    const fruitColor = r.hue < 0.33 ? "#ff8c1a" : r.hue < 0.66 ? "#ffd23f" : "#e8434f";
    const spots: [number, number][] = [
      [-12, 2],
      [10, 6],
      [2, -14],
      [-4, 10],
      [14, -6],
      [-16, -8],
    ];
    const count = Math.round((r.left / r.max) * spots.length);
    for (let i = 0; i < count; i++) {
      const [fx, fy] = spots[i]!;
      ctx.fillStyle = fruitColor;
      ctx.beginPath();
      ctx.arc(r.x + fx * s + sway, cy + fy * s, 3.6 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(r.x + fx * s + sway - 1.5, cy + fy * s - 2, 1.5, 1.5);
    }
  }

  private drawFishingRocks(r: Resource, t: number): void {
    const ctx = this.ctx;
    for (let i = 0; i < 3; i++) {
      const k = ((t / 2200 + i / 3 + r.phase) % 1 + 1) % 1;
      ctx.strokeStyle = `rgba(255,255,255,${0.45 * (1 - k)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(r.x + 18, r.y + 14, 8 + k * 26, (8 + k * 26) * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const [dx, dy, rr, col] of [
      [-10, 2, 14, "#6f6a63"],
      [8, -4, 11, "#86817a"],
      [0, 8, 9, "#5f5a54"],
    ] as const) {
      ctx.fillStyle = "rgba(0,0,0,0.2)";
      ctx.beginPath();
      ctx.ellipse(r.x + dx + 2, r.y + dy + 4, rr, rr * 0.55, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.ellipse(r.x + dx, r.y + dy, rr, rr * 0.65, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Now and then a fish jumps.
    const jump = ((t / 3000 + r.phase) % 1 + 1) % 1;
    if (jump < 0.12) {
      const k = jump / 0.12;
      ctx.fillStyle = "#cfe8ef";
      ctx.beginPath();
      ctx.ellipse(r.x + 28 + k * 14, r.y + 18 - Math.sin(k * Math.PI) * 14, 5, 2.2, -0.6 + k * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawDig(l: Landmark, t: number): void {
    const ctx = this.ctx;
    const glint = (Math.sin(t / 300 + l.x) + 1) / 2;
    ctx.fillStyle = "#c9ac6b";
    ctx.beginPath();
    ctx.ellipse(l.x, l.y, 18, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(120,60,30,${0.5 + glint * 0.4})`;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(l.x - 6, l.y - 5);
    ctx.lineTo(l.x + 6, l.y + 5);
    ctx.moveTo(l.x + 6, l.y - 5);
    ctx.lineTo(l.x - 6, l.y + 5);
    ctx.stroke();
  }

  // ---------- camp ----------

  private campDrawables(l: Landmark, t: number, out: { y: number; draw: () => void }[]): void {
    const camp = this.opts.camp(l.crew ?? "merged");
    const sx = l.x - 10;
    const sy = l.y - 70;
    out.push({ y: sy + 30, draw: () => this.drawShelter(sx, sy, camp) });
    out.push({ y: l.y + 2, draw: () => this.drawFire(l, camp, t) });
    out.push({ y: l.y - 18, draw: () => this.drawFoodStore(l.x + 92, l.y - 22, camp.food) });
    // Seats around the fire.
    out.push({
      y: l.y + 30,
      draw: () => {
        const ctx = this.ctx;
        for (const [dx, dy, rot] of [
          [-48, 18, 0.3],
          [48, 18, -0.3],
          [0, 40, 0],
        ] as const) {
          ctx.save();
          ctx.translate(l.x + dx, l.y + dy);
          ctx.rotate(rot);
          ctx.fillStyle = "#6e4b2a";
          ctx.fillRect(-20, -5, 40, 10);
          ctx.fillStyle = "#c8a070";
          ctx.beginPath();
          ctx.ellipse(20, 0, 3, 5, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
        if (camp.items.includes("fishingRod")) {
          ctx.strokeStyle = "#5a3d22";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(l.x + 70, l.y + 20);
          ctx.lineTo(l.x + 110, l.y - 30);
          ctx.stroke();
          ctx.strokeStyle = "rgba(255,255,255,0.6)";
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(l.x + 110, l.y - 30);
          ctx.lineTo(l.x + 116, l.y + 4);
          ctx.stroke();
        }
        if (camp.items.includes("machete")) {
          ctx.fillStyle = "#6e4b2a";
          ctx.fillRect(l.x - 112, l.y + 12, 26, 12);
          ctx.fillStyle = "#cfd6dc";
          ctx.beginPath();
          ctx.moveTo(l.x - 100, l.y + 13);
          ctx.lineTo(l.x - 96, l.y - 14);
          ctx.lineTo(l.x - 92, l.y + 13);
          ctx.fill();
          ctx.fillStyle = "#2b1d12";
          ctx.fillRect(l.x - 98, l.y - 20, 4, 7);
        }
        this.drawCampLabel(l, camp);
      },
    });
  }

  private drawCampLabel(l: Landmark, camp: IslandCamp): void {
    const tier = shelterTier(camp.materials);
    const crew = l.crew ?? "merged";
    this.drawLabel(l.x, l.y + 78, l.label, CREW_COLORS[crew] ?? "#fff", 13);
    const progress = tier.next ? `${tier.name} · ${camp.materials}/${tier.next} materials` : `${tier.name} · ${camp.materials} materials`;
    this.drawLabel(l.x, l.y + 94, `${progress} · ${camp.food} food`, "#eef3f6", 11);
  }

  private drawShelter(x: number, y: number, camp: IslandCamp): void {
    const ctx = this.ctx;
    const tier = shelterTier(camp.materials);
    const tarp = camp.items.includes("tarp");
    const blankets = camp.items.includes("blankets");
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.beginPath();
    ctx.ellipse(x + 10, y + 34, 78, 18, 0, 0, Math.PI * 2);
    ctx.fill();

    if (tier.index === 0) {
      // A pile of branches waiting to become something.
      const sticks = Math.min(14, camp.materials);
      for (let i = 0; i < sticks; i++) {
        ctx.strokeStyle = i % 2 ? "#7a5634" : "#93693f";
        ctx.lineWidth = 4;
        ctx.beginPath();
        const yy = y + 26 - (i % 4) * 4;
        ctx.moveTo(x - 40 + ((i * 13) % 30), yy);
        ctx.lineTo(x + 10 + ((i * 17) % 30), yy - 6 + (i % 3) * 4);
        ctx.stroke();
      }
      // Corner posts stuck in the sand, so you can see where it will go.
      ctx.strokeStyle = "#6a4a2a";
      ctx.lineWidth = 4;
      for (const px of [-55, 55]) {
        ctx.beginPath();
        ctx.moveTo(x + px, y + 30);
        ctx.lineTo(x + px, y + 12);
        ctx.stroke();
      }
      return;
    }

    const w = tier.index === 1 ? 110 : tier.index === 2 ? 130 : 150;
    const h = tier.index === 1 ? 42 : tier.index === 2 ? 58 : 66;
    // Raised floor for the real shelters.
    if (tier.index >= 2) {
      ctx.fillStyle = "#7a5634";
      ctx.fillRect(x - w / 2, y + 18, w, 12);
      ctx.fillStyle = "#5c3f24";
      for (let px = -w / 2 + 6; px < w / 2; px += 24) ctx.fillRect(x + px, y + 30, 5, 8);
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.lineWidth = 1;
      for (let px = -w / 2; px < w / 2; px += 10) {
        ctx.beginPath();
        ctx.moveTo(x + px, y + 18);
        ctx.lineTo(x + px, y + 30);
        ctx.stroke();
      }
    }
    // Back wall / interior shade.
    ctx.fillStyle = "#3b2a1a";
    ctx.fillRect(x - w / 2 + 10, y + 18 - h + 14, w - 20, h - 14);
    if (blankets) {
      ctx.fillStyle = "#c0392b";
      ctx.fillRect(x - w / 2 + 16, y + 8, 30, 10);
      ctx.fillStyle = "#2e86de";
      ctx.fillRect(x - 6, y + 9, 28, 9);
      ctx.fillStyle = "#f6b93b";
      ctx.fillRect(x + 26, y + 8, 24, 10);
    }
    // Posts.
    ctx.fillStyle = "#5c3f24";
    ctx.fillRect(x - w / 2, y + 18 - h, 6, h);
    ctx.fillRect(x + w / 2 - 6, y + 18 - h, 6, h);
    // Roof: thatch, or a lean-to slope for the first stage.
    const roofTop = y + 18 - h - (tier.index === 1 ? 6 : 26);
    ctx.fillStyle = tarp ? "#2f7fd1" : "#b8954f";
    ctx.beginPath();
    if (tier.index === 1) {
      ctx.moveTo(x - w / 2 - 10, y + 22);
      ctx.lineTo(x - w / 2 + 10, roofTop);
      ctx.lineTo(x + w / 2 + 10, roofTop);
      ctx.lineTo(x + w / 2 - 10, y + 22 - h * 0.15);
    } else {
      ctx.moveTo(x - w / 2 - 14, y + 18 - h + 10);
      ctx.lineTo(x, roofTop);
      ctx.lineTo(x + w / 2 + 14, y + 18 - h + 10);
    }
    ctx.closePath();
    ctx.fill();
    // Thatch lines.
    ctx.strokeStyle = tarp ? "rgba(255,255,255,0.25)" : "rgba(90,60,20,0.45)";
    ctx.lineWidth = 1.5;
    for (let i = 1; i < 9; i++) {
      const k = i / 9;
      ctx.beginPath();
      if (tier.index === 1) {
        const xx = x - w / 2 + k * w;
        ctx.moveTo(xx - 10, y + 22 - h * 0.15 * k);
        ctx.lineTo(xx + 10, roofTop);
      } else {
        ctx.moveTo(x, roofTop);
        ctx.lineTo(x - w / 2 - 14 + k * (w + 28), y + 18 - h + 10);
      }
      ctx.stroke();
    }
    if (tarp) {
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.moveTo(x, roofTop);
      ctx.lineTo(x - w / 2 - 14, y + 18 - h + 10);
      ctx.lineTo(x - w / 2, y + 18 - h + 10);
      ctx.closePath();
      ctx.fill();
    }
    if (tier.index === 3) {
      // Side walls woven from fronds.
      ctx.fillStyle = "rgba(150,110,55,0.9)";
      ctx.fillRect(x - w / 2, y - h + 34, 14, h - 16);
      ctx.fillRect(x + w / 2 - 14, y - h + 34, 14, h - 16);
    }
  }

  private drawFire(l: Landmark, camp: IslandCamp, t: number): void {
    const ctx = this.ctx;
    const flint = camp.items.includes("flint");
    // Stone ring.
    ctx.fillStyle = "#4a3726";
    ctx.beginPath();
    ctx.ellipse(l.x, l.y, 22, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      ctx.fillStyle = i % 2 ? "#8a857d" : "#6f6a63";
      ctx.beginPath();
      ctx.ellipse(l.x + Math.cos(a) * 22, l.y + Math.sin(a) * 12, 6, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "#5c3f24";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(l.x - 12, l.y + 4);
    ctx.lineTo(l.x + 12, l.y - 4);
    ctx.moveTo(l.x - 12, l.y - 4);
    ctx.lineTo(l.x + 12, l.y + 4);
    ctx.stroke();
    // Flames.
    const size = flint ? 1.3 : 1;
    for (let i = 0; i < 3; i++) {
      const f = 1 + Math.sin(t / (70 + i * 23) + i) * 0.15;
      const hh = (22 - i * 6) * size * f;
      ctx.fillStyle = ["#ff6b1a", "#ffa62b", "#ffe08a"][i]!;
      ctx.beginPath();
      ctx.moveTo(l.x - (10 - i * 3) * size, l.y);
      ctx.quadraticCurveTo(l.x - 6 * size, l.y - hh * 0.6, l.x + Math.sin(t / 150 + i) * 3, l.y - hh);
      ctx.quadraticCurveTo(l.x + 6 * size, l.y - hh * 0.6, l.x + (10 - i * 3) * size, l.y);
      ctx.closePath();
      ctx.fill();
    }
    // Smoke.
    for (let i = 0; i < 4; i++) {
      const k = ((t / 2400 + i / 4) % 1 + 1) % 1;
      ctx.fillStyle = `rgba(220,220,220,${0.22 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(l.x + Math.sin(k * 5 + i) * 8 + k * 14, l.y - 30 - k * 70, 5 + k * 10, 0, Math.PI * 2);
      ctx.fill();
    }
    if (camp.items.includes("pot")) {
      ctx.strokeStyle = "#3a2a1a";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(l.x - 20, l.y + 6);
      ctx.lineTo(l.x, l.y - 36);
      ctx.lineTo(l.x + 20, l.y + 6);
      ctx.stroke();
      ctx.fillStyle = "#2d2d2d";
      ctx.beginPath();
      ctx.ellipse(l.x, l.y - 20, 12, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#555";
      ctx.fillRect(l.x - 12, l.y - 27, 24, 4);
    }
  }

  private drawFoodStore(x: number, y: number, food: number): void {
    const ctx = this.ctx;
    // A drying rack, with fish and fruit piled up to match the food store.
    ctx.strokeStyle = "#5c3f24";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - 26, y + 20);
    ctx.lineTo(x - 22, y - 22);
    ctx.moveTo(x + 26, y + 20);
    ctx.lineTo(x + 22, y - 22);
    ctx.moveTo(x - 26, y - 18);
    ctx.lineTo(x + 26, y - 18);
    ctx.stroke();
    const fish = Math.min(5, Math.floor(food / 3));
    for (let i = 0; i < fish; i++) {
      const fx = x - 18 + i * 9;
      ctx.fillStyle = "#b9c9cf";
      ctx.beginPath();
      ctx.ellipse(fx, y - 8, 3, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(fx, y);
      ctx.lineTo(fx - 3, y + 5);
      ctx.lineTo(fx + 3, y + 5);
      ctx.fill();
    }
    const fruit = Math.min(12, food);
    const colors = ["#ff8c1a", "#ffd23f", "#e8434f", "#7bc043"];
    for (let i = 0; i < fruit; i++) {
      const row = Math.floor(i / 5);
      const col = i % 5;
      ctx.fillStyle = colors[i % colors.length]!;
      ctx.beginPath();
      ctx.arc(x - 16 + col * 8 + row * 4, y + 18 - row * 6, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    if (food === 0) this.drawLabel(x, y + 34, "empty", "#ffb3a7", 10);
  }

  private drawHut(l: Landmark, t: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(0,0,0,0.2)";
    ctx.beginPath();
    ctx.ellipse(l.x + 8, l.y + 20, 46, 12, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#7a5634";
    ctx.fillRect(l.x - 30, l.y - 20, 60, 40);
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 1;
    for (let x = -30; x < 30; x += 8) {
      ctx.beginPath();
      ctx.moveTo(l.x + x, l.y - 20);
      ctx.lineTo(l.x + x, l.y + 20);
      ctx.stroke();
    }
    ctx.fillStyle = "#c9a25e";
    ctx.beginPath();
    ctx.moveTo(l.x - 42, l.y - 16);
    ctx.lineTo(l.x, l.y - 56);
    ctx.lineTo(l.x + 42, l.y - 16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2b1d12";
    ctx.fillRect(l.x - 9, l.y - 2, 18, 22);
    // A lantern by the door.
    const glow = 0.6 + Math.sin(t / 300) * 0.15;
    ctx.fillStyle = `rgba(255,200,90,${glow})`;
    ctx.beginPath();
    ctx.arc(l.x + 22, l.y - 4, 5, 0, Math.PI * 2);
    ctx.fill();
    this.drawLabel(l.x, l.y + 38, l.label);
  }

  private drawArena(l: Landmark, t: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "#8a6239";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(l.x - 70, l.y + 12);
    ctx.lineTo(l.x - 70, l.y - 40);
    ctx.lineTo(l.x + 70, l.y - 40);
    ctx.lineTo(l.x + 70, l.y + 12);
    ctx.stroke();
    const flags = ["#ff7f6b", "#e0b36e", "#5fd3c2"];
    flags.forEach((col, i) => {
      const fx = l.x - 40 + i * 40;
      const wave = Math.sin(t / 250 + i) * 3;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(fx - 8, l.y - 38);
      ctx.lineTo(fx + 8, l.y - 38);
      ctx.lineTo(fx + 8 + wave, l.y - 14);
      ctx.lineTo(fx + wave * 0.5, l.y - 20);
      ctx.lineTo(fx - 8 + wave, l.y - 14);
      ctx.closePath();
      ctx.fill();
    });
    // Torches.
    for (const dx of [-86, 86]) {
      ctx.fillStyle = "#5c3f24";
      ctx.fillRect(l.x + dx - 2, l.y - 30, 4, 40);
      ctx.fillStyle = "#ffa62b";
      ctx.beginPath();
      ctx.arc(l.x + dx, l.y - 34 + Math.sin(t / 90 + dx) * 1.5, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawLabel(l.x, l.y + 32, l.label);
  }

  // ---------- castaways ----------

  private drawWalker(wk: Walker, t: number): void {
    const ctx = this.ctx;
    const color = CREW_COLORS[wk.crew] ?? "#ccc";
    const moving =
      !wk.work && (Math.hypot(wk.tx - wk.x, wk.ty - wk.y) > 3 || (wk.isYou && (this.hasMoveKey() || !!this.moveTarget)));
    const phase = moving ? t / 110 : 0;
    const bob = moving ? Math.abs(Math.sin(phase)) * 2 : 0;
    const x = wk.x;
    const y = wk.y - bob;
    const f = wk.facing;

    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(wk.x, wk.y + 12, 12, 4.5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (wk.isYou) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(wk.x, wk.y + 12, 17, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Legs.
    ctx.strokeStyle = wk.look.skin;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    const swing = moving ? Math.sin(phase) * 5 : 0;
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 2);
    ctx.lineTo(x - 4 + swing, y + 12);
    ctx.moveTo(x + 4, y + 2);
    ctx.lineTo(x + 4 - swing, y + 12);
    ctx.stroke();
    // Shorts.
    ctx.fillStyle = "#3d4f63";
    ctx.fillRect(x - 8, y - 2, 16, 7);
    // Shirt in crew colors.
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - 9, y - 18, 18, 18, 5);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x - 9, y - 18, 18, 4);
    // Arms: swinging while walking, chopping/reaching/casting while working.
    ctx.strokeStyle = wk.look.skin;
    ctx.lineWidth = 3.5;
    if (wk.work) {
      const k = (t - wk.work.start) / (wk.work.end - wk.work.start);
      const kind = wk.work.res.kind;
      const a = kind === "palm" ? -1.9 + Math.abs(Math.sin(k * Math.PI * 3)) * 2.2 : kind === "fruit" ? -1.4 - Math.sin(k * Math.PI * 2) * 0.3 : -0.9;
      const hx = x + f * 6 + Math.cos(a) * 11 * f;
      const hy = y - 14 + Math.sin(a) * 11;
      ctx.beginPath();
      ctx.moveTo(x + f * 6, y - 14);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      if (kind === "palm") {
        ctx.strokeStyle = "#cfd6dc";
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx + Math.cos(a) * 9 * f, hy + Math.sin(a) * 9);
        ctx.stroke();
      } else if (kind === "fish") {
        ctx.strokeStyle = "#5a3d22";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx + f * 26, hy - 18);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(hx + f * 26, hy - 18);
        ctx.lineTo(hx + f * 32, hy + 14 + Math.sin(t / 300) * 2);
        ctx.stroke();
      }
      ctx.strokeStyle = wk.look.skin;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(x - f * 7, y - 14);
      ctx.lineTo(x - f * 9, y - 4);
      ctx.stroke();
    } else {
      const arm = moving ? Math.sin(phase) * 4 : 0;
      ctx.beginPath();
      ctx.moveTo(x - 8, y - 14);
      ctx.lineTo(x - 10 - arm, y - 3);
      ctx.moveTo(x + 8, y - 14);
      ctx.lineTo(x + 10 + arm, y - 3);
      ctx.stroke();
    }
    // Head and hair.
    ctx.fillStyle = wk.look.skin;
    ctx.beginPath();
    ctx.arc(x, y - 25, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = wk.look.hair;
    ctx.beginPath();
    if (wk.look.hairStyle === 0) {
      ctx.arc(x, y - 27, 8.3, Math.PI * 1.05, Math.PI * 1.95);
    } else if (wk.look.hairStyle === 1) {
      ctx.arc(x, y - 27, 8.6, Math.PI * 0.95, Math.PI * 2.05);
      ctx.rect(x - f * 9 - (f < 0 ? 0 : -1), y - 28, 3, 10);
    } else {
      ctx.ellipse(x, y - 31, 7, 4, 0, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(x + f * 3 - 1, y - 26, 2, 2);
    this.drawLabel(wk.x, wk.y + 28, wk.isYou ? `${wk.name} (you)` : wk.name, wk.isYou ? "#fff" : color);
  }

  private hasMoveKey(): boolean {
    for (const k of this.keys) if (k !== "e") return true;
    return false;
  }

  // ---------- HUD pieces ----------

  private drawProgress(x: number, y: number, k: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(13,23,32,0.85)";
    ctx.beginPath();
    ctx.roundRect(x - 26, y - 5, 52, 10, 5);
    ctx.fill();
    ctx.fillStyle = "#f2a541";
    ctx.beginPath();
    ctx.roundRect(x - 24, y - 3, 48 * Math.min(1, Math.max(0, k)), 6, 3);
    ctx.fill();
  }

  private drawLabel(x: number, y: number, text: string, color = "#eef3f6", size = 12): void {
    const ctx = this.ctx;
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(text, x + 1, y + 1);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  private drawBubble(x: number, y: number, text: string): void {
    const ctx = this.ctx;
    ctx.font = "13px system-ui, sans-serif";
    const words = text.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > 170 && line) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    const height = lines.length * 16 + 10;
    const top = y - height;
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.roundRect(x - width / 2, top, width, height, 8);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - 6, y);
    ctx.lineTo(x, y + 7);
    ctx.lineTo(x + 6, y);
    ctx.fill();
    ctx.fillStyle = "#1a2530";
    ctx.textAlign = "center";
    lines.forEach((l, i) => ctx.fillText(l, x, top + 18 + i * 16));
  }

  private drawPill(x: number, y: number, text: string, bg: string, fg: string): void {
    const ctx = this.ctx;
    ctx.font = "600 14px system-ui, sans-serif";
    const width = Math.min(this.canvas.clientWidth - 16, ctx.measureText(text).width + 28);
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - 16, width, 32, 16);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.fillText(text, x, y + 5, width - 20);
  }
}

/** For the camp panel: the gear's name and what it does. */
export function describeItem(item: RewardItem): string {
  return `${REWARDS[item].name}: ${REWARDS[item].effect}`;
}
