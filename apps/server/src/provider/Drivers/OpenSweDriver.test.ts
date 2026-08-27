import { OpenSweSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveOpenSweSettings } from "./OpenSweDriver.ts";

const decodeSettings = Schema.decodeSync(OpenSweSettings);

describe("resolveOpenSweSettings", () => {
  it("uses the configured endpoint", () => {
    expect(
      resolveOpenSweSettings(decodeSettings({ apiUrl: "https://custom.test" }), {
        OPEN_SWE_API_URL: "https://launcher.test",
      }),
    ).toMatchObject({
      apiUrl: "https://custom.test",
      graphId: "agent",
      localMode: false,
    });
  });

  it("binds a remote dashboard session to its original endpoint", () => {
    expect(
      resolveOpenSweSettings(decodeSettings({}), {
        OPEN_SWE_API_URL: "https://remote.test",
        OPEN_SWE_DASHBOARD_URL: "https://remote.test/",
        OPEN_SWE_DASHBOARD_SESSION: "signed-session",
      }).dashboardSession,
    ).toBe("signed-session");
    expect(
      resolveOpenSweSettings(decodeSettings({ apiUrl: "https://different.test" }), {
        OPEN_SWE_DASHBOARD_URL: "https://remote.test/",
        OPEN_SWE_DASHBOARD_SESSION: "signed-session",
      }).dashboardSession,
    ).toBeUndefined();
  });
});
