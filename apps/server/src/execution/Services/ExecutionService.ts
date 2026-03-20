/**
 * ExecutionService - Effect service contract for the execution boundary.
 *
 * Encapsulates all I/O-dependent operations (provider sessions, terminals,
 * git, filesystem, checkpoints, editor launch, text generation) behind a
 * single service tag. Orchestration code calls through this interface
 * regardless of whether execution is local (in-process) or remote (WebSocket).
 *
 * @module ExecutionService
 */
import type {
  // Provider
  ProviderInterruptTurnInput,
  ProviderKind,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
  ThreadId,
  // Terminal
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
  // Git
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
  // Filesystem
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
  // Checkpoint diffs
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  // Editor
  OpenInEditorInput,
} from "@t3tools/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { ProviderAdapterCapabilities } from "../../provider/Services/ProviderAdapter.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { TerminalError } from "../../terminal/Services/Manager.ts";
import type { GitCommandError } from "../../git/Errors.ts";
import type { GitManagerServiceError } from "../../git/Errors.ts";
import type { CheckpointServiceError } from "../../checkpointing/Errors.ts";
import type { OpenError } from "../../open.ts";
import type { TextGenerationError } from "../../git/Errors.ts";
import type {
  GitRenameBranchInput,
  GitRenameBranchResult,
} from "../../git/Services/GitCore.ts";
import type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
} from "../../git/Services/TextGeneration.ts";

// ── Execution Service Error ──────────────────────────────────────────

export class ExecutionError extends Schema.TaggedErrorClass<ExecutionError>()("ExecutionError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

// ── Execution Service Shape ──────────────────────────────────────────

export interface ExecutionServiceShape {
  // ── Provider operations ──────────────────────────────────────────
  readonly provider: {
    readonly startSession: (
      threadId: ThreadId,
      input: ProviderSessionStartInput,
    ) => Effect.Effect<ProviderSession, ProviderServiceError>;

    readonly sendTurn: (
      input: ProviderSendTurnInput,
    ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

    readonly interruptTurn: (
      input: ProviderInterruptTurnInput,
    ) => Effect.Effect<void, ProviderServiceError>;

    readonly respondToRequest: (
      input: ProviderRespondToRequestInput,
    ) => Effect.Effect<void, ProviderServiceError>;

    readonly respondToUserInput: (
      input: ProviderRespondToUserInputInput,
    ) => Effect.Effect<void, ProviderServiceError>;

    readonly stopSession: (
      input: ProviderStopSessionInput,
    ) => Effect.Effect<void, ProviderServiceError>;

    readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

    readonly getCapabilities: (
      provider: ProviderKind,
    ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

    readonly rollbackConversation: (input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }) => Effect.Effect<void, ProviderServiceError>;

    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  };

  // ── Terminal operations ──────────────────────────────────────────
  readonly terminal: {
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    readonly resize: (input: TerminalResizeInput) => Effect.Effect<void, TerminalError>;

    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    readonly restart: (
      input: TerminalRestartInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    readonly subscribe: (
      listener: (event: TerminalEvent) => void,
    ) => Effect.Effect<() => void>;

    readonly dispose: Effect.Effect<void>;
  };

  // ── Git operations (low-level) ───────────────────────────────────
  readonly git: {
    readonly status: (
      input: GitStatusInput,
    ) => Effect.Effect<GitStatusResult, GitCommandError>;

    readonly pullCurrentBranch: (
      cwd: string,
    ) => Effect.Effect<GitPullResult, GitCommandError>;

    readonly listBranches: (
      input: GitListBranchesInput,
    ) => Effect.Effect<GitListBranchesResult, GitCommandError>;

    readonly createBranch: (
      input: GitCreateBranchInput,
    ) => Effect.Effect<void, GitCommandError>;

    readonly checkoutBranch: (
      input: GitCheckoutInput,
    ) => Effect.Effect<void, GitCommandError, Scope.Scope>;

    readonly createWorktree: (
      input: GitCreateWorktreeInput,
    ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;

    readonly removeWorktree: (
      input: GitRemoveWorktreeInput,
    ) => Effect.Effect<void, GitCommandError>;

    readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;

    readonly renameBranch: (
      input: GitRenameBranchInput,
    ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
  };

  // ── Git operations (high-level) ──────────────────────────────────
  readonly gitManager: {
    readonly status: (
      input: GitStatusInput,
    ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;

    readonly runStackedAction: (
      input: GitRunStackedActionInput,
    ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;

    readonly resolvePullRequest: (
      input: GitPullRequestRefInput,
    ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;

    readonly preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
  };

  // ── Filesystem operations ────────────────────────────────────────
  readonly fs: {
    readonly searchEntries: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, ExecutionError>;

    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<ProjectWriteFileResult, ExecutionError>;
  };

  // ── Checkpoint diff operations ───────────────────────────────────
  readonly checkpoint: {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResult, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  };

  // ── Shell / editor operations (host-only) ────────────────────────
  readonly shell: {
    readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
  };

  // ── Text generation ──────────────────────────────────────────────
  readonly textGeneration: {
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;
  };
}

/**
 * ExecutionService - Service tag for the execution boundary.
 */
export class ExecutionService extends ServiceMap.Service<
  ExecutionService,
  ExecutionServiceShape
>()("t3/execution/Services/ExecutionService") {}
