import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import { z } from "zod";
import type { AiRequest, AiStatus } from "../src/ai/protocol.js";
import { cleanLine, confessPrompt, juryPrompt, matchOption, SYSTEM_PROMPT, talkPrompt, votePrompt } from "../src/ai/prompts.js";

/**
 * The small server that lets the AI castaways talk.
 *
 * It runs inside the Vite dev/preview server on your own computer, reads your Anthropic
 * API key from the git-ignored .env file, and is the only place the key is used. The
 * browser calls /api/ai and gets back a castaway's line or vote, never the key.
 */

export const DEFAULT_MODEL = "claude-opus-5-5";

const Talk = z.object({ text: z.string() });
const Confess = z.object({ confessional: z.string(), plan: z.string() });
const Vote = z.object({ vote: z.string(), playRelic: z.boolean(), reason: z.string() });
const Jury = z.object({ vote: z.string(), reason: z.string() });

/** The part of the SDK client we use, so tests can pass a fake. */
export type MessagesClient = Pick<Anthropic["messages"], "parse">;

export class AiBrain {
  constructor(
    private messages: MessagesClient,
    readonly model: string = DEFAULT_MODEL,
  ) {}

  private async ask<T extends z.ZodType>(prompt: string, schema: T): Promise<z.infer<T> | null> {
    const response = await this.messages.parse({
      model: this.model,
      max_tokens: 4000,
      // The rules never change between calls, so cache them.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: prompt }],
      // Quick, in-character answers matter more than deep deliberation here.
      output_config: { effort: "low", format: zodOutputFormat(schema) },
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return null;
    return (response.parsed_output as z.infer<T> | null) ?? null;
  }

  /** Returns the JSON body to send back, or null when the browser should fall back. */
  async handle(req: AiRequest): Promise<object | null> {
    switch (req.op) {
      case "talk": {
        const out = await this.ask(talkPrompt(req), Talk);
        const text = out ? cleanLine(out.text, req.view.name) : "";
        return text ? { text } : null;
      }
      case "confess": {
        const out = await this.ask(confessPrompt(req), Confess);
        return out ? { confessional: cleanLine(out.confessional, req.view.name, 500), plan: out.plan.slice(0, 400) } : null;
      }
      case "vote": {
        const out = await this.ask(votePrompt(req), Vote);
        const vote = out && matchOption(out.vote, req.options);
        return out && vote ? { vote, playRelic: req.canPlayRelic && out.playRelic, reason: out.reason } : null;
      }
      case "jury": {
        const out = await this.ask(juryPrompt(req), Jury);
        const vote = out && matchOption(out.vote, req.finalists);
        return out && vote ? { vote, reason: out.reason } : null;
      }
    }
  }
}

const OPS = new Set(["talk", "confess", "vote", "jury"]);

function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) reject(new Error("Request too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: object): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

/** Connect-style handler for /api/ai. Exported for tests. */
export function aiHandler(brain: AiBrain | null) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/status" || path === "/")) {
      const status: AiStatus = brain ? { enabled: true, model: brain.model } : { enabled: false };
      return send(res, 200, status);
    }
    if (req.method !== "POST") return send(res, 405, { error: "Use POST" });
    if (!brain) return send(res, 503, { error: "No API key set. See README: put it in .env." });
    let body: AiRequest;
    try {
      body = (await readJson(req)) as AiRequest;
    } catch {
      return send(res, 400, { error: "Bad request" });
    }
    if (!body || typeof body !== "object" || !OPS.has(body.op) || !body.view?.name) {
      return send(res, 400, { error: "Bad request" });
    }
    try {
      const out = await brain.handle(body);
      if (!out) return send(res, 502, { error: "No usable answer" });
      send(res, 200, out);
    } catch (e) {
      // Log the kind of failure, never the key or the request headers.
      if (e instanceof Anthropic.AuthenticationError) console.error("[tidecall] The API key in .env was rejected. Check it.");
      else if (e instanceof Anthropic.RateLimitError) console.error("[tidecall] Rate limited by the API. Castaways will use stand-in lines for a moment.");
      else if (e instanceof Anthropic.APIError) console.error(`[tidecall] API error ${e.status}: ${e.message}`);
      else console.error("[tidecall] AI request failed:", (e as Error).message);
      send(res, 502, { error: "AI request failed" });
    }
  };
}

/** Vite plugin: serves /api/ai from `npm run dev` and `npm run preview`. */
export function tidecallAi(env: { apiKey?: string; model?: string }): Plugin {
  const key = env.apiKey?.trim();
  const brain = key ? new AiBrain(new Anthropic({ apiKey: key }).messages, env.model?.trim() || DEFAULT_MODEL) : null;
  const mount = (server: { middlewares: { use: (path: string, fn: ReturnType<typeof aiHandler>) => void } }) => {
    server.middlewares.use("/api/ai", aiHandler(brain));
    console.log(
      brain
        ? `[tidecall] AI castaways are ON (model ${brain.model}). Your key stays on this computer.`
        : "[tidecall] No ANTHROPIC_API_KEY in .env, so the castaways are simple stand-in bots.",
    );
  };
  return {
    name: "tidecall-ai",
    configureServer: mount,
    configurePreviewServer: mount,
  };
}
