/**
 * ExecutionClient - WebSocket client for remote execution.
 *
 * Connects to an ExecutionAgent and implements ExecutionService by
 * serializing requests over WebSocket and deserializing responses.
 * Push events from the agent are dispatched to subscribers.
 *
 * @module ExecutionClient
 */
import { Effect, Layer, Schema, Stream, PubSub, Queue } from "effect";
import WebSocket from "ws";
import {
  EXECUTION_METHODS,
  EXECUTION_PUSH_CHANNELS,
  type ExecutionRpcRequest,
  type ExecutionRpcResponse,
  type ExecutionPushEvent,
} from "@t3tools/contracts";
import type { ProviderRuntimeEvent, TerminalEvent } from "@t3tools/contracts";

import { ExecutionService, ExecutionError } from "../Services/ExecutionService.ts";
import type { ExecutionServiceShape } from "../Services/ExecutionService.ts";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function makeExecutionClient(url: string) {
  return Effect.gen(function* () {
    let ws: WebSocket | null = null;
    let requestId = 0;
    const pending = new Map<string, PendingRequest>();
    const providerEventListeners = new Set<(event: ProviderRuntimeEvent) => void>();
    const terminalEventListeners = new Set<(event: TerminalEvent) => void>();

    function connect(): Promise<void> {
      return new Promise((resolve, reject) => {
        ws = new WebSocket(url);
        ws.on("open", () => resolve());
        ws.on("error", (err) => reject(err));
        ws.on("message", (raw) => {
          const data = JSON.parse(raw.toString());

          // Handle push events
          if (data.type === "push") {
            const push = data as ExecutionPushEvent;
            if (push.channel === EXECUTION_PUSH_CHANNELS.providerEvent) {
              for (const listener of providerEventListeners) {
                listener(push.data as ProviderRuntimeEvent);
              }
            } else if (push.channel === EXECUTION_PUSH_CHANNELS.terminalEvent) {
              for (const listener of terminalEventListeners) {
                listener(push.data as TerminalEvent);
              }
            }
            return;
          }

          // Handle RPC responses
          const response = data as ExecutionRpcResponse;
          const req = pending.get(response.id);
          if (req) {
            pending.delete(response.id);
            if (response.error) {
              req.reject(new Error(response.error.message));
            } else {
              req.resolve(response.result);
            }
          }
        });
        ws.on("close", () => {
          for (const [, req] of pending) {
            req.reject(new Error("WebSocket connection closed"));
          }
          pending.clear();
        });
      });
    }

    function rpc(method: string, params: unknown): Effect.Effect<unknown, ExecutionError> {
      return Effect.tryPromise({
        try: () => {
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error("WebSocket not connected"));
          }
          const id = String(++requestId);
          return new Promise<unknown>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            const request: ExecutionRpcRequest = {
              id: id as any,
              method: method as any,
              params,
            };
            ws!.send(JSON.stringify(request));
          });
        },
        catch: (err) =>
          new ExecutionError({
            message: `Execution RPC failed: ${err instanceof Error ? err.message : String(err)}`,
          }),
      });
    }

    yield* Effect.tryPromise({
      try: () => connect(),
      catch: (err) =>
        new ExecutionError({
          message: `Failed to connect to execution agent at ${url}: ${err instanceof Error ? err.message : String(err)}`,
        }),
    });

    const providerEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    providerEventListeners.add((event) => {
      Effect.runSync(Queue.offer(providerEventQueue, event));
    });

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
        streamEvents: Stream.fromQueue(providerEventQueue),
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
        openInEditor: (input) => rpc(EXECUTION_METHODS.shellOpenInEditor, input) as any,
      },

      textGeneration: {
        generateBranchName: (input) =>
          rpc(EXECUTION_METHODS.textGenerationGenerateBranchName, input) as any,
      },
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ws?.close();
        providerEventListeners.clear();
        terminalEventListeners.clear();
      }),
    );

    return shape;
  });
}

export const makeExecutionClientLive = (url: string) =>
  Layer.effect(ExecutionService, makeExecutionClient(url));
