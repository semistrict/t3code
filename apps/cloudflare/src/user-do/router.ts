/**
 * Hono HTTP router for UserDO requests.
 *
 * @module user-do/router
 */
import { Hono } from "hono";
import { getSandbox } from "@cloudflare/sandbox";

import type { Env } from "../index.ts";
import type { OrchestrationState } from "./orchestration.ts";
import type { SandboxManager } from "./sandbox-manager.ts";
import type { DoSqlStorage } from "../do-sqlite-client.ts";

export function buildRouter(
  env: Env,
  orchestration: OrchestrationState,
  sandboxManager: SandboxManager,
  sql?: DoSqlStorage,
) {
  const app = new Hono();

  app.get("/api/sandboxes", (c) => {
    return c.json({ sandboxes: sandboxManager.listSandboxes() });
  });

  app.post("/api/sandboxes", async (c) => {
    const { repo, branch } = await c.req.json<{ repo: string; branch: string }>();
    const sandboxId = sandboxManager.getOrCreateSandboxId(repo, branch);
    return c.json({ sandboxId, repo, branch });
  });

  app.get("/api/snapshot", async (c) => {
    const snapshot = await orchestration.runtime.runPromise(
      orchestration.projectionQuery.getSnapshot(),
    );
    return c.json(snapshot);
  });

  // ── Debug endpoints ──────────────────────────────────────────

  app.post("/api/debug/create-project", async (c) => {
    try {
      const body = await c.req.json<{ title: string; workspaceRoot?: string }>();
      const projectId = crypto.randomUUID();
      const result = await orchestration.runtime.runPromise(
        orchestration.engine.dispatch({
          type: "project.create",
          commandId: `debug:${crypto.randomUUID()}`,
          projectId,
          title: body.title,
          workspaceRoot: body.workspaceRoot ?? `/workspace/${body.title}`,
          defaultModel: "gpt-5.4",
          createdAt: new Date().toISOString(),
        } as any),
      );
      return c.json({ ok: true, projectId, result });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/api/debug/create-thread", async (c) => {
    try {
      const body = await c.req.json<{ projectId: string; title: string; model?: string }>();
      const threadId = crypto.randomUUID();
      const result = await orchestration.runtime.runPromise(
        orchestration.engine.dispatch({
          type: "thread.create",
          commandId: `debug:${crypto.randomUUID()}`,
          projectId: body.projectId,
          threadId,
          title: body.title,
          model: body.model ?? "gpt-5.4",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        } as any),
      );
      return c.json({ ok: true, threadId, result });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/api/debug/send-message", async (c) => {
    try {
      const { threadId, message } = await c.req.json<{ threadId: string; message: string }>();
      const commandId = `debug:${crypto.randomUUID()}`;
      const messageId = crypto.randomUUID();
      const result = await orchestration.runtime.runPromise(
        orchestration.engine.dispatch({
          type: "thread.turn.start",
          commandId,
          threadId,
          message: {
            messageId,
            role: "user",
            text: message,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: new Date().toISOString(),
        } as any),
      );
      return c.json({ ok: true, commandId, messageId, result });
    } catch (err) {
      console.error("[debug/send-message] error:", err);
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get("/api/debug/sandboxes/:id/processes", async (c) => {
    try {
      const sandbox = getSandbox(env.SandboxDO, c.req.param("id"), { normalizeId: true, keepAlive: true });
      const processes = await sandbox.listProcesses();
      return c.json({ processes });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.get("/api/debug/sandboxes/:id/logs/:processId", async (c) => {
    try {
      const sandbox = getSandbox(env.SandboxDO, c.req.param("id"), { normalizeId: true, keepAlive: true });
      const logs = await sandbox.getProcessLogs(c.req.param("processId"));
      return c.json(logs);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  // Delete all events for a stream (thread or project) from the event store.
  // This is a repair tool — after deletion, restart the DO to replay without
  // the corrupted/unwanted events.
  app.get("/api/debug/events", (c) => {
    if (!sql) return c.json({ error: "sql not available" }, 500);
    const rows = [...sql.exec(
      `SELECT sequence, stream_id, event_type, occurred_at FROM orchestration_events ORDER BY sequence`,
    )];
    return c.json({ events: rows });
  });

  app.delete("/api/debug/events/:streamId", async (c) => {
    if (!sql) return c.json({ error: "sql not available" }, 500);
    try {
      const streamId = c.req.param("streamId");

      const tables = [
        { name: "orchestration_events", col: "stream_id" },
        { name: "orchestration_command_receipts", col: "stream_id" },
        { name: "projection_threads", col: "thread_id" },
        { name: "projection_thread_messages", col: "thread_id" },
        { name: "projection_thread_sessions", col: "thread_id" },
        { name: "projection_thread_activities", col: "thread_id" },
        { name: "projection_thread_proposed_plans", col: "thread_id" },
        { name: "projection_turns", col: "thread_id" },
        { name: "projection_pending_approvals", col: "thread_id" },
      ];

      const results: Record<string, number> = {};
      for (const { name, col } of tables) {
        try {
          const rows = [...sql.exec(`SELECT COUNT(*) as count FROM ${name} WHERE ${col} = ?1`, streamId)];
          const count = (rows[0] as Record<string, unknown>)?.count ?? 0;
          sql.exec(`DELETE FROM ${name} WHERE ${col} = ?1`, streamId);
          results[name] = Number(count);
        } catch {
          // Table might not exist or column mismatch — skip
        }
      }

      return c.json({ ok: true, streamId, deleted: results, note: "Restart DO to rebuild projections" });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/api/debug/sandboxes/:id/kill", async (c) => {
    try {
      const sandbox = getSandbox(env.SandboxDO, c.req.param("id"), { normalizeId: true, keepAlive: true });
      await sandbox.destroy();
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  app.post("/api/debug/sandboxes/:id/exec", async (c) => {
    try {
      const { command } = await c.req.json<{ command: string }>();
      const sandbox = getSandbox(env.SandboxDO, c.req.param("id"), { normalizeId: true, keepAlive: true });
      const result = await sandbox.exec(command);
      return c.json(result);
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}
