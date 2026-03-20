/**
 * ExecutionAgent - Standalone WebSocket server for remote execution.
 *
 * Accepts JSON-RPC messages matching the execution protocol, routes them
 * to in-process service implementations (CodexAdapter, TerminalManager,
 * GitCore, etc.), and pushes provider/terminal events back over WebSocket.
 *
 * Usage:
 *   bun run apps/server/src/executionAgent.ts --port 9999 --cwd /workspace
 *
 * @module ExecutionAgent
 */
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WebSocketServer, type WebSocket } from "ws";
import {
  EXECUTION_METHODS,
  EXECUTION_PUSH_CHANNELS,
  type ExecutionRpcRequest,
  type ExecutionRpcResponse,
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

  // Start WebSocket server
  const wss = new WebSocketServer({ port });
  const clients = new Set<WebSocket>();

  // Subscribe to push events and broadcast
  const unsubTerminal = await runtime.runPromise(
    execution.terminal.subscribe((event: TerminalEvent) => {
      const push = JSON.stringify({
        type: "push",
        channel: EXECUTION_PUSH_CHANNELS.terminalEvent,
        data: event,
      });
      for (const ws of clients) ws.send(push);
    }),
  );

  // Subscribe to provider events
  void runtime.runPromise(
    Stream.runForEach(execution.provider.streamEvents, (event) =>
      Effect.sync(() => {
        const push = JSON.stringify({
          type: "push",
          channel: EXECUTION_PUSH_CHANNELS.providerEvent,
          data: event,
        });
        for (const ws of clients) ws.send(push);
      }),
    ),
  );

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log("ExecutionAgent: client connected");

    ws.on("message", async (raw) => {
      let request: ExecutionRpcRequest;
      try {
        request = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ id: "unknown", error: { message: "Invalid JSON" } }));
        return;
      }

      try {
        console.log(`ExecutionAgent: RPC ${request.method} (id=${request.id})`);
        const result = await routeRequest(runtime, execution, request);
        console.log(`ExecutionAgent: RPC ${request.method} completed (id=${request.id})`);
        const response: ExecutionRpcResponse = { id: request.id, result };
        ws.send(JSON.stringify(response));
      } catch (err) {
        const response: ExecutionRpcResponse = {
          id: request.id,
          error: { message: err instanceof Error ? err.message : String(err) },
        };
        ws.send(JSON.stringify(response));
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      console.log("ExecutionAgent: client disconnected");
    });
  });

  console.log(`ExecutionAgent listening on ws://0.0.0.0:${port}`);

  // Handle shutdown
  process.on("SIGINT", () => {
    console.log("ExecutionAgent shutting down...");
    unsubTerminal();
    wss.close();
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
