import { Rng } from "../engine/rng.js";

/**
 * A walkable top-down island drawn on a canvas, with no image assets.
 * The player walks with WASD / arrow keys or by tapping, and interacts with
 * castaways and landmarks by walking up to them and pressing E (or tapping again).
 */

export type Interaction =
  | { kind: "castaway"; id: string }
  | { kind: "bonfire" }
  | { kind: "dig" }
  | { kind: "hut" }
  | { kind: "arena" };

export interface IslandCastaway {
  id: string;
  name: string;
  crew: string;
  isYou: boolean;
}

export interface IslandOptions {
  castaways: IslandCastaway[];
  merged: boolean;
  yourCrew: string;
  seed: number;
  onInteract: (what: Interaction) => void;
  /** Called with a line like "Ana and Bo slipped off to talk." */
  onRumor: (text: string) => void;
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
  bubble: { text: string; until: number } | null;
  pairedWith: string | null;
}

interface Landmark {
  kind: "bonfire" | "dig" | "hut" | "arena";
  x: number;
  y: number;
  label: string;
  crew?: string;
}

const WORLD_W = 1600;
const WORLD_H = 1100;
const CX = 800;
const CY = 550;
const RX = 680;
const RY = 440;
const SPEED = 190; // world px per second
const REACH = 64;

export const CREW_COLORS: Record<string, string> = {
  Coral: "#ff8a75",
  Driftwood: "#d9b277",
  merged: "#7fd6c9",
};

/** Normalised distance from the island centre: 1 is the waterline. */
function islandRadius(x: number, y: number): number {
  const dx = (x - CX) / RX;
  const dy = (y - CY) / RY;
  const theta = Math.atan2(dy, dx);
  const wobble = 1 + 0.07 * Math.sin(3 * theta) + 0.045 * Math.sin(7 * theta + 1.3);
  return Math.hypot(dx, dy) / wobble;
}

function shorePoint(theta: number, scale: number): [number, number] {
  const wobble = 1 + 0.07 * Math.sin(3 * theta) + 0.045 * Math.sin(7 * theta + 1.3);
  return [CX + Math.cos(theta) * RX * wobble * scale, CY + Math.sin(theta) * RY * wobble * scale];
}

export class Island {
  private ctx: CanvasRenderingContext2D;
  private walkers = new Map<string, Walker>();
  private landmarks: Landmark[] = [];
  private palms: { x: number; y: number; r: number }[] = [];
  private keys = new Set<string>();
  private moveTarget: { x: number; y: number } | null = null;
  private pendingInteract: Interaction | null = null;
  private raf = 0;
  private last = 0;
  private rng: Rng;
  private cam = { x: CX, y: CY };
  private toast: { text: string; until: number } | null = null;
  private nearby: Interaction | null = null;
  private disposed = false;
  private cleanup: (() => void)[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private opts: IslandOptions,
  ) {
    this.ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    this.rng = new Rng(opts.seed);
    this.buildWorld();
    this.bindInput();
    this.resize();
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
    if (this.nearby) this.opts.onInteract(this.nearby);
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
    if (this.opts.merged) return { x: 800, y: 600 };
    return crew === "Coral" ? { x: 450, y: 580 } : { x: 1150, y: 580 };
  }

