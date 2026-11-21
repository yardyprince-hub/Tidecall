import { defineConfig, loadEnv } from "vite";
import { tidecallAi } from "./server/ai.js";

export default defineConfig(({ mode }) => {
  // Reads .env on this computer. Only VITE_-prefixed values ever reach the browser,
  // so ANTHROPIC_API_KEY stays here on the server side.
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  return {
    plugins: [tidecallAi({ apiKey: env.ANTHROPIC_API_KEY, model: env.TIDECALL_MODEL })],
    server: { host: "localhost" },
    preview: { host: "localhost" },
  };
});
