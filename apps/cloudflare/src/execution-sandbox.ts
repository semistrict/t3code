/**
 * ExecutionSandbox - ExecutionService adapter for Cloudflare Containers.
 *
 * Uses HTTP to communicate with the ExecutionAgent running inside the container:
 *   POST /rpc     — JSON-RPC request/response
 *   GET  /events  — SSE stream of push events (provider + terminal)
 *
 * The sandbox SDK's fetch-to-port support allows the DO to make HTTP requests
 * to the container without needing a WebSocket connection.
 *
 * @module ExecutionSandbox
 */
import { Effect, Layer, Stream, Queue, PubSub } from "effect";
import {
  EXECUTION_METHODS,
  EXECUTION_PUSH_CHANNELS,
  type ExecutionRpcRequest,
  type ExecutionRpcResponse,
  type ExecutionPushEvent,
  type ProviderRuntimeEvent,
  type TerminalEvent,
} from "@t3tools/contracts";

import type { ExecutionServiceShape } from "../../server/src/execution/Services/ExecutionService.ts";
import {
  ExecutionService,
  ExecutionError,
} from "../../server/src/execution/Services/ExecutionService.ts";

/**
 * Fetcher interface for making HTTP requests to a container port.
 * Compatible with the Sandbox SDK's fetch method.
 */
export interface ContainerFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Create an ExecutionService backed by HTTP fetch to a container.
 *
 * `fetcher` makes HTTP requests to the container's ExecutionAgent port.
 * `baseUrl` is the base URL for the container (e.g. "http://container:9999").
 */
