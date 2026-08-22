// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { buildDagoAcpSpawnInput, listDagoAcpModels } from "./DagoAcpSupport.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

describe("buildDagoAcpSpawnInput", () => {
  it("builds an isolated ACP command with the provider state directory", () => {
    expect(buildDagoAcpSpawnInput(undefined, "/work/project", "/state/dago/work")).toEqual({
      command: "dacode",
      args: ["acp", "--state-dir", "/state/dago/work"],
      cwd: "/work/project",
    });
  });

  it("honors the configured binary and environment", () => {
    expect(
      buildDagoAcpSpawnInput(
        { binaryPath: "/opt/dago/dacode" },
        "/work/project",
        "/state/dago/work",
        { DAGO_PROFILE: "work" },
      ),
    ).toEqual({
      command: "/opt/dago/dacode",
      args: ["acp", "--state-dir", "/state/dago/work"],
      cwd: "/work/project",
      env: { DAGO_PROFILE: "work" },
    });
  });

  it.effect("discovers the model catalog through ACP", () =>
    Effect.gen(function* () {
      const inventory = yield* listDagoAcpModels({
        settings: undefined,
        cwd: process.cwd(),
        stateDir: "/unused",
        spawn: { command: "node", args: [mockAgentPath], cwd: process.cwd() },
      });

      expect(inventory).toEqual({
        version: 1,
        default_model: "openai:gpt-test-default",
        models: [
          { id: "openai:gpt-test-default", name: "GPT Test Default" },
          { id: "openrouter:vendor/test-model", name: "Test Model" },
        ],
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
