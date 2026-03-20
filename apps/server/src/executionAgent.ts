/**
 * ExecutionAgent - Standalone HTTP server for remote execution.
 *
 * Exposes two endpoints:
 *   POST /rpc     — JSON-RPC request/response for execution methods
 *   GET  /events  — SSE stream of push events (provider + terminal)
 *
 * The single client (UserDO) calls /rpc for commands and subscribes
 * to /events for streaming provider and terminal events.
 *
 * Usage:
 *   bun run apps/server/src/executionAgent.ts --port 9999 --cwd /workspace
 *
 * @module ExecutionAgent
 */
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EXECUTION_METHODS,
  EXECUTION_PUSH_CHANNELS,
  type ExecutionRpcRequest,
  type ExecutionRpcResponse,
  type ExecutionPushEvent,
  type TerminalEvent,
} from "@t3tools/contracts";

import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitServiceLive } from "./git/Layers/GitService.ts";
import { GitManagerLive } from "./git/Layers/GitManager.ts";
import { GitHubCliLive } from "./git/Layers/GitHubCli.ts";
import { CodexTextGenerationLive } from "./git/Layers/CodexTextGeneration.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery.ts";
import { BunPtyAdapterLive } from "./terminal/Layers/BunPTY.ts";
import { NodePtyAdapterLive } from "./terminal/Layers/NodePTY.ts";
import { OpenLive } from "./open.ts";
import { ServerConfig } from "./config.ts";
import { ExecutionLocalLive } from "./execution/Layers/ExecutionLocal.ts";
import { ExecutionService } from "./execution/Services/ExecutionService.ts";
import { makeServerProviderLayer } from "./serverLayers.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { makeSqlitePersistenceLive } from "./persistence/Layers/Sqlite.ts";

function parseArgs(): { port: number; cwd: string } {
  const args = process.argv.slice(2);
  let port = 9999;
  let cwd = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1]!, 10);
      i++;
    } else if (args[i] === "--cwd" && args[i + 1]) {
      cwd = args[i + 1]!;
      i++;
    }
  }
  return { port, cwd };
}

async function main() {
  const { port, cwd } = parseArgs();
  console.log(`ExecutionAgent starting on port ${port}, cwd=${cwd}`);

  // Build execution service layer
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const textGenerationLayer = CodexTextGenerationLive;
  const terminalLayer = TerminalManagerLive.pipe(
    Layer.provide(
      typeof Bun !== "undefined" && process.platform !== "win32"
        ? BunPtyAdapterLive
        : NodePtyAdapterLive,
    ),
  );
  const gitManagerLayer = GitManagerLive.pipe(
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(GitHubCliLive),
    Layer.provideMerge(textGenerationLayer),
  );
  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(CheckpointStoreLive),
  );

  const stateDir = `${cwd}/.t3code-agent`;
  const serverConfigLayer = Layer.succeed(ServerConfig, {
    mode: "web" as const,
    port,
    host: undefined,
    cwd,
    keybindingsConfigPath: `${stateDir}/keybindings.json`,
    stateDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    executionMode: "local" as const,
    executionUrl: undefined,
  });

  const persistenceLayer = makeSqlitePersistenceLive(`${stateDir}/state.db`);

  const executionLayer = ExecutionLocalLive.pipe(
    Layer.provideMerge(terminalLayer),
    Layer.provideMerge(gitCoreLayer),
    Layer.provideMerge(gitManagerLayer),
    Layer.provideMerge(checkpointDiffQueryLayer),
    Layer.provideMerge(OpenLive),
    Layer.provideMerge(textGenerationLayer),
    Layer.provideMerge(makeServerProviderLayer()),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(AnalyticsService.layerTest),
    Layer.provideMerge(NodeServices.layer),
  );

  const runtime = ManagedRuntime.make(executionLayer);
  const execution = await runtime.runPromise(Effect.service(ExecutionService));

  // ── SSE event buffer ────────────────────────────────────────────
  // Single client: one SSE controller at a time
  let sseController: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  function pushEvent(event: ExecutionPushEvent) {
    if (sseController) {
      sseController.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    }
  }

  // Subscribe to terminal events
  const unsubTerminal = await runtime.runPromise(
    execution.terminal.subscribe((event: TerminalEvent) => {
      pushEvent({
        type: "push",
        channel: EXECUTION_PUSH_CHANNELS.terminalEvent,
        data: event,
      } as ExecutionPushEvent);
    }),
  );

  // Subscribe to provider events
  void runtime.runPromise(
    Stream.runForEach(execution.provider.streamEvents, (event) =>
      Effect.sync(() => {
        pushEvent({
          type: "push",
          channel: EXECUTION_PUSH_CHANNELS.providerEvent,
          data: event,
        } as ExecutionPushEvent);
      }),
    ),
  );

  // ── HTTP server ─────────────────────────────────────────────────
  Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);

      // Health / upgrade check
      if (url.pathname === "/" || url.pathname === "/health") {
        return new Response("OK", { status: 200 });
      }

      // POST /rpc — JSON-RPC request/response
      if (url.pathname === "/rpc" && req.method === "POST") {
        let request: ExecutionRpcRequest;
        try {
          request = await req.json();
        } catch {
          return Response.json(
            { id: "unknown", error: { message: "Invalid JSON" } },
            { status: 400 },
          );
        }

        try {
          console.log(`ExecutionAgent: RPC ${request.method} (id=${request.id})`);
          const result = await routeRequest(runtime, execution, request);
          console.log(`ExecutionAgent: RPC ${request.method} completed (id=${request.id})`);
          const response: ExecutionRpcResponse = { id: request.id, result };
          return Response.json(response);
        } catch (err) {
          const response: ExecutionRpcResponse = {
            id: request.id,
            error: { message: err instanceof Error ? err.message : String(err) },
          };
          return Response.json(response, { status: 500 });
        }
      }

      // GET /events — SSE stream of push events
      if (url.pathname === "/events" && req.method === "GET") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Close any previous SSE connection (single client)
            if (sseController) {
              try { sseController.close(); } catch {}
            }
            sseController = controller;
            // Send keepalive comment
            controller.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            sseController = null;
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.log(`ExecutionAgent listening on http://0.0.0.0:${port}`);

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("ExecutionAgent shutting down...");
    unsubTerminal();
    if (sseController) {
      try { sseController.close(); } catch {}
    }
    process.exit(0);
  });
}

