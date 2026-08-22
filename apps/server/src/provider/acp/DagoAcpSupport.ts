import type { DagoSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type DagoAcpRuntimeSettings = Pick<DagoSettings, "binaryPath">;

export const DAGO_MODEL_LIST_METHOD = "_dago/models/list";

const DagoAcpModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const DagoAcpModelListResponse = Schema.Struct({
  version: Schema.Literal(1),
  default_model: Schema.String,
  models: Schema.Array(DagoAcpModel),
});

export type DagoAcpModelList = typeof DagoAcpModelListResponse.Type;

const decodeDagoAcpModelList = Schema.decodeUnknownEffect(DagoAcpModelListResponse);

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

export const listDagoAcpModels = Effect.fn("listDagoAcpModels")(function* (input: {
  readonly settings: DagoAcpRuntimeSettings | null | undefined;
  readonly cwd: string;
  readonly stateDir: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly spawn?: AcpSessionRuntime.AcpSpawnInput;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const spawn =
        input.spawn ??
        buildDagoAcpSpawnInput(input.settings, input.cwd, input.stateDir, input.environment);
      const spawnCommand = yield* resolveSpawnCommand(spawn.command, spawn.args, {
        ...(spawn.env ? { env: spawn.env } : {}),
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            ...(spawn.cwd ? { cwd: spawn.cwd } : {}),
            ...(spawn.env ? { env: spawn.env, extendEnv: true } : {}),
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new EffectAcpErrors.AcpSpawnError({
                command: spawn.command,
                cause,
              }),
          ),
        );
      const acpContext = yield* Layer.build(EffectAcpClient.layerChildProcess(child)).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));
      const initializeResult = yield* acp.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-provider-probe", version: "0.0.0" },
      });
      if (initializeResult.protocolVersion !== 1) {
        return yield* new EffectAcpErrors.AcpTransportError({
          operation: "call-rpc",
          method: "initialize",
          detail: `ACP protocol version mismatch: client requested 1, agent selected ${initializeResult.protocolVersion}`,
          cause: initializeResult,
        });
      }
      const advertisedAuthMethodIds = (initializeResult.authMethods ?? []).map(
        (method) => method.id,
      );
      const authMethodId = AcpSessionRuntime.selectAcpAuthMethodId(
        initializeResult,
        "cursor_login",
      );
      if (advertisedAuthMethodIds.length > 0 && authMethodId === undefined) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          'Preferred ACP authentication method "cursor_login" was not advertised by the agent',
          {
            preferredMethodId: "cursor_login",
            advertisedMethodIds: advertisedAuthMethodIds,
          },
        );
      }
      if (authMethodId !== undefined) {
        yield* acp.agent.authenticate({ methodId: authMethodId });
      }
      const response = yield* acp.raw.request(DAGO_MODEL_LIST_METHOD, { version: 1 });
      return yield* decodeDagoAcpModelList(response).pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "dacode returned an invalid ACP model list.",
              cause,
            }),
        ),
      );
    }),
  );
});

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
