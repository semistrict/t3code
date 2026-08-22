import type {
  DagoSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import { listDagoAcpModels, type DagoAcpModelList } from "../acp/DagoAcpSupport.ts";

const DAGO_PRESENTATION = {
  displayName: "dago",
  badgeLabel: "Workflows",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODEL_PROBE_TIMEOUT_MS = 10_000;

function dagoModelsFromSettings(customModels: ReadonlyArray<string> | undefined) {
  return providerModelsFromSettings([], customModels ?? [], EMPTY_CAPABILITIES);
}

export function dagoModelsFromAcp(
  inventory: DagoAcpModelList,
  customModels: ReadonlyArray<string> | undefined,
) {
  const seen = new Set<string>();
  const discovered: ServerProviderModel[] = [];
  for (const candidate of inventory.models) {
    const slug = candidate.id.trim();
    const name = candidate.name.trim();
    if (!slug || !name || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    const separator = slug.indexOf(":");
    const subProvider = separator > 0 ? slug.slice(0, separator) : undefined;
    discovered.push({
      slug,
      name,
      ...(subProvider ? { subProvider } : {}),
      isCustom: false,
      isDefault: slug === inventory.default_model,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return providerModelsFromSettings(discovered, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialDagoProviderSnapshot(
  settings: DagoSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = dagoModelsFromSettings(settings.customModels);
    return buildServerProvider({
      presentation: DAGO_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking dago availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "dago is disabled in settings.",
          },
    });
  });
}

export const checkDagoProviderStatus = Effect.fn("checkDagoProviderStatus")(function* (
  settings: DagoSettings,
  options: { readonly cwd: string; readonly stateDir: string },
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = dagoModelsFromSettings(settings.customModels);
  if (!settings.enabled) {
    return yield* buildInitialDagoProviderSnapshot(settings);
  }
  const command = settings.binaryPath || "dacode";
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(result)) {
    return buildServerProvider({
      presentation: DAGO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(result.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(result.failure)
          ? "The dacode CLI is not installed or not on PATH."
          : "Failed to execute the dacode health check.",
      },
    });
  }
  if (Option.isNone(result.success)) {
    return buildServerProvider({
      presentation: DAGO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The dacode CLI timed out while reporting its version.",
      },
    });
  }
  const output = result.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return buildServerProvider({
      presentation: DAGO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "The dacode CLI failed to run.",
      },
    });
  }
  const inventoryResult = yield* listDagoAcpModels({
    settings,
    cwd: options.cwd,
    stateDir: options.stateDir,
    environment,
  }).pipe(Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(inventoryResult)) {
    return buildServerProvider({
      presentation: DAGO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Failed to discover dago models through ACP.",
      },
    });
  }
  if (Option.isNone(inventoryResult.success)) {
    return buildServerProvider({
      presentation: DAGO_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "dago timed out while reporting its ACP model catalog.",
      },
    });
  }
  return buildServerProvider({
    presentation: DAGO_PRESENTATION,
    enabled: true,
    checkedAt,
    models: dagoModelsFromAcp(inventoryResult.success.value, settings.customModels),
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
    },
  });
});

export const enrichDagoSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("dago version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
