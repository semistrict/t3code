/**
 * Worker entry point for t3code on Cloudflare.
 *
 * Routes API and WebSocket requests to UserDO/SandboxDO. Static assets
 * (the web UI from apps/web/dist/) are served automatically by Cloudflare
 * Workers Static Assets with SPA fallback — see wrangler.jsonc `assets`.
 *
 * @module Worker
 */
import { Hono } from "hono";

export { UserDO } from "./user-do/index.ts";
export { SandboxDO } from "./sandbox-do.ts";

// Env is generated globally by `wrangler types` (worker-configuration.d.ts).
// API keys come from .dev.vars / secrets at runtime.
export type Env = Cloudflare.Env & {
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  CODEX_AUTH_JSON?: string;
};

const USER_ID = "dev";

const app = new Hono<{ Bindings: Env }>();

function getUserDOStub(env: Env) {
  return env.UserDO.get(env.UserDO.idFromName(USER_ID));
}

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/sandboxes", async (c) => {
  const stub = getUserDOStub(c.env);
  const response = await stub.fetch(new Request("http://do/api/sandboxes"));
  return c.json(await response.json());
});

app.post("/api/sandboxes", async (c) => {
  const stub = getUserDOStub(c.env);
  const response = await stub.fetch(
    new Request("http://do/api/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: await c.req.text(),
    }),
  );
  return c.json(await response.json());
});

// Proxy all other /api/* routes to UserDO
app.all("/api/*", async (c) => {
  const stub = getUserDOStub(c.env);
  return stub.fetch(c.req.raw);
});

// Catch-all: WebSocket upgrades go to UserDO, everything else to static assets
app.get("*", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() === "websocket") {
    const stub = getUserDOStub(c.env);
    return stub.fetch(c.req.raw);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