function makeExecutionSandbox(fetcher: ContainerFetcher, baseUrl: string) {
  return Effect.gen(function* () {
    let requestId = 0;
    const providerEventPubSub = yield* Effect.sync(() =>
      Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>()),
    );
    const terminalEventListeners = new Set<(event: TerminalEvent) => void>();

    // ── RPC via HTTP POST ─────────────────────────────────────────
    function rpc(method: string, params: unknown): Effect.Effect<unknown, ExecutionError> {
      return Effect.tryPromise({
        try: async () => {
          const id = String(++requestId);
          const request: ExecutionRpcRequest = {
            id: id as any,
            method: method as any,
            params,
          };
          const response = await fetcher.fetch(`${baseUrl}/rpc`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(request),
          });
          const data: ExecutionRpcResponse = await response.json();
          if (data.error) {
            throw new Error(data.error.message);
          }
          return data.result;
        },
        catch: (err) =>
          new ExecutionError({
            message: `Execution RPC failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      });
    }

    // ── SSE event stream ──────────────────────────────────────────
    // Connect to /events SSE endpoint and dispatch events
    function connectEventStream() {
      (async () => {
        try {
          const response = await fetcher.fetch(`${baseUrl}/events`);
          if (!response.body) return;

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const event: ExecutionPushEvent = JSON.parse(line.slice(6));
                if (event.channel === EXECUTION_PUSH_CHANNELS.providerEvent) {
                  Effect.runSync(PubSub.publish(providerEventPubSub, event.data as ProviderRuntimeEvent));
                } else if (event.channel === EXECUTION_PUSH_CHANNELS.terminalEvent) {
                  for (const listener of terminalEventListeners) {
                    listener(event.data as TerminalEvent);
                  }
                }
              } catch {}
            }
          }
        } catch (err) {
          console.error("[ExecutionSandbox] SSE event stream error:", err);
        }
      })();
    }

    connectEventStream();

    const shape: ExecutionServiceShape = {
      provider: {
        startSession: (threadId, input) =>
          rpc(EXECUTION_METHODS.providerStartSession, { threadId, input }) as any,
        sendTurn: (input) => rpc(EXECUTION_METHODS.providerSendTurn, input) as any,
        interruptTurn: (input) => rpc(EXECUTION_METHODS.providerInterruptTurn, input) as any,
        respondToRequest: (input) =>
          rpc(EXECUTION_METHODS.providerRespondToRequest, input) as any,
        respondToUserInput: (input) =>
          rpc(EXECUTION_METHODS.providerRespondToUserInput, input) as any,
        stopSession: (input) => rpc(EXECUTION_METHODS.providerStopSession, input) as any,
        listSessions: () => rpc(EXECUTION_METHODS.providerListSessions, {}) as any,
        getCapabilities: (provider) =>
          rpc(EXECUTION_METHODS.providerGetCapabilities, { provider }) as any,
        rollbackConversation: (input) =>
          rpc(EXECUTION_METHODS.providerRollbackConversation, input) as any,
        streamEvents: Stream.fromPubSub(providerEventPubSub),
      },

      terminal: {
        open: (input) => rpc(EXECUTION_METHODS.terminalOpen, input) as any,
        write: (input) => rpc(EXECUTION_METHODS.terminalWrite, input) as any,
        resize: (input) => rpc(EXECUTION_METHODS.terminalResize, input) as any,
        clear: (input) => rpc(EXECUTION_METHODS.terminalClear, input) as any,
        restart: (input) => rpc(EXECUTION_METHODS.terminalRestart, input) as any,
        close: (input) => rpc(EXECUTION_METHODS.terminalClose, input) as any,
        subscribe: (listener) => {
          terminalEventListeners.add(listener);
          return Effect.succeed(() => {
            terminalEventListeners.delete(listener);
          });
        },
        dispose: Effect.sync(() => {
          terminalEventListeners.clear();
        }),
      },

      git: {
        status: (input) => rpc(EXECUTION_METHODS.gitStatus, input) as any,
        pullCurrentBranch: (cwd) => rpc(EXECUTION_METHODS.gitPull, { cwd }) as any,
        listBranches: (input) => rpc(EXECUTION_METHODS.gitListBranches, input) as any,
        createBranch: (input) => rpc(EXECUTION_METHODS.gitCreateBranch, input) as any,
        checkoutBranch: (input) => rpc(EXECUTION_METHODS.gitCheckout, input) as any,
        createWorktree: (input) => rpc(EXECUTION_METHODS.gitCreateWorktree, input) as any,
        removeWorktree: (input) => rpc(EXECUTION_METHODS.gitRemoveWorktree, input) as any,
        initRepo: (input) => rpc(EXECUTION_METHODS.gitInit, input) as any,
        renameBranch: (input) => rpc(EXECUTION_METHODS.gitRenameBranch, input) as any,
      },

      gitManager: {
        status: (input) => rpc(EXECUTION_METHODS.gitManagerStatus, input) as any,
        runStackedAction: (input) => rpc(EXECUTION_METHODS.gitRunStackedAction, input) as any,
        resolvePullRequest: (input) =>
          rpc(EXECUTION_METHODS.gitResolvePullRequest, input) as any,
        preparePullRequestThread: (input) =>
          rpc(EXECUTION_METHODS.gitPreparePullRequestThread, input) as any,
      },

      fs: {
        searchEntries: (input) => rpc(EXECUTION_METHODS.fsSearchEntries, input) as any,
        writeFile: (input) => rpc(EXECUTION_METHODS.fsWriteFile, input) as any,
      },

      checkpoint: {
        getTurnDiff: (input) => rpc(EXECUTION_METHODS.checkpointGetTurnDiff, input) as any,
        getFullThreadDiff: (input) =>
          rpc(EXECUTION_METHODS.checkpointGetFullThreadDiff, input) as any,
      },

      shell: {
        openInEditor: (_input) =>
          Effect.succeed(undefined as void), // No-op in container context
      },

      textGeneration: {
        generateBranchName: (input) =>
          rpc(EXECUTION_METHODS.textGenerationGenerateBranchName, input) as any,
      },
    };

    return shape;
  });
}

export const makeExecutionSandboxLive = (fetcher: ContainerFetcher, baseUrl: string) =>
  Layer.effect(ExecutionService, makeExecutionSandbox(fetcher, baseUrl));