  private buildWorld(): void {
    const crews = this.opts.merged ? ["merged"] : [...new Set(this.opts.castaways.map((c) => c.crew))];
    for (const crew of crews) {
      const c = this.campFor(crew);
      this.landmarks.push({
        kind: "bonfire",
        x: c.x,
        y: c.y,
        label: this.opts.merged ? "Camp fire" : `${crew} camp`,
        crew,
      });
    }
    this.landmarks.push({ kind: "hut", x: 800, y: 290, label: "Confession hut" });
    this.landmarks.push({ kind: "arena", x: 800, y: 925, label: "Challenge beach" });
    for (const theta of [3.5, 5.6, 0.55, 2.4]) {
      const [x, y] = shorePoint(theta, 0.92);
      this.landmarks.push({ kind: "dig", x, y, label: "Dig spot" });
    }

    for (let i = 0; i < 70; i++) {
      const x = 150 + this.rng.next() * 1300;
      const y = 120 + this.rng.next() * 860;
      const r = islandRadius(x, y);
      if (r > 0.82) continue;
      if (this.landmarks.some((l) => Math.hypot(l.x - x, l.y - y) < 110)) continue;
      this.palms.push({ x, y, r: 16 + this.rng.next() * 10 });
    }

    for (const c of this.opts.castaways) {
      const home = this.campFor(c.crew === "merged" ? "merged" : c.crew);
      const angle = this.rng.next() * Math.PI * 2;
      const x = home.x + Math.cos(angle) * 70;
      const y = home.y + Math.sin(angle) * 50 + 40;
      this.walkers.set(c.id, { ...c, x, y, tx: x, ty: y, wait: this.rng.next() * 2, bubble: null, pairedWith: null });
    }
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
        this.interact();
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    const click = (e: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left + this.cam.x - rect.width / 2;
      const y = e.clientY - rect.top + this.cam.y - rect.height / 2;
      const target = this.thingAt(x, y);
      if (target && this.nearby && JSON.stringify(target) === JSON.stringify(this.nearby)) {
        this.opts.onInteract(target);
        return;
      }
      this.moveTarget = { x, y };
      this.pendingInteract = target;
    };
    const resize = () => this.resize();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("resize", resize);
    this.canvas.addEventListener("pointerdown", click);
    this.cleanup.push(
      () => window.removeEventListener("keydown", down),
      () => window.removeEventListener("keyup", up),
      () => window.removeEventListener("resize", resize),
      () => this.canvas.removeEventListener("pointerdown", click),
    );
  }

