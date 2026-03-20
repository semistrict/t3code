/**
 * Sandbox registry and connection management.
 *
 * Maintains the (repo, branch) → sandbox UUID mapping in DO SQLite,
 * and manages active connections to sandbox ExecutionAgents via HTTP.
 *
 * @module user-do/sandbox-manager
 */
import { getSandbox } from "@cloudflare/sandbox";
import { Effect, ManagedRuntime, PubSub, Stream } from "effect";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import { makeExecutionSandboxLive, type ContainerFetcher } from "../execution-sandbox.ts";
import { ExecutionService } from "../../../server/src/execution/Services/ExecutionService.ts";

import type { Env } from "../index.ts";
import type { OrchestrationState } from "./orchestration.ts";

const EXECUTION_AGENT_PORT = 9999;

export interface SandboxRow {
  id: string;
  repo: string;
  branch: string;
  created_at: string;
}

export interface ActiveSandbox {
  sandboxId: string;
  execution: ExecutionService["Service"];
  runtime: ManagedRuntime.ManagedRuntime<any, any>;
}

export class SandboxManager {
  private activeSandboxes = new Map<string, ActiveSandbox>();
  private pendingSandboxes = new Map<string, Promise<ActiveSandbox>>();
  private providerEventPubSub: PubSub.PubSub<ProviderRuntimeEvent>;

  constructor(
    private sql: SqlStorage,
    private env: Env,
    private orchestration: OrchestrationState,
    private onTerminalEvent: (event: any) => void,
  ) {
    this.providerEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  }

  // ── Registry ──────────────────────────────────────────────────

