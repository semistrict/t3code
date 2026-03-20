/**
 * UserDO - Durable Object that owns orchestration state and sandbox registry.
 *
 * Each UserDO instance represents one user. It manages orchestration
 * (event sourcing, projections) and routes execution to SandboxDO containers
 * (one per repo + branch).
 *
 * @module user-do
 */
import { DurableObject } from "cloudflare:workers";
import { Effect, Ref, Scope } from "effect";

import type { Env } from "../index.ts";
import { initOrchestration, type OrchestrationState } from "./orchestration.ts";
import { SandboxManager } from "./sandbox-manager.ts";
import { WsHandler } from "./ws-handler.ts";
import { buildRouter } from "./router.ts";

export class UserDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private orchestration: OrchestrationState | null = null;
  private sandboxManager: SandboxManager | null = null;
  private wsHandler: WsHandler | null = null;
  private router: ReturnType<typeof buildRouter> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Create sandbox registry table
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sandboxes_repo_branch
        ON sandboxes(repo, branch);
    `);

    this.ctx.blockConcurrencyWhile(() => this.init());
  }

  private async init(): Promise<void> {
    try {
      // 1. Init orchestration (with ExecutionRoutingLive backed by a null Ref)
      this.orchestration = await initOrchestration(this.sql as any);

      // 2. Create SandboxManager with the orchestration state
      this.sandboxManager = new SandboxManager(
        this.sql,
        this.env,
        this.orchestration,
        (event) => this.wsHandler?.onTerminalEvent(event),
      );

      // 3. Set the SandboxManager on the Ref so ExecutionRoutingLive can route
      Effect.runSync(Ref.set(this.orchestration.sandboxManagerRef, this.sandboxManager));

      // 4. Start the orchestration reactor (provider commands, runtime ingestion, checkpoints)
      const scope = Effect.runSync(Scope.make());
      await this.orchestration.runtime.runPromise(
        this.orchestration.reactor.start.pipe(Scope.provide(scope)),
      );

      // 5. Wire up WS handler and router
      this.wsHandler = new WsHandler(this.orchestration, this.sandboxManager);
      this.router = buildRouter(this.env, this.orchestration, this.sandboxManager, this.sql as any);
      this.wsHandler.startEventSubscriptions();
    } catch (err) {
      // Orchestration failed (e.g. corrupted events). Stand up a minimal
      // router with the repair endpoint so the bad data can be deleted.
      console.error("[UserDO] init failed, starting in repair mode:", err);
      this.router = buildRouter(this.env, this.orchestration!, this.sandboxManager!, this.sql as any);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.router) {
      return new Response("DO not initialized", { status: 503 });
    }

    // In repair mode (orchestration failed), only the router is available
    if (this.wsHandler && request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return this.wsHandler.handleUpgrade();
    }

    return this.router.fetch(request);
  }
}