  private thingAt(x: number, y: number): Interaction | null {
    for (const w of this.walkers.values()) {
      if (!w.isYou && Math.hypot(w.x - x, w.y - y) < 26) return { kind: "castaway", id: w.id };
    }
    for (const l of this.landmarks) {
      if (Math.hypot(l.x - x, l.y - y) < 40) return { kind: l.kind } as Interaction;
    }
    return null;
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

  private you(): Walker {
    for (const w of this.walkers.values()) if (w.isYou) return w;
    throw new Error("No player walker");
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
          this.opts.onInteract(what);
        }
      } else {
        dx = tx / dist;
        dy = ty / dist;
      }
    }
    if (dx || dy) {
      const len = Math.hypot(dx, dy);
      this.tryMove(me, (dx / len) * SPEED * dt, (dy / len) * SPEED * dt);
    }

    for (const w of this.walkers.values()) {
      if (w.isYou) continue;
      const tx = w.tx - w.x;
      const ty = w.ty - w.y;
      const dist = Math.hypot(tx, ty);
      if (dist > 3) {
        const s = Math.min(dist, SPEED * 0.45 * dt);
        this.tryMove(w, (tx / dist) * s, (ty / dist) * s);
      } else if ((w.wait -= dt) <= 0) {
        this.pickWanderTarget(w);
      }
      if (w.bubble && w.bubble.until < now) w.bubble = null;
    }

    if (this.rng.chance(dt * 0.06)) this.startSideConversation(now);

    this.nearby = this.findNearby(me);
    this.cam.x += (me.x - this.cam.x) * Math.min(1, dt * 6);
    this.cam.y += (me.y - this.cam.y) * Math.min(1, dt * 6);
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

  private pickWanderTarget(w: Walker): void {
    if (w.pairedWith) {
      const other = this.walkers.get(w.pairedWith);
      if (other) other.pairedWith = null;
      w.pairedWith = null;
    }
    const home = this.campFor(this.opts.merged ? "merged" : w.crew);
    for (let i = 0; i < 10; i++) {
      const angle = this.rng.next() * Math.PI * 2;
      const r = 40 + this.rng.next() * 170;
      const x = home.x + Math.cos(angle) * r;
      const y = home.y + Math.sin(angle) * r * 0.8;
      if (islandRadius(x, y) < 0.9) {
        w.tx = x;
        w.ty = y;
        break;
      }
    }
    w.wait = 1.5 + this.rng.next() * 4;
  }

  /** Two castaways from the same camp wander off together. Everyone can see it; nobody hears it. */
  private startSideConversation(now: number): void {
    const free = [...this.walkers.values()].filter((w) => !w.isYou && !w.pairedWith);
    const a = free.length ? this.rng.pick(free) : null;
    if (!a) return;
    const partners = free.filter((w) => w !== a && w.crew === a.crew);
    if (!partners.length) return;
    const b = this.rng.pick(partners);
    const home = this.campFor(this.opts.merged ? "merged" : a.crew);
    const angle = this.rng.next() * Math.PI * 2;
    const x = home.x + Math.cos(angle) * 190;
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
    this.opts.onRumor(`${a.name} and ${b.name} slipped off to talk.`);
  }

  private findNearby(me: Walker): Interaction | null {
    let best: { d: number; what: Interaction } | null = null;
    for (const w of this.walkers.values()) {
      if (w.isYou) continue;
      const d = Math.hypot(w.x - me.x, w.y - me.y);
      if (d < REACH && (!best || d < best.d)) best = { d, what: { kind: "castaway", id: w.id } };
    }
    for (const l of this.landmarks) {
      if (l.kind === "bonfire" && !this.opts.merged && l.crew !== this.opts.yourCrew) continue;
      const d = Math.hypot(l.x - me.x, l.y - me.y);
      if (d < REACH && (!best || d < best.d)) best = { d, what: { kind: l.kind } as Interaction };
    }
    return best?.what ?? null;
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

    // Ocean.
    ctx.fillStyle = "#14506e";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 2;
    for (let y = -200; y < WORLD_H + 200; y += 46) {
      ctx.beginPath();
      for (let x = -300; x <= WORLD_W + 300; x += 20) {
        const yy = y + Math.sin(x / 60 + t / 900 + y) * 5;
        if (x === -300) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }

    // Shallows, sand, grass.
    const blob = (scale: number, fill: string, pulse = 0) => {
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const theta = (i / 120) * Math.PI * 2;
        const [x, y] = shorePoint(theta, scale + pulse * Math.sin(t / 700 + theta * 5));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    };
    blob(1.08, "#2a7d97", 0.006);
    blob(1.01, "#e9d39a", 0.004);
    blob(0.86, "#5f9e4a");
    blob(0.7, "#548f41");

    // Paths from camps to landmarks.
    ctx.strokeStyle = "rgba(233,211,154,0.55)";
    ctx.lineWidth = 14;
    ctx.lineCap = "round";
    const hut = this.landmarks.find((l) => l.kind === "hut")!;
    const arena = this.landmarks.find((l) => l.kind === "arena")!;
    for (const l of this.landmarks.filter((x) => x.kind === "bonfire")) {
      for (const to of [hut, arena]) {
        ctx.beginPath();
        ctx.moveTo(l.x, l.y);
        ctx.quadraticCurveTo((l.x + to.x) / 2, (l.y + to.y) / 2 + 40, to.x, to.y);
        ctx.stroke();
      }
    }

    for (const l of this.landmarks) this.drawLandmark(l, t);
    for (const p of this.palms) this.drawPalm(p.x, p.y, p.r);

    const sorted = [...this.walkers.values()].sort((a, b) => a.y - b.y);
    for (const wk of sorted) this.drawWalker(wk, t);
    for (const wk of sorted) if (wk.bubble) this.drawBubble(wk.x, wk.y - 44, wk.bubble.text);
    ctx.restore();

    // HUD: prompt and toast.
    const prompt = this.prompt;
    if (prompt) this.drawPill(w / 2, h - 28, `E / tap: ${prompt}`, "#f2a541", "#1a1206");
    if (this.toast && this.toast.until > t) this.drawPill(w / 2, 28, this.toast.text, "rgba(13,23,32,0.9)", "#eef3f6");
  }

  private drawLandmark(l: Landmark, t: number): void {
    const ctx = this.ctx;
    switch (l.kind) {
      case "bonfire": {
        ctx.fillStyle = "#6b4a2b";
        for (const [dx, dy] of [
          [-80, -40],
          [70, -46],
          [-60, 52],
        ] as const) {
          ctx.beginPath();
          ctx.moveTo(l.x + dx - 28, l.y + dy + 16);
          ctx.lineTo(l.x + dx, l.y + dy - 20);
          ctx.lineTo(l.x + dx + 28, l.y + dy + 16);
          ctx.closePath();
          ctx.fill();
        }
        ctx.fillStyle = "#4a3726";
        ctx.beginPath();
        ctx.arc(l.x, l.y, 16, 0, Math.PI * 2);
        ctx.fill();
        const flicker = 1 + Math.sin(t / 90) * 0.12;
        ctx.fillStyle = "#ff9b3d";
        ctx.beginPath();
        ctx.arc(l.x, l.y - 2, 10 * flicker, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffe08a";
        ctx.beginPath();
        ctx.arc(l.x, l.y - 3, 5 * flicker, 0, Math.PI * 2);
        ctx.fill();
        const crew = l.crew ?? "merged";
        this.drawLabel(l.x, l.y + 78, l.label, CREW_COLORS[crew] ?? "#fff");
        break;
      }
      case "hut":
        ctx.fillStyle = "#7a5634";
        ctx.fillRect(l.x - 26, l.y - 16, 52, 34);
        ctx.fillStyle = "#c9a25e";
        ctx.beginPath();
        ctx.moveTo(l.x - 36, l.y - 14);
        ctx.lineTo(l.x, l.y - 46);
        ctx.lineTo(l.x + 36, l.y - 14);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#2b1d12";
        ctx.fillRect(l.x - 8, l.y, 16, 18);
        this.drawLabel(l.x, l.y + 34, l.label);
        break;
      case "arena":
        ctx.strokeStyle = "#8a6239";
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(l.x - 60, l.y + 10);
        ctx.lineTo(l.x - 60, l.y - 30);
        ctx.lineTo(l.x + 60, l.y - 30);
        ctx.lineTo(l.x + 60, l.y + 10);
        ctx.stroke();
        for (const dx of [-36, 0, 36]) {
          ctx.fillStyle = ["#ff8a75", "#d9b277", "#7fd6c9"][(dx / 36 + 1) as 0 | 1 | 2] as string;
          ctx.fillRect(l.x + dx - 6, l.y - 28, 12, 18);
        }
        this.drawLabel(l.x, l.y + 30, l.label);
        break;
      case "dig": {
        const glint = (Math.sin(t / 300 + l.x) + 1) / 2;
        ctx.fillStyle = "#c9ac6b";
        ctx.beginPath();
        ctx.ellipse(l.x, l.y, 18, 10, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,255,220,${0.3 + glint * 0.6})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(l.x - 6, l.y - 6);
        ctx.lineTo(l.x + 6, l.y + 6);
        ctx.moveTo(l.x + 6, l.y - 6);
        ctx.lineTo(l.x - 6, l.y + 6);
        ctx.stroke();
        break;
      }
    }
  }

  private drawPalm(x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(0,0,0,0.15)";
    ctx.beginPath();
    ctx.ellipse(x + 6, y + 8, r, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#2f6e35";
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.ellipse(x + Math.cos(a) * r * 0.55, y + Math.sin(a) * r * 0.55, r * 0.62, r * 0.28, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = "#3f8a43";
    ctx.beginPath();
    ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawWalker(wk: Walker, t: number): void {
    const ctx = this.ctx;
    const color = CREW_COLORS[wk.crew] ?? "#ccc";
    const moving = Math.hypot(wk.tx - wk.x, wk.ty - wk.y) > 3 || (wk.isYou && (this.keys.size > 0 || this.moveTarget));
    const bob = moving ? Math.sin(t / 90) * 2 : 0;
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.ellipse(wk.x, wk.y + 12, 12, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(wk.x, wk.y + bob, 11, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#f1c9a0";
    ctx.beginPath();
    ctx.arc(wk.x, wk.y - 16 + bob, 8, 0, Math.PI * 2);
    ctx.fill();
    if (wk.isYou) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(wk.x, wk.y + 12, 16, 7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    this.drawLabel(wk.x, wk.y + 30, wk.isYou ? `${wk.name} (you)` : wk.name, wk.isYou ? "#fff" : color);
  }

  private drawLabel(x: number, y: number, text: string, color = "#eef3f6"): void {
    const ctx = this.ctx;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(0,0,0,0.55)";
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
    ctx.fillStyle = "rgba(255,255,255,0.94)";
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
    const width = ctx.measureText(text).width + 28;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(x - width / 2, y - 16, width, 32, 16);
    ctx.fill();
    ctx.fillStyle = fg;
    ctx.textAlign = "center";
    ctx.fillText(text, x, y + 5);
  }
}
