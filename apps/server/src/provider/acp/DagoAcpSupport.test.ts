import { describe, expect, it } from "vite-plus/test";

import { buildDagoAcpSpawnInput } from "./DagoAcpSupport.ts";

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
});
