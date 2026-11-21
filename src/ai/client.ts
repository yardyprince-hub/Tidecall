import type {
  AiStatus,
  ConfessRequest,
  ConfessResponse,
  JuryRequest,
  JuryResponse,
  TalkRequest,
  TalkResponse,
  VoteRequest,
  VoteResponse,
} from "./protocol.js";

/**
 * Browser side of the AI server. Every call resolves to null on any failure (no key,
 * no server, timeout, refusal), so the game can fall back to the stand-in bots.
 */
export interface AiClient {
  status(): Promise<AiStatus>;
  talk(req: Omit<TalkRequest, "op">): Promise<TalkResponse | null>;
  confess(req: Omit<ConfessRequest, "op">): Promise<ConfessResponse | null>;
  vote(req: Omit<VoteRequest, "op">): Promise<VoteResponse | null>;
  jury(req: Omit<JuryRequest, "op">): Promise<JuryResponse | null>;
}

async function post<T>(body: object, timeoutMs: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const httpAiClient: AiClient = {
  async status() {
    try {
      const res = await fetch("/api/ai/status");
      if (!res.ok) return { enabled: false };
      return (await res.json()) as AiStatus;
    } catch {
      return { enabled: false };
    }
  },
  talk: (req) => post<TalkResponse>({ op: "talk", ...req }, 30_000),
  confess: (req) => post<ConfessResponse>({ op: "confess", ...req }, 30_000),
  vote: (req) => post<VoteResponse>({ op: "vote", ...req }, 45_000),
  jury: (req) => post<JuryResponse>({ op: "jury", ...req }, 45_000),
};
