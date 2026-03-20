/**
 * Orchestration layer initialization for the UserDO.
 *
 * @module user-do/orchestration
 */
import { Effect, FileSystem, Layer, ManagedRuntime, Path, Ref } from "effect";

import { layer as doSqliteLayer } from "../do-sqlite-client.ts";

import { OrchestrationEngineLive } from "../../../server/src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../../server/src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../../server/src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../../server/src/persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../server/src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { RuntimeReceiptBusLive } from "../../../server/src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationEngineService } from "../../../server/src/orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../server/src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationReactor } from "../../../server/src/orchestration/Services/OrchestrationReactor.ts";
import { OrchestrationReactorLive } from "../../../server/src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../../../server/src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../../../server/src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { CheckpointReactorLive } from "../../../server/src/orchestration/Layers/CheckpointReactor.ts";
import { ProviderService } from "../../../server/src/provider/Services/ProviderService.ts";
import { CheckpointStore } from "../../../server/src/checkpointing/Services/CheckpointStore.ts";
import { ExecutionService } from "../../../server/src/execution/Services/ExecutionService.ts";
import { ServerConfig } from "../../../server/src/config.ts";
import { runMigrations } from "../../../server/src/persistence/Migrations.ts";

import { makeExecutionRoutingLayer } from "./execution-routing.ts";
import type { SandboxManager } from "./sandbox-manager.ts";
import type { DoSqlStorage } from "../do-sqlite-client.ts";

export interface OrchestrationState {
  runtime: ManagedRuntime.ManagedRuntime<any, any>;
  engine: OrchestrationEngineService["Service"];
  projectionQuery: ProjectionSnapshotQuery["Service"];
  reactor: OrchestrationReactor["Service"];
  sandboxManagerRef: Ref.Ref<SandboxManager | null>;
}

// ── ProviderService routed through ExecutionService.provider ─────────

const ProviderServiceRoutedLive = Layer.effect(
  ProviderService,
  Effect.gen(function* () {
    const execution = yield* ExecutionService;
    return {
      startSession: execution.provider.startSession,
      sendTurn: execution.provider.sendTurn,
      interruptTurn: execution.provider.interruptTurn,
      respondToRequest: execution.provider.respondToRequest,
      respondToUserInput: execution.provider.respondToUserInput,
      stopSession: execution.provider.stopSession,
      listSessions: execution.provider.listSessions,
      getCapabilities: execution.provider.getCapabilities,
      rollbackConversation: execution.provider.rollbackConversation,
      streamEvents: execution.provider.streamEvents,
    };
  }),
);

// ── No-op CheckpointStore (git not available in DO context) ──────────

const CheckpointStoreNoopLive = Layer.succeed(CheckpointStore, {
  isGitRepository: (_cwd) => Effect.succeed(false),
  captureCheckpoint: (_input) => Effect.void,
  hasCheckpointRef: (_input) => Effect.succeed(false),
  restoreCheckpoint: (_input) => Effect.succeed(false),
  diffCheckpoints: (_input) => Effect.succeed(""),
  deleteCheckpointRefs: (_input) => Effect.void,
});

// ── Init ─────────────────────────────────────────────────────────────

export async function initOrchestration(sql: DoSqlStorage): Promise<OrchestrationState> {
  const persistenceLayer = doSqliteLayer(sql);

  // Run migrations
  const migrationRuntime = ManagedRuntime.make(persistenceLayer);
  await migrationRuntime.runPromise(runMigrations);
  await migrationRuntime.dispose();

  // SandboxManager Ref — starts null, set after SandboxManager is created
  const sandboxManagerRef = Effect.runSync(Ref.make<SandboxManager | null>(null));

  // Build orchestration layer stack
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    RuntimeReceiptBusLive,
  );

  // Routing ExecutionService backed by the SandboxManager ref
  // Needs ProjectionSnapshotQuery to resolve threadId → project without deadlocking
  const executionLayer = makeExecutionRoutingLayer(sandboxManagerRef).pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
  );

  // Reactor dep layers: ProviderService (routed through ExecutionService) + no-op CheckpointStore
  const reactorDepsLayer = Layer.mergeAll(
    ProviderServiceRoutedLive,
    CheckpointStoreNoopLive,
  ).pipe(Layer.provide(executionLayer));

  // Reactor composite layer — wire sub-reactor layers and their dependencies
  const reactorLayer = OrchestrationReactorLive.pipe(
    Layer.provide(ProviderCommandReactorLive),
    Layer.provide(ProviderRuntimeIngestionLive),
    Layer.provide(CheckpointReactorLive),
    Layer.provide(reactorDepsLayer),
    Layer.provide(executionLayer),
  );

  const serverConfigLayer = Layer.succeed(ServerConfig, {
    mode: "web" as const,
    port: 0,
    host: undefined,
    cwd: "/workspace",
    keybindingsConfigPath: "",
    stateDir: "/tmp/t3code-state",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    executionMode: "remote" as const,
    executionUrl: undefined,
  });

  const platformLayer = Layer.mergeAll(
    Path.layer,
    FileSystem.layerNoop({}),
  );

  // Build the full layer: reactor on top, then orchestration services, then infra
  const fullLayer = reactorLayer.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(executionLayer),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(platformLayer),
  );

  const runtime = ManagedRuntime.make(fullLayer);

  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const projectionQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor));

  return { runtime, engine, projectionQuery, reactor, sandboxManagerRef };
}
