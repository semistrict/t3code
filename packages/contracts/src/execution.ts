/**
 * Execution Protocol - RPC contract between orchestration and execution layers.
 *
 * Defines typed request/response messages for every operation the execution
 * side handles (provider sessions, terminals, git, filesystem, checkpoints)
 * and push events flowing from execution back to orchestration.
 *
 * @module Execution
 */
import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";

import type { ThreadId } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";
import type { ProviderRuntimeEvent } from "./providerRuntime";

import type {
  // Provider types
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderTurnStartResult,
} from "./provider";

import type {
  // Terminal types
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";

import type {
  // Git types
  GitCheckoutInput,
  GitCreateBranchInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";

import type {
  // Filesystem types
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";

import type {
  // Checkpoint diff types
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
} from "./orchestration";

import type {
  // Editor types
  OpenInEditorInput,
} from "./editor";

// ── Execution RPC Method Names ───────────────────────────────────────

export const EXECUTION_METHODS = {
  // Provider operations
  providerStartSession: "execution.provider.startSession",
  providerSendTurn: "execution.provider.sendTurn",
  providerInterruptTurn: "execution.provider.interruptTurn",
  providerRespondToRequest: "execution.provider.respondToRequest",
  providerRespondToUserInput: "execution.provider.respondToUserInput",
  providerStopSession: "execution.provider.stopSession",
  providerListSessions: "execution.provider.listSessions",
  providerGetCapabilities: "execution.provider.getCapabilities",
  providerRollbackConversation: "execution.provider.rollbackConversation",

  // Terminal operations
  terminalOpen: "execution.terminal.open",
  terminalWrite: "execution.terminal.write",
  terminalResize: "execution.terminal.resize",
  terminalClear: "execution.terminal.clear",
  terminalRestart: "execution.terminal.restart",
  terminalClose: "execution.terminal.close",

  // Git operations (low-level - GitCore)
  gitStatus: "execution.git.status",
  gitPull: "execution.git.pull",
  gitListBranches: "execution.git.listBranches",
  gitCreateBranch: "execution.git.createBranch",
  gitCheckout: "execution.git.checkout",
  gitCreateWorktree: "execution.git.createWorktree",
  gitRemoveWorktree: "execution.git.removeWorktree",
  gitInit: "execution.git.init",
  gitRenameBranch: "execution.git.renameBranch",

  // Git operations (high-level - GitManager)
  gitManagerStatus: "execution.gitManager.status",
  gitRunStackedAction: "execution.gitManager.runStackedAction",
  gitResolvePullRequest: "execution.gitManager.resolvePullRequest",
  gitPreparePullRequestThread: "execution.gitManager.preparePullRequestThread",

  // Filesystem operations
  fsSearchEntries: "execution.fs.searchEntries",
  fsWriteFile: "execution.fs.writeFile",

  // Checkpoint diff operations
  checkpointGetTurnDiff: "execution.checkpoint.getTurnDiff",
  checkpointGetFullThreadDiff: "execution.checkpoint.getFullThreadDiff",

  // Editor operations (host-only, no-op in container)
  shellOpenInEditor: "execution.shell.openInEditor",

  // Text generation
  textGenerationGenerateBranchName: "execution.textGeneration.generateBranchName",
} as const;

// ── Push Event Channels (execution → orchestration) ──────────────────

export const EXECUTION_PUSH_CHANNELS = {
  providerEvent: "execution.push.providerEvent",
  terminalEvent: "execution.push.terminalEvent",
} as const;

// ── Execution RPC Request Envelope ───────────────────────────────────

export const ExecutionRpcRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  method: TrimmedNonEmptyString,
  params: Schema.Unknown,
});
export type ExecutionRpcRequest = typeof ExecutionRpcRequest.Type;

// ── Execution RPC Response Envelope ──────────────────────────────────

export const ExecutionRpcResponse = Schema.Struct({
  id: TrimmedNonEmptyString,
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optional(Schema.String),
    }),
  ),
});
export type ExecutionRpcResponse = typeof ExecutionRpcResponse.Type;

// ── Execution Push Event Envelope ────────────────────────────────────

export const ExecutionPushEvent = Schema.Struct({
  type: Schema.Literal("push"),
  channel: TrimmedNonEmptyString,
  data: Schema.Unknown,
});
export type ExecutionPushEvent = typeof ExecutionPushEvent.Type;

// ── Execution Service Shape (TypeScript interface) ───────────────────
//
// This describes the full set of operations the execution side exposes.
// Both ExecutionLocal (in-process) and ExecutionClient (WebSocket) implement this.

export interface ExecutionProviderShape {
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Promise<ProviderSession>;

  readonly sendTurn: (input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>;

  readonly interruptTurn: (input: ProviderInterruptTurnInput) => Promise<void>;

  readonly respondToRequest: (input: ProviderRespondToRequestInput) => Promise<void>;

  readonly respondToUserInput: (input: ProviderRespondToUserInputInput) => Promise<void>;

  readonly stopSession: (input: ProviderStopSessionInput) => Promise<void>;

  readonly listSessions: () => Promise<ReadonlyArray<ProviderSession>>;

  readonly getCapabilities: (
    provider: ProviderKind,
  ) => Promise<{ readonly sessionModelSwitch: "in-session" | "restart-session" | "unsupported" }>;

  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Promise<void>;
}

export interface ExecutionTerminalShape {
  readonly open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
  readonly write: (input: TerminalWriteInput) => Promise<void>;
  readonly resize: (input: TerminalResizeInput) => Promise<void>;
  readonly clear: (input: TerminalClearInput) => Promise<void>;
  readonly restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
  readonly close: (input: TerminalCloseInput) => Promise<void>;
}

export interface ExecutionGitShape {
  // Low-level (GitCore)
  readonly status: (input: GitStatusInput) => Promise<GitStatusResult>;
  readonly pull: (input: GitPullInput) => Promise<GitPullResult>;
  readonly listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
  readonly createBranch: (input: GitCreateBranchInput) => Promise<void>;
  readonly checkout: (input: GitCheckoutInput) => Promise<void>;
  readonly createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
  readonly init: (input: GitInitInput) => Promise<void>;
  readonly renameBranch: (input: {
    cwd: string;
    oldBranch: string;
    newBranch: string;
  }) => Promise<{ branch: string }>;

  // High-level (GitManager)
  readonly managerStatus: (input: GitStatusInput) => Promise<GitStatusResult>;
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
  ) => Promise<GitRunStackedActionResult>;
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Promise<GitResolvePullRequestResult>;
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Promise<GitPreparePullRequestThreadResult>;
}

export interface ExecutionFilesystemShape {
  readonly searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
  readonly writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
}

export interface ExecutionCheckpointShape {
  readonly getTurnDiff: (
    input: OrchestrationGetTurnDiffInput,
  ) => Promise<OrchestrationGetTurnDiffResult>;
  readonly getFullThreadDiff: (
    input: OrchestrationGetFullThreadDiffInput,
  ) => Promise<OrchestrationGetFullThreadDiffResult>;
}

export interface ExecutionShellShape {
  readonly openInEditor: (input: OpenInEditorInput) => Promise<void>;
}

export interface ExecutionTextGenerationShape {
  readonly generateBranchName: (input: {
    cwd: string;
    message: string;
    attachments?: ReadonlyArray<unknown>;
    model?: string;
  }) => Promise<{ branch: string }>;
}

export interface ExecutionPushSubscriptions {
  readonly onProviderEvent: (listener: (event: ProviderRuntimeEvent) => void) => () => void;
  readonly onTerminalEvent: (listener: (event: TerminalEvent) => void) => () => void;
}