async function routeRequest(
  runtime: { runPromise: <A>(effect: Effect.Effect<A, any, any>) => Promise<A> },
  execution: ExecutionService["Service"],
  request: ExecutionRpcRequest,
): Promise<unknown> {
  const { method, params } = request;
  const p = params as Record<string, unknown>;
  const run = <A>(effect: Effect.Effect<A, any, any>) => runtime.runPromise(effect as any);

  switch (method) {
    // Provider operations
    case EXECUTION_METHODS.providerStartSession:
      return run(execution.provider.startSession(p.threadId as any, p.input as any));
    case EXECUTION_METHODS.providerSendTurn:
      return run(execution.provider.sendTurn(p as any));
    case EXECUTION_METHODS.providerInterruptTurn:
      return run(execution.provider.interruptTurn(p as any));
    case EXECUTION_METHODS.providerRespondToRequest:
      return run(execution.provider.respondToRequest(p as any));
    case EXECUTION_METHODS.providerRespondToUserInput:
      return run(execution.provider.respondToUserInput(p as any));
    case EXECUTION_METHODS.providerStopSession:
      return run(execution.provider.stopSession(p as any));
    case EXECUTION_METHODS.providerListSessions:
      return run(execution.provider.listSessions());
    case EXECUTION_METHODS.providerGetCapabilities:
      return run(execution.provider.getCapabilities(p.provider as any));
    case EXECUTION_METHODS.providerRollbackConversation:
      return run(execution.provider.rollbackConversation(p as any));

    // Terminal operations
    case EXECUTION_METHODS.terminalOpen:
      return run(execution.terminal.open(p as any));
    case EXECUTION_METHODS.terminalWrite:
      return run(execution.terminal.write(p as any));
    case EXECUTION_METHODS.terminalResize:
      return run(execution.terminal.resize(p as any));
    case EXECUTION_METHODS.terminalClear:
      return run(execution.terminal.clear(p as any));
    case EXECUTION_METHODS.terminalRestart:
      return run(execution.terminal.restart(p as any));
    case EXECUTION_METHODS.terminalClose:
      return run(execution.terminal.close(p as any));

    // Git operations
    case EXECUTION_METHODS.gitStatus:
      return run(execution.git.status(p as any));
    case EXECUTION_METHODS.gitPull:
      return run(execution.git.pullCurrentBranch(p.cwd as string));
    case EXECUTION_METHODS.gitListBranches:
      return run(execution.git.listBranches(p as any));
    case EXECUTION_METHODS.gitCreateBranch:
      return run(execution.git.createBranch(p as any));
    case EXECUTION_METHODS.gitCheckout:
      return run(Effect.scoped(execution.git.checkoutBranch(p as any)));
    case EXECUTION_METHODS.gitCreateWorktree:
      return run(execution.git.createWorktree(p as any));
    case EXECUTION_METHODS.gitRemoveWorktree:
      return run(execution.git.removeWorktree(p as any));
    case EXECUTION_METHODS.gitInit:
      return run(execution.git.initRepo(p as any));
    case EXECUTION_METHODS.gitRenameBranch:
      return run(execution.git.renameBranch(p as any));

    // Git manager operations
    case EXECUTION_METHODS.gitManagerStatus:
      return run(execution.gitManager.status(p as any));
    case EXECUTION_METHODS.gitRunStackedAction:
      return run(execution.gitManager.runStackedAction(p as any));
    case EXECUTION_METHODS.gitResolvePullRequest:
      return run(execution.gitManager.resolvePullRequest(p as any));
    case EXECUTION_METHODS.gitPreparePullRequestThread:
      return run(execution.gitManager.preparePullRequestThread(p as any));

    // Filesystem operations
    case EXECUTION_METHODS.fsSearchEntries:
      return run(execution.fs.searchEntries(p as any));
    case EXECUTION_METHODS.fsWriteFile:
      return run(execution.fs.writeFile(p as any));

    // Checkpoint operations
    case EXECUTION_METHODS.checkpointGetTurnDiff:
      return run(execution.checkpoint.getTurnDiff(p as any));
    case EXECUTION_METHODS.checkpointGetFullThreadDiff:
      return run(execution.checkpoint.getFullThreadDiff(p as any));

    // Shell operations
    case EXECUTION_METHODS.shellOpenInEditor:
      return run(execution.shell.openInEditor(p as any));

    // Text generation
    case EXECUTION_METHODS.textGenerationGenerateBranchName:
      return run(execution.textGeneration.generateBranchName(p as any));

    default:
      throw new Error(`Unknown execution method: ${method}`);
  }
}

main().catch((err) => {
  console.error("ExecutionAgent fatal error:", err);
  process.exit(1);
});