  getOrCreateSandboxId(repo: string, branch: string): string {
    const cursor = this.sql.exec(
      `SELECT id FROM sandboxes WHERE repo = ?1 AND branch = ?2`,
      repo,
      branch,
    );
    const existing = [...cursor];
    if (existing.length > 0) {
      return String((existing[0] as Record<string, unknown>).id);
    }

    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO sandboxes (id, repo, branch, created_at) VALUES (?1, ?2, ?3, ?4)`,
      id,
      repo,
      branch,
      createdAt,
    );
    return id;
  }

  listSandboxes(): SandboxRow[] {
    const cursor = this.sql.exec(
      `SELECT id, repo, branch, created_at FROM sandboxes ORDER BY created_at DESC`,
    );
    return Array.from(cursor, (row) => {
      const r = row as Record<string, unknown>;
      return {
        id: String(r.id),
        repo: String(r.repo),
        branch: String(r.branch),
        created_at: String(r.created_at),
      };
    });
  }

  async resolveSandboxForThread(projectId: string, threadId: string): Promise<string> {
    const snapshot = await this.orchestration.runtime.runPromise(
      this.orchestration.projectionQuery.getSnapshot(),
    );

    const project = snapshot.projects.find((p) => p.id === projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found`);
    }

    const thread = snapshot.threads.find((t) => t.id === threadId);
    const branch = thread?.branch ?? "main";
    return this.getOrCreateSandboxId(project.workspaceRoot, branch);
  }

  // ── Active connections ────────────────────────────────────────

  async getActiveSandbox(sandboxId: string): Promise<ActiveSandbox> {
    const existing = this.activeSandboxes.get(sandboxId);
    if (existing) return existing;

    const pending = this.pendingSandboxes.get(sandboxId);
    if (pending) return pending;

    const promise = this.connectSandbox(sandboxId);
    this.pendingSandboxes.set(sandboxId, promise);
    try {
      return await promise;
    } finally {
      this.pendingSandboxes.delete(sandboxId);
    }
  }

  private async connectSandbox(sandboxId: string): Promise<ActiveSandbox> {
    const sandbox = getSandbox(this.env.SandboxDO, sandboxId, {
      normalizeId: true,
      keepAlive: true,
    });

    console.log(`[SandboxManager] ensuring ExecutionAgent for ${sandboxId}`);
    await this.ensureExecutionAgent(sandbox);
    console.log(`[SandboxManager] ExecutionAgent ready`);

    // Create a fetcher that routes HTTP requests to the container's ExecutionAgent port.
    //
    // Cloudflare Containers pattern: switchPort(request, port) rewrites the request
    // so that when passed to stub.fetch(), the container runtime routes it to the
    // given port inside the container instead of the default port (3000).
    // This is the same mechanism used by @cloudflare/sandbox's wsConnect() and
    // proxyToSandbox() — see getSandbox() source in the sandbox SDK.
    // Ref: cloudflare/sandbox-sdk/packages/sandbox/src/sandbox.ts (connect() function)
    //
    // Use containerFetch(request, port) to route HTTP requests to the
    // ExecutionAgent's port inside the container. Unlike switchPort + fetch(),
    // containerFetch handles port routing through the container's TCP layer
    // which works in both local dev and production.
    // Ref: cloudflare/sandbox-sdk/packages/sandbox/src/sandbox.ts
    const fetcher: ContainerFetcher = {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return sandbox.containerFetch(request, EXECUTION_AGENT_PORT);
      },
    };

    const executionLayer = makeExecutionSandboxLive(fetcher, "http://container");
    const runtime = ManagedRuntime.make(executionLayer);
    const execution = await runtime.runPromise(Effect.service(ExecutionService));

    // Subscribe to terminal events
    await runtime.runPromise(
      execution.terminal.subscribe((event) => this.onTerminalEvent(event)),
    );

    const active: ActiveSandbox = { sandboxId, execution, runtime };
    this.activeSandboxes.set(sandboxId, active);
    this.subscribeProviderEvents(active);

    console.log(`[SandboxManager] connected to sandbox ${sandboxId} via HTTP`);
    return active;
  }

  private async ensureExecutionAgent(
    sandbox: ReturnType<typeof getSandbox>,
  ): Promise<void> {
    try {
      const processes = await sandbox.listProcesses();
      const running = processes.find(
        (p) => p.status === "running" && p.command.includes("t3code-execution-agent"),
      );
      if (running) {
        await running.waitForPort(EXECUTION_AGENT_PORT, {
          mode: "tcp",
          timeout: 30_000,
        });
        return;
      }
    } catch {
      // Container may not be ready yet
    }

    await sandbox.mkdir("/workspace", { recursive: true });

    // Write codex auth credentials to the config directory so the codex CLI
    // can use ChatGPT OAuth tokens instead of an API key.
    // Ref: codex-do/src/index.ts
    const codexConfigHome = "/root/.codex";
    if (this.env.CODEX_AUTH_JSON) {
      await sandbox.mkdir(codexConfigHome, { recursive: true });
      await sandbox.writeFile(`${codexConfigHome}/auth.json`, this.env.CODEX_AUTH_JSON);
    }

    const proc = await sandbox.startProcess(
      `/opt/t3code/t3code-execution-agent --port ${EXECUTION_AGENT_PORT} --cwd /workspace`,
      {
        cwd: "/opt/t3code",
        env: {
          HOME: "/root",
          PATH: "/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          TERM: "xterm-256color",
          CODEX_HOME: codexConfigHome,
          ...(this.env.OPENAI_API_KEY ? { OPENAI_API_KEY: this.env.OPENAI_API_KEY } : {}),
          ...(this.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY } : {}),
        },
      },
    );

    try {
      await proc.waitForPort(EXECUTION_AGENT_PORT, {
        mode: "http",
        status: { min: 200, max: 499 },
        timeout: 60_000,
      });
    } catch (err) {
      try {
        const logs = await sandbox.getProcessLogs(proc.id);
        console.error("ExecutionAgent stdout:", logs.stdout);
        console.error("ExecutionAgent stderr:", logs.stderr);
      } catch {}
      throw err;
    }
  }

  /**
   * Resolve which sandbox to use from a request body.
   */
  async resolveFromRequest(body: any): Promise<ActiveSandbox> {
    const projectId = body.projectId;
    const threadId = body.threadId;

    if (projectId && threadId) {
      const sandboxId = await this.resolveSandboxForThread(projectId, threadId);
      return this.getActiveSandbox(sandboxId);
    }

    const cwd: string | undefined = body.cwd ?? body.workspaceRoot;
    if (cwd) {
      const snapshot = await this.orchestration.runtime.runPromise(
        this.orchestration.projectionQuery.getSnapshot(),
      );
      const project = snapshot.projects.find((p) => p.workspaceRoot === cwd);
      if (project) {
        const sandboxId = this.getOrCreateSandboxId(project.workspaceRoot, "main");
        return this.getActiveSandbox(sandboxId);
      }
    }

    const sandboxes = this.listSandboxes();
    if (sandboxes.length > 0) {
      return this.getActiveSandbox(sandboxes[0]!.id);
    }

    const sandboxId = this.getOrCreateSandboxId("/workspace", "main");
    return this.getActiveSandbox(sandboxId);
  }

  // ── Routing helpers (used by ExecutionRoutingLive) ──────────

  /**
   * Resolve sandbox from threadId using a pre-fetched snapshot.
   */
  async resolveFromThreadIdWithSnapshot(
    threadId: string,
    snapshot: { threads: ReadonlyArray<any>; projects: ReadonlyArray<any> },
  ): Promise<ActiveSandbox> {
    const thread = snapshot.threads.find((t) => t.id === threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} not found`);
    }
    const project = snapshot.projects.find((p) => p.id === thread.projectId);
    if (!project) {
      throw new Error(`Project ${thread.projectId} not found for thread ${threadId}`);
    }
    const sandboxId = this.getOrCreateSandboxId(project.workspaceRoot, thread.branch ?? "main");
    return this.getActiveSandbox(sandboxId);
  }

  /**
   * Resolve sandbox from threadId (standalone, NOT called from within the Effect runtime).
   */
  async resolveFromThreadId(threadId: string): Promise<ActiveSandbox> {
    const snapshot = await this.orchestration.runtime.runPromise(
      this.orchestration.projectionQuery.getSnapshot(),
    );
    return this.resolveFromThreadIdWithSnapshot(threadId, snapshot);
  }

  /**
   * Get ExecutionService shapes from all currently connected sandboxes.
   */
  async listActiveSandboxExecutions(): Promise<ExecutionService["Service"][]> {
    return Array.from(this.activeSandboxes.values()).map((s) => s.execution);
  }

  /**
   * Get any active sandbox (for operations that don't need routing).
   */
  async getAnyActiveSandbox(): Promise<ActiveSandbox> {
    const firstActive = this.activeSandboxes.values().next();
    if (!firstActive.done) {
      return firstActive.value;
    }
    const sandboxes = this.listSandboxes();
    if (sandboxes.length > 0) {
      return this.getActiveSandbox(sandboxes[0]!.id);
    }
    const sandboxId = this.getOrCreateSandboxId("/workspace", "main");
    return this.getActiveSandbox(sandboxId);
  }

  /**
   * Merged provider event stream from all active sandboxes.
   */
  mergedProviderEventStream(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromPubSub(this.providerEventPubSub);
  }

  // Called during connectSandbox to wire up provider events into the shared pubsub
  private subscribeProviderEvents(active: ActiveSandbox): void {
    const pubsub = this.providerEventPubSub;
    active.runtime.runPromise(
      Stream.runForEach(active.execution.provider.streamEvents, (event) =>
        PubSub.publish(pubsub, event),
      ),
    ).catch((err) => {
      console.error(`[SandboxManager] provider event stream error for ${active.sandboxId}:`, err);
    });
  }
}
