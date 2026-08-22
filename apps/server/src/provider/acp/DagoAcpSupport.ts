import type { DagoSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type DagoAcpRuntimeSettings = Pick<DagoSettings, "binaryPath">;

export interface DagoAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly dagoSettings: DagoAcpRuntimeSettings | null | undefined;
  readonly stateDir: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDagoAcpSpawnInput(
  settings: DagoAcpRuntimeSettings | null | undefined,
  cwd: string,
  stateDir: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "dacode",
    args: ["acp", "--state-dir", stateDir],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDagoAcpRuntime = (
  input: DagoAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDagoAcpSpawnInput(
          input.dagoSettings,
          input.cwd,
          input.stateDir,
          input.environment,
        ),
        authMethodId: "cursor_login",
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });
