/**
 * ExecutionRoutingLive - Routes ExecutionService calls to the correct sandbox.
 *
 * Each method resolves the target sandbox from its arguments (threadId or cwd),
 * then delegates to that sandbox's ExecutionService.
 *
 * Takes a Ref<SandboxManager | null> to break the circular dependency:
 *   SandboxManager → OrchestrationState → ExecutionService → SandboxManager
 * The Ref starts null and is set after SandboxManager is created.
 *
 * @module user-do/execution-routing
 */
import { Effect, Layer, Ref, Stream } from "effect";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

import type { ExecutionServiceShape } from "../../../server/src/execution/Services/ExecutionService.ts";
import {
  ExecutionService,
  ExecutionError,
} from "../../../server/src/execution/Services/ExecutionService.ts";
import { ProjectionSnapshotQuery } from "../../../server/src/orchestration/Services/ProjectionSnapshotQuery.ts";

import type { SandboxManager } from "./sandbox-manager.ts";

// ── Helpers ──────────────────────────────────────────────────────────

function requireManager(ref: Ref.Ref<SandboxManager | null>) {
  return Ref.get(ref).pipe(
    Effect.flatMap((manager) =>
      manager === null
        ? Effect.fail(
            new ExecutionError({
              message: "SandboxManager not initialized yet",
            }),
          )
        : Effect.succeed(manager),
    ),
  );
}

