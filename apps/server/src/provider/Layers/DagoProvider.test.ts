import type { DagoSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { buildInitialDagoProviderSnapshot, dagoModelsFromAcp } from "./DagoProvider.ts";

const settings = (overrides: Partial<DagoSettings> = {}): DagoSettings => ({
  enabled: false,
  binaryPath: "dacode",
  customModels: [],
  ...overrides,
});

describe("buildInitialDagoProviderSnapshot", () => {
  it.effect("advertises workflow presentation while ACP discovery is pending", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDagoProviderSnapshot(settings());

      expect(snapshot).toMatchObject({
        displayName: "dago",
        badgeLabel: "Workflows",
        enabled: false,
        installed: false,
        auth: { status: "unknown" },
      });
      expect(snapshot.models).toEqual([]);
    }),
  );

  it.effect("keeps configured custom models available while ACP discovery is pending", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDagoProviderSnapshot(
        settings({ customModels: ["gpt-5.6-terra", "openrouter/custom"] }),
      );

      expect(snapshot.models.map((model) => [model.slug, model.isCustom])).toEqual([
        ["gpt-5.6-terra", true],
        ["openrouter/custom", true],
      ]);
    }),
  );

  it("maps the ACP catalog and merges custom models without duplicates", () => {
    const models = dagoModelsFromAcp(
      {
        version: 1,
        default_model: "openai:gpt-5.6-terra",
        models: [
          { id: "openai:gpt-5.6-terra", name: "GPT-5.6 Terra" },
          { id: "openrouter:anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
          { id: "openai:gpt-5.6-terra", name: "Duplicate" },
          { id: " ", name: "Invalid" },
        ],
      },
      ["openrouter:anthropic/claude-sonnet-5", "custom:model"],
    );

    expect(
      models.map((model) => [
        model.slug,
        model.name,
        model.subProvider,
        model.isDefault,
        model.isCustom,
      ]),
    ).toEqual([
      ["openai:gpt-5.6-terra", "GPT-5.6 Terra", "openai", true, false],
      ["openrouter:anthropic/claude-sonnet-5", "Claude Sonnet 5", "openrouter", false, false],
      ["custom:model", "custom:model", undefined, undefined, true],
    ]);
  });
});
