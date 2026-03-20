/**
 * ExecutionLocal - In-process execution adapter.
 *
 * Wraps existing Live service implementations behind the ExecutionService
 * interface by delegating directly in-process. This preserves current
 * behavior for local/desktop mode (no WebSocket hop).
 *
 * @module ExecutionLocal
 */
import { Effect, FileSystem, Layer, Path } from "effect";

import { ExecutionError, ExecutionService } from "../Services/ExecutionService.ts";
import type { ExecutionServiceShape } from "../Services/ExecutionService.ts";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { Open } from "../../open.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { searchWorkspaceEntries } from "../../workspaceEntries.ts";

function toPosixRelativePath(p: string): string {
  return p.split("\\").join("/");
}

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager;
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const openService = yield* Open;
  const textGeneration = yield* TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const shape: ExecutionServiceShape = {
    // ── Provider ──────────────────────────────────────────────────
    provider: {
      startSession: (threadId, input) => providerService.startSession(threadId, input),
      sendTurn: (input) => providerService.sendTurn(input),
      interruptTurn: (input) => providerService.interruptTurn(input),
      respondToRequest: (input) => providerService.respondToRequest(input),
      respondToUserInput: (input) => providerService.respondToUserInput(input),
      stopSession: (input) => providerService.stopSession(input),
      listSessions: () => providerService.listSessions(),
      getCapabilities: (provider) => providerService.getCapabilities(provider),
      rollbackConversation: (input) => providerService.rollbackConversation(input),
      streamEvents: providerService.streamEvents,
    },

    // ── Terminal ──────────────────────────────────────────────────
    terminal: {
      open: (input) => terminalManager.open(input),
      write: (input) => terminalManager.write(input),
      resize: (input) => terminalManager.resize(input),
      clear: (input) => terminalManager.clear(input),
      restart: (input) => terminalManager.restart(input),
      close: (input) => terminalManager.close(input),
      subscribe: (listener) => terminalManager.subscribe(listener),
      dispose: terminalManager.dispose,
    },

    // ── Git (low-level) ──────────────────────────────────────────
    git: {
      status: (input) => gitCore.status(input),
      pullCurrentBranch: (cwd) => gitCore.pullCurrentBranch(cwd),
      listBranches: (input) => gitCore.listBranches(input),
      createBranch: (input) => gitCore.createBranch(input),
      checkoutBranch: (input) => gitCore.checkoutBranch(input),
      createWorktree: (input) => gitCore.createWorktree(input),
      removeWorktree: (input) => gitCore.removeWorktree(input),
      initRepo: (input) => gitCore.initRepo(input),
      renameBranch: (input) => gitCore.renameBranch(input),
    },

    // ── Git (high-level) ─────────────────────────────────────────
    gitManager: {
      status: (input) => gitManager.status(input),
      runStackedAction: (input) => gitManager.runStackedAction(input),
      resolvePullRequest: (input) => gitManager.resolvePullRequest(input),
      preparePullRequestThread: (input) => gitManager.preparePullRequestThread(input),
    },

    // ── Filesystem ───────────────────────────────────────────────
    fs: {
      searchEntries: (input) =>
        Effect.tryPromise({
          try: () => searchWorkspaceEntries(input),
          catch: (cause) =>
            new ExecutionError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        }),

      writeFile: (input) =>
        Effect.gen(function* () {
          const normalizedInputPath = input.relativePath.trim();
          if (path.isAbsolute(normalizedInputPath)) {
            return yield* new ExecutionError({
              message: "Workspace file path must be relative to the project root.",
            });
          }

          const absolutePath = path.resolve(input.cwd, normalizedInputPath);
          const relativeToRoot = toPosixRelativePath(
            path.relative(input.cwd, absolutePath),
          );

          if (
            relativeToRoot.length === 0 ||
            relativeToRoot === "." ||
            relativeToRoot.startsWith("../") ||
            relativeToRoot === ".." ||
            path.isAbsolute(relativeToRoot)
          ) {
            return yield* new ExecutionError({
              message: "Workspace file path must stay within the project root.",
            });
          }

          yield* fileSystem
            .makeDirectory(path.dirname(absolutePath), { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ExecutionError({
                    message: `Failed to prepare workspace path: ${String(cause)}`,
                  }),
              ),
            );

          yield* fileSystem.writeFileString(absolutePath, input.contents).pipe(
            Effect.mapError(
              (cause) =>
                new ExecutionError({
                  message: `Failed to write workspace file: ${String(cause)}`,
                }),
            ),
          );

          return { relativePath: relativeToRoot };
        }),
    },

    // ── Checkpoint diffs ─────────────────────────────────────────
    checkpoint: {
      getTurnDiff: (input) => checkpointDiffQuery.getTurnDiff(input),
      getFullThreadDiff: (input) => checkpointDiffQuery.getFullThreadDiff(input),
    },

    // ── Shell / editor ───────────────────────────────────────────
    shell: {
      openInEditor: (input) => openService.openInEditor(input),
    },

    // ── Text generation ──────────────────────────────────────────
    textGeneration: {
      generateBranchName: (input) => textGeneration.generateBranchName(input),
    },
  };

  return shape;
});

export const ExecutionLocalLive = Layer.effect(ExecutionService, make);
