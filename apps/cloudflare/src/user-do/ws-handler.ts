/**
 * WebSocket protocol handler for browser connections.
 *
 * Routes orchestration commands to the engine and execution
 * commands to the appropriate sandbox.
 *
 * @module user-do/ws-handler
 */
import { Effect, Stream } from "effect";
import { clamp } from "effect/Number";
import {
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  WS_CHANNELS,
  WS_METHODS,
  type OrchestrationCommand,
  type WsResponse as WsResponseMessage,
} from "@t3tools/contracts";

import type { OrchestrationState } from "./orchestration.ts";
import type { SandboxManager } from "./sandbox-manager.ts";
import { encodeWsResponse, broadcastPush, sendPush, sendError } from "./push.ts";

function stripRequestTag(body: any): any {
  const { _tag, ...rest } = body;
  return rest;
}

export class WsHandler {
  private clients = new Set<WebSocket>();
  private pushSequence = { value: 0 };

  constructor(
    private orchestration: OrchestrationState,
    private sandboxManager: SandboxManager,
  ) {}

  /**
   * Start subscribing to domain events and broadcasting to clients.
   */
  startEventSubscriptions(): void {
    void this.orchestration.runtime.runPromise(
      Stream.runForEach(this.orchestration.engine.streamDomainEvents, (event) =>
        Effect.sync(() =>
          broadcastPush(
            this.orchestration.runtime,
            this.clients,
            this.pushSequence,
            ORCHESTRATION_WS_CHANNELS.domainEvent,
            event,
          ),
        ),
      ),
    );
  }

  /**
   * Called when a terminal event arrives from a sandbox.
   */
  onTerminalEvent(event: any): void {
    broadcastPush(
      this.orchestration.runtime,
      this.clients,
      this.pushSequence,
      WS_CHANNELS.terminalEvent,
      event,
    );
  }

  /**
   * Handle a WebSocket upgrade request from a browser.
   */
  handleUpgrade(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.accept();
    this.clients.add(server);

    const welcomeData = {
      cwd: "/workspace",
      projectName: "project",
    };
    sendPush(this.orchestration.runtime, this.pushSequence, server, WS_CHANNELS.serverWelcome, welcomeData);

    server.addEventListener("message", (event) => {
      void this.handleMessage(
        server,
        typeof event.data === "string" ? event.data : "",
      );
    });

    server.addEventListener("close", () => this.clients.delete(server));
    server.addEventListener("error", () => this.clients.delete(server));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let request: { id: string; body: any };
    try {
      request = JSON.parse(raw);
    } catch {
      sendError(this.orchestration.runtime, ws, "unknown", "Invalid JSON");
      return;
    }

    try {
      const result = await this.routeRequest(request);
      const response: WsResponseMessage = { id: request.id, result };
      const encoded = await this.orchestration.runtime.runPromise(encodeWsResponse(response));
      ws.send(encoded);
    } catch (err) {
      sendError(
        this.orchestration.runtime,
        ws,
        request.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async routeRequest(request: { id: string; body: any }): Promise<unknown> {
    const { engine, projectionQuery: query, runtime: orchRuntime } = this.orchestration;
    const body = request.body;
    const tag = body._tag ?? body.method;

    const orchRun = <A>(effect: Effect.Effect<A, any, any>) =>
      orchRuntime.runPromise(effect as any);

    // Orchestration-only commands
    switch (tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return orchRun(query.getSnapshot());

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const command = body.command as OrchestrationCommand;
        return orchRun(engine.dispatch(command));
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = body;
        return orchRun(
          Stream.runCollect(
            engine.readEvents(
              clamp(fromSequenceExclusive, {
                maximum: Number.MAX_SAFE_INTEGER,
                minimum: 0,
              }),
            ),
          ).pipe(Effect.map((events) => Array.from(events))),
        );
      }

      case WS_METHODS.serverGetConfig:
        return {
          cwd: "/workspace",
          keybindingsConfigPath: "",
          keybindings: [],
          issues: [],
          providers: [],
          availableEditors: [],
        };

      case WS_METHODS.serverUpsertKeybinding:
        return { keybindings: [], issues: [] };
    }

    // Execution commands — resolve sandbox
    const active = await this.sandboxManager.resolveFromRequest(body);
    const { execution, runtime } = active;
    const execRun = <A>(effect: Effect.Effect<A, any, any>) =>
      runtime.runPromise(effect as any);

    switch (tag) {
      case ORCHESTRATION_WS_METHODS.getTurnDiff:
        return execRun(execution.checkpoint.getTurnDiff(stripRequestTag(body)));
      case ORCHESTRATION_WS_METHODS.getFullThreadDiff:
        return execRun(execution.checkpoint.getFullThreadDiff(stripRequestTag(body)));
      case WS_METHODS.projectsSearchEntries:
        return execRun(execution.fs.searchEntries(stripRequestTag(body)));
      case WS_METHODS.projectsWriteFile:
        return execRun(execution.fs.writeFile(stripRequestTag(body)));
      case WS_METHODS.shellOpenInEditor:
        return execRun(execution.shell.openInEditor(stripRequestTag(body)));
      case WS_METHODS.gitStatus:
        return execRun(execution.gitManager.status(stripRequestTag(body)));
      case WS_METHODS.gitPull:
        return execRun(execution.git.pullCurrentBranch(body.cwd));
      case WS_METHODS.gitRunStackedAction:
        return execRun(execution.gitManager.runStackedAction(stripRequestTag(body)));
      case WS_METHODS.gitResolvePullRequest:
        return execRun(execution.gitManager.resolvePullRequest(stripRequestTag(body)));
      case WS_METHODS.gitPreparePullRequestThread:
        return execRun(execution.gitManager.preparePullRequestThread(stripRequestTag(body)));
      case WS_METHODS.gitListBranches:
        return execRun(execution.git.listBranches(stripRequestTag(body)));
      case WS_METHODS.gitCreateWorktree:
        return execRun(execution.git.createWorktree(stripRequestTag(body)));
      case WS_METHODS.gitRemoveWorktree:
        return execRun(execution.git.removeWorktree(stripRequestTag(body)));
      case WS_METHODS.gitCreateBranch:
        return execRun(execution.git.createBranch(stripRequestTag(body)));
      case WS_METHODS.gitCheckout:
        return execRun(Effect.scoped(execution.git.checkoutBranch(stripRequestTag(body))));
      case WS_METHODS.gitInit:
        return execRun(execution.git.initRepo(stripRequestTag(body)));
      case WS_METHODS.terminalOpen:
        return execRun(execution.terminal.open(stripRequestTag(body)));
      case WS_METHODS.terminalWrite:
        return execRun(execution.terminal.write(stripRequestTag(body)));
      case WS_METHODS.terminalResize:
        return execRun(execution.terminal.resize(stripRequestTag(body)));
      case WS_METHODS.terminalClear:
        return execRun(execution.terminal.clear(stripRequestTag(body)));
      case WS_METHODS.terminalRestart:
        return execRun(execution.terminal.restart(stripRequestTag(body)));
      case WS_METHODS.terminalClose:
        return execRun(execution.terminal.close(stripRequestTag(body)));
      default:
        throw new Error(`Unknown method: ${tag}`);
    }
  }
}
