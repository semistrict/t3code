import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ServerConfig } from "./config";
import { OrchestrationCommandReceiptRepositoryLive } from "./persistence/Layers/OrchestrationCommandReceipts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime";
import { OrchestrationEngineLive } from "./orchestration/Layers/OrchestrationEngine";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { OrchestrationProjectionPipelineLive } from "./orchestration/Layers/ProjectionPipeline";
import { OrchestrationProjectionSnapshotQueryLive } from "./orchestration/Layers/ProjectionSnapshotQuery";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ProviderUnsupportedError } from "./provider/Errors";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory";
import { ProviderService } from "./provider/Services/ProviderService";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger";

import { TerminalManagerLive } from "./terminal/Layers/Manager";
import { KeybindingsLive } from "./keybindings";
import { GitManagerLive } from "./git/Layers/GitManager";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitHubCliLive } from "./git/Layers/GitHubCli";
import { CodexTextGenerationLive } from "./git/Layers/CodexTextGeneration";
import { GitServiceLive } from "./git/Layers/GitService";
import { BunPtyAdapterLive } from "./terminal/Layers/BunPTY";
import { NodePtyAdapterLive } from "./terminal/Layers/NodePTY";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService";
import { OpenLive } from "./open";

import { ExecutionLocalLive } from "./execution/Layers/ExecutionLocal.ts";

export function makeServerProviderLayer(): Layer.Layer<
  ProviderService,
  ProviderUnsupportedError,
  SqlClient.SqlClient | ServerConfig | FileSystem.FileSystem | AnalyticsService
> {
  return Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig;
    const providerLogsDir = path.join(stateDir, "logs", "provider");
    const providerEventLogPath = path.join(providerLogsDir, "events.log");
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(Layer.provide(adapterRegistryLayer), Layer.provide(providerSessionDirectoryLayer));
  }).pipe(Layer.unwrap);
}

/**
 * Default execution-side service layers.
 *
 * These provide TerminalManager, GitCore, GitManager, CheckpointDiffQuery,
 * Open, and TextGeneration. Tests can override individual services by
 * merging Layer.succeed overrides BEFORE providing ExecutionLocalLive.
 */
export function makeExecutionServicesLayer() {
  const gitCoreLayer = GitCoreLive.pipe(Layer.provideMerge(GitServiceLive));
  const textGenerationLayer = CodexTextGenerationLive;
  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(CheckpointStoreLive),
  );
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

  return Layer.mergeAll(
    terminalLayer,
    gitCoreLayer,
    gitManagerLayer,
    checkpointDiffQueryLayer,
    OpenLive,
    textGenerationLayer,
  );
}

export function makeServerRuntimeServicesLayer() {
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    CheckpointStoreLive,
    RuntimeReceiptBusLive,
  );

  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );

  // ProviderCommandReactor needs ExecutionService from the context
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );

  // Output: orchestration services + keybindings.
  // Requirements: ExecutionService (+ its deps) from the caller.
  // The caller provides ExecutionLocalLive on top of execution service layers.
  return Layer.mergeAll(
    orchestrationReactorLayer,
    KeybindingsLive,
  ).pipe(Layer.provideMerge(NodeServices.layer));
}

/**
 * Convenience: full runtime layer for production use.
 * Composes orchestration + execution local + default execution services.
 */
export function makeFullServerRuntimeLayer() {
  return makeServerRuntimeServicesLayer().pipe(
    Layer.provideMerge(ExecutionLocalLive),
    Layer.provideMerge(makeExecutionServicesLayer()),
  );
}
