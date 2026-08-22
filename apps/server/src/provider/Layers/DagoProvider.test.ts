import type { DagoSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { buildInitialDagoProviderSnapshot } from "./DagoProvider.ts";

const settings = (overrides: Partial<DagoSettings> = {}): DagoSettings => ({
  enabled: false,
  binaryPath: "dacode",
  customModels: [],
  ...overrides,
});

describe("buildInitialDagoProviderSnapshot", () => {
  it.effect("advertises workflow presentation and the default model set", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDagoProviderSnapshot(settings());

      expect(snapshot).toMatchObject({
        displayName: "dago",
        badgeLabel: "Workflows",
        enabled: false,
        installed: false,
        auth: { status: "unknown" },
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual([
        "gpt-5.6-terra",
        "gpt-5.6-sol",
        "gpt-5.6-luna",
      ]);
    }),
  );

  it.effect("merges configured custom models without duplicating built-ins", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialDagoProviderSnapshot(
        settings({ customModels: ["gpt-5.6-terra", "openrouter/custom"] }),
      );

      expect(snapshot.models.map((model) => [model.slug, model.isCustom])).toEqual([
        ["gpt-5.6-terra", false],
        ["gpt-5.6-sol", false],
        ["gpt-5.6-luna", false],
        ["openrouter/custom", true],
      ]);
    }),
  );
});
