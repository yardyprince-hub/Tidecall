import { Rng } from "../engine/rng.js";

export type ChallengeKind = "memory" | "sequence" | "timing";

export const CHALLENGES: Record<ChallengeKind, { title: string; howTo: string }> = {
  memory: {
    title: "Tide Pools",
    howTo: "Some pools will glow for a moment. Tap the same pools from memory. Three rounds, each harder.",
  },
  sequence: {
    title: "Signal Fires",
    howTo: "Watch the fires light up in order, then repeat the order. The signal gets longer each time.",
  },
  timing: {
    title: "Rope Bridge",
    howTo: "Press Stop when the marker is inside the green zone. Five tries.",
  },
};

/**
 * Every challenge scores 0..1000 so they compare with each other and with bot scores.
 * `ease` is the castaway's condition from camp (about 0.6 to 1.3): rested and fed makes the
 * challenge easier (longer glows, slower signals, a wider and slower bridge), tired and hungry harder.
 */
export function runChallenge(kind: ChallengeKind, root: HTMLElement, rng: Rng, ease = 1): Promise<number> {
  const e = Math.min(1.3, Math.max(0.6, ease));
  switch (kind) {
    case "memory":
      return memory(root, rng, e);
    case "sequence":
      return sequence(root, rng, e);
    case "timing":
      return timing(root, rng, e);
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function memory(root: HTMLElement, rng: Rng, ease: number): Promise<number> {
  root.innerHTML = "";
  const status = el("p", "challenge-status", "Watch closely...");
  const grid = el("div", "pool-grid");
  const cells = Array.from({ length: 16 }, (_, i) => {
    const b = el("button", "pool");
    b.dataset.i = String(i);
    b.setAttribute("aria-label", `Pool ${i + 1}`);
    grid.append(b);
    return b;
  });
  root.append(status, grid);
  let total = 0;

  for (const [round, count] of [4, 5, 6].entries()) {
    status.textContent = `Round ${round + 1} of 3: watch ${count} pools glow...`;
    cells.forEach((c) => (c.disabled = true));
    const lit = new Set(rng.shuffle([...Array(16).keys()]).slice(0, count));
    await wait(500);
    lit.forEach((i) => cells[i]!.classList.add("lit"));
    await wait(1400 * ease);
    lit.forEach((i) => cells[i]!.classList.remove("lit"));
    status.textContent = `Tap the ${count} pools that glowed.`;
    cells.forEach((c) => (c.disabled = false));

    const picked = await new Promise<Set<number>>((resolve) => {
      const chosen = new Set<number>();
      const onClick = (e: Event) => {
        const b = (e.target as HTMLElement).closest("button.pool") as HTMLButtonElement | null;
        if (!b || b.disabled) return;
        const i = Number(b.dataset.i);
        chosen.add(i);
        b.disabled = true;
        b.classList.add(lit.has(i) ? "hit" : "miss");
        if (chosen.size >= count) {
          grid.removeEventListener("click", onClick);
          resolve(chosen);
        }
      };
      grid.addEventListener("click", onClick);
    });
    const hits = [...picked].filter((i) => lit.has(i)).length;
    total += Math.round((hits / count) * 333);
    await wait(700);
    cells.forEach((c) => c.classList.remove("hit", "miss"));
  }
  return Math.min(1000, total + 1);
}

async function sequence(root: HTMLElement, rng: Rng, ease: number): Promise<number> {
  root.innerHTML = "";
  const status = el("p", "challenge-status", "Watch the fires...");
  const row = el("div", "fire-row");
  const fires = ["north", "east", "south", "west"].map((name, i) => {
    const b = el("button", `fire fire-${i}`, name);
    b.dataset.i = String(i);
    row.append(b);
    return b;
  });
  root.append(status, row);
  const seq: number[] = [rng.int(4), rng.int(4)];
  let best = 0;

  for (let length = 3; length <= 9; length++) {
    seq.push(rng.int(4));
    status.textContent = `Signal of ${length}: watch...`;
    fires.forEach((f) => (f.disabled = true));
    await wait(600);
    for (const i of seq) {
      fires[i]!.classList.add("lit");
      await wait(450 * ease);
      fires[i]!.classList.remove("lit");
      await wait(150 * ease);
    }
    status.textContent = `Repeat the signal of ${length}.`;
    fires.forEach((f) => (f.disabled = false));
    const ok = await new Promise<boolean>((resolve) => {
      let pos = 0;
      const onClick = (e: Event) => {
        const b = (e.target as HTMLElement).closest("button.fire") as HTMLButtonElement | null;
        if (!b) return;
        const i = Number(b.dataset.i);
        if (i !== seq[pos]) {
          row.removeEventListener("click", onClick);
          resolve(false);
          return;
        }
        pos += 1;
        if (pos === seq.length) {
          row.removeEventListener("click", onClick);
          resolve(true);
        }
      };
      row.addEventListener("click", onClick);
    });
    if (!ok) break;
    best = length;
  }
  return best === 0 ? 0 : Math.min(1000, Math.round(((best - 2) / 7) * 1000));
}

async function timing(root: HTMLElement, rng: Rng, ease: number): Promise<number> {
  root.innerHTML = "";
  const status = el("p", "challenge-status");
  const bar = el("div", "bridge");
  const zone = el("div", "bridge-zone");
  const marker = el("div", "bridge-marker");
  bar.append(zone, marker);
  const stop = el("button", "primary", "Stop");
  root.append(status, bar, stop);
  let total = 0;

  for (let attempt = 1; attempt <= 5; attempt++) {
    status.textContent = `Try ${attempt} of 5`;
    const width = (0.14 - attempt * 0.015) * ease;
    const start = 0.1 + rng.next() * (0.8 - width);
    zone.style.left = `${start * 100}%`;
    zone.style.width = `${width * 100}%`;
    const speed = (0.7 + attempt * 0.15) / ease; // track widths per second
    const t0 = performance.now();
    let pos = 0;
    let raf = 0;
    const tick = (t: number) => {
      const x = (((t - t0) / 1000) * speed) % 2;
      pos = x <= 1 ? x : 2 - x;
      marker.style.left = `${pos * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    await new Promise<void>((resolve) => stop.addEventListener("click", () => resolve(), { once: true }));
    cancelAnimationFrame(raf);
    const centre = start + width / 2;
    const off = Math.abs(pos - centre);
    const points = off <= width / 2 ? Math.round(200 * (1 - off / width)) : Math.max(0, Math.round(60 - off * 300));
    total += points;
    status.textContent = points >= 100 ? `Steady! +${points}` : `Wobbly... +${points}`;
    await wait(700);
  }
  return Math.min(1000, total);
}