function withSandboxForThread<A, E, R>(
  ref: Ref.Ref<SandboxManager | null>,
  snapshotQuery: ProjectionSnapshotQuery["Service"],
  threadId: string,
  fn: (exec: ExecutionServiceShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ExecutionError, R> {
  return Effect.flatMap(requireManager(ref), (manager) =>
    // Get snapshot via Effect (not nested runPromise) to avoid deadlock
    snapshotQuery.getSnapshot().pipe(
      Effect.mapError(
        (err) =>
          new ExecutionError({
            message: `Failed to get snapshot: ${err instanceof Error ? err.message : String(err)}`,
          }),
      ),
      Effect.flatMap((snapshot) =>
        Effect.tryPromise({
          try: () => manager.resolveFromThreadIdWithSnapshot(threadId, snapshot),
          catch: (err) =>
            new ExecutionError({
              message: `Failed to resolve sandbox for thread ${threadId}: ${err instanceof Error ? err.message : String(err)}`,
            }),
        }),
      ),
      Effect.flatMap((active) => fn(active.execution)),
    ),
  );
}

function withSandboxForCwd<A, E, R>(
  ref: Ref.Ref<SandboxManager | null>,
  cwd: string,
  fn: (exec: ExecutionServiceShape) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ExecutionError, R> {
  return Effect.flatMap(requireManager(ref), (manager) =>
    Effect.tryPromise({
      try: () => manager.resolveFromRequest({ cwd }),
      catch: (err) =>
        new ExecutionError({
          message: `Failed to resolve sandbox for cwd ${cwd}: ${err instanceof Error ? err.message : String(err)}`,
        }),
    }).pipe(Effect.flatMap((active) => fn(active.execution))),
  );
}

// ── Layer factory ────────────────────────────────────────────────────

export function makeExecutionRoutingLayer(ref: Ref.Ref<SandboxManager | null>) {
  return Layer.effect(
    ExecutionService,
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      return {
      // ── Provider ──────────────────────────────────────────────────
      provider: {
        startSession: (threadId, input) =>
          withSandboxForThread(ref, snapshotQuery, threadId, (e) =>
            e.provider.startSession(threadId, input),
          ) as any,
        sendTurn: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) => e.provider.sendTurn(input)) as any,
        interruptTurn: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.provider.interruptTurn(input),
          ) as any,
        respondToRequest: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.provider.respondToRequest(input),
          ) as any,
        respondToUserInput: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.provider.respondToUserInput(input),
          ) as any,
        stopSession: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.provider.stopSession(input),
          ) as any,
        listSessions: () =>
          Effect.flatMap(requireManager(ref), (manager) =>
            Effect.tryPromise({
              try: () => manager.listActiveSandboxExecutions(),
              catch: (err) =>
                new ExecutionError({
                  message: `Failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
                }),
            }).pipe(
              Effect.flatMap((executions) =>
                Effect.all(executions.map((e) => e.provider.listSessions())).pipe(
                  Effect.map((arrays) => arrays.flat()),
                ),
              ),
            ),
          ) as any,
        getCapabilities: (provider) =>
          Effect.flatMap(requireManager(ref), (manager) =>
            Effect.tryPromise({
              try: () => manager.getAnyActiveSandbox(),
              catch: (err) =>
                new ExecutionError({
                  message: `No active sandbox for getCapabilities: ${err instanceof Error ? err.message : String(err)}`,
                }),
            }).pipe(
              Effect.flatMap((active) =>
                active.execution.provider.getCapabilities(provider),
              ),
            ),
          ) as any,
        rollbackConversation: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.provider.rollbackConversation(input),
          ) as any,
        // Merged stream from all active sandboxes via PubSub
        streamEvents: Stream.unwrap(
          Effect.map(requireManager(ref), (manager) =>
            manager.mergedProviderEventStream(),
          ),
        ) as Stream.Stream<ProviderRuntimeEvent>,
      },

      // ── Terminal (all inputs have threadId) ─────────────────────
      terminal: {
        open: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) => e.terminal.open(input)) as any,
        write: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.terminal.write(input),
          ) as any,
        resize: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.terminal.resize(input),
          ) as any,
        clear: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.terminal.clear(input),
          ) as any,
        restart: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.terminal.restart(input),
          ) as any,
        close: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.terminal.close(input),
          ) as any,
        subscribe: (_listener) => Effect.succeed(() => {}),
        dispose: Effect.void,
      },

      // ── Git (low-level) ──────────────────────────────────────────
      git: {
        status: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.git.status(input)) as any,
        pullCurrentBranch: (cwd) =>
          withSandboxForCwd(ref, cwd, (e) => e.git.pullCurrentBranch(cwd)) as any,
        listBranches: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.git.listBranches(input)) as any,
        createBranch: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.git.createBranch(input)) as any,
        checkoutBranch: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.git.checkoutBranch(input)) as any,
        createWorktree: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) =>
            e.git.createWorktree(input),
          ) as any,
        removeWorktree: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) =>
            e.git.removeWorktree(input),
          ) as any,
        initRepo: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.git.initRepo(input)) as any,
        renameBranch: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.git.renameBranch(input)) as any,
      },

      // ── Git (high-level) ─────────────────────────────────────────
      gitManager: {
        status: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.gitManager.status(input)) as any,
        runStackedAction: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) =>
            e.gitManager.runStackedAction(input),
          ) as any,
        resolvePullRequest: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) =>
            e.gitManager.resolvePullRequest(input),
          ) as any,
        preparePullRequestThread: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) =>
            e.gitManager.preparePullRequestThread(input),
          ) as any,
      },

      // ── Filesystem ───────────────────────────────────────────────
      fs: {
        searchEntries: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.fs.searchEntries(input)) as any,
        writeFile: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) => e.fs.writeFile(input)) as any,
      },

      // ── Checkpoint diffs (routed by threadId) ────────────────────
      checkpoint: {
        getTurnDiff: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.checkpoint.getTurnDiff(input),
          ) as any,
        getFullThreadDiff: (input) =>
          withSandboxForThread(ref, snapshotQuery, input.threadId, (e) =>
            e.checkpoint.getFullThreadDiff(input),
          ) as any,
      },

      // ── Shell (no-op in container context) ───────────────────────
      shell: {
        openInEditor: (_input) => Effect.succeed(undefined as void),
      },

      // ── Text generation ──────────────────────────────────────────
      textGeneration: {
        generateBranchName: (input) =>
          withSandboxForCwd(ref, input.cwd, (e) =>
            e.textGeneration.generateBranchName(input),
          ) as any,
      },
    } as ExecutionServiceShape;
    }),
  );
}
