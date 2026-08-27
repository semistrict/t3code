import {
  OpenSweSettings,
  ProviderDriverKind,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { makeOpenSweAdapter, type OpenSweAdapterSettings } from "../Layers/OpenSweAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("open-swe");
const DEFAULT_API_URL = "http://127.0.0.1:2024";

import * as Schema from "effect/Schema";

const decodeSettings = Schema.decodeSync(OpenSweSettings);
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

export function resolveOpenSweSettings(
  config: OpenSweSettings,
  environment: NodeJS.ProcessEnv,
): OpenSweAdapterSettings {
  const apiUrl = config.apiUrl.trim() || environment.OPEN_SWE_API_URL?.trim() || DEFAULT_API_URL;
  const dashboardUrl = environment.OPEN_SWE_DASHBOARD_URL?.trim();
  const dashboardMatchesApi = (() => {
    if (!dashboardUrl) return false;
    try {
      return new URL(dashboardUrl).origin === new URL(apiUrl).origin;
    } catch {
      return false;
    }
  })();
  return {
    apiUrl,
    apiToken: config.apiToken.trim() || environment.OPEN_SWE_API_TOKEN?.trim() || undefined,
    dashboardSession: dashboardMatchesApi
      ? environment.OPEN_SWE_DASHBOARD_SESSION?.trim() || undefined
      : undefined,
    graphId: config.graphId.trim() || environment.OPEN_SWE_GRAPH_ID?.trim() || "agent",
    localMode: environment.OPEN_SWE_LOCAL_MODE === "1",
    repository: config.repository.trim() || environment.OPEN_SWE_REPOSITORY?.trim() || undefined,
  };
}

function firstLine(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function makeTextGeneration(): TextGeneration["Service"] {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "Open SWE does not expose this text-generation operation.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: (input) =>
      Effect.succeed({
        branch:
          input.message
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 48) || "change",
      }),
    generateThreadTitle: (input) =>
      Effect.succeed({ title: firstLine(input.message, 72) || "New thread" }),
  };
}

function healthSnapshot(input: {
  readonly enabled: boolean;
  readonly settings: OpenSweAdapterSettings;
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationGroupKey: string;
}): Effect.Effect<ServerProvider> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      instanceId: input.instanceId,
      driver: DRIVER_KIND,
      displayName: input.displayName ?? "Open SWE",
      ...(input.accentColor ? { accentColor: input.accentColor } : {}),
      continuation: { groupKey: input.continuationGroupKey },
      enabled: input.enabled,
      version: null,
      checkedAt,
      models: [
        {
          slug: "default",
          name: "Workspace default",
          isCustom: false,
          isDefault: true,
          capabilities: EMPTY_CAPABILITIES,
        },
      ],
      slashCommands: [],
      skills: [],
      showInteractionModeToggle: false,
      requiresNewThreadForModelChange: false,
      availability: "available" as const,
    };
    if (!input.enabled) {
      return {
        ...base,
        installed: false,
        status: "disabled",
        auth: { status: "unknown" },
        message: "Open SWE is disabled.",
      };
    }
    if (input.settings.dashboardSession) {
      return {
        ...base,
        installed: true,
        status: "ready",
        auth: {
          status: "authenticated",
          type: "remote",
        },
      };
    }
    return {
      ...base,
      installed: true,
      status: "ready",
      auth: { status: "authenticated", type: "local" },
    };
  });
}

export type OpenSweDriverEnv = never;

export const OpenSweDriver: ProviderDriver<OpenSweSettings, OpenSweDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Open SWE",
    supportsMultipleInstances: true,
  },
  configSchema: OpenSweSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const effectiveSettings = resolveOpenSweSettings(config, processEnvironment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const adapter = yield* makeOpenSweAdapter(effectiveSettings, {
        instanceId,
      });
      const getSnapshot = healthSnapshot({
        enabled,
        settings: effectiveSettings,
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
          getSnapshot,
          refresh: getSnapshot,
          streamChanges: Stream.never,
        },
        adapter,
        textGeneration: makeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
