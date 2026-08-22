import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { acpPermissionOutcome, mapAcpToAdapterError } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to agent-defined permission option IDs", () => {
    const options = [
      { optionId: "approve", name: "Approve", kind: "allow_once" as const },
      { optionId: "approve-session", name: "Approve session", kind: "allow_always" as const },
      { optionId: "reject", name: "Reject", kind: "reject_once" as const },
    ];
    expect(acpPermissionOutcome(options, "accept")).toBe("approve");
    expect(acpPermissionOutcome(options, "acceptForSession")).toBe("approve-session");
    expect(acpPermissionOutcome(options, "decline")).toBe("reject");
  });

  it("never escalates a one-time approval when only session approval is offered", () => {
    const options = [
      { optionId: "approve-session", name: "Approve session", kind: "allow_always" as const },
    ];
    expect(acpPermissionOutcome(options, "accept")).toBeUndefined();
  });

  it("can safely narrow a session approval to an offered one-time approval", () => {
    const options = [{ optionId: "approve", name: "Approve", kind: "allow_once" as const }];
    expect(acpPermissionOutcome(options, "acceptForSession")).toBe("approve");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
