import {
  type CursorSettings,
  type DagoSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeDagoAcpRuntime } from "../acp/DagoAcpSupport.ts";
import {
  DAGO_WORKFLOW_CANCEL_METHOD,
  DAGO_WORKFLOW_LIST_METHOD,
  DAGO_WORKFLOW_UPDATE_METHOD,
  DagoWorkflowListResponse,
  DagoWorkflowUpdate,
  makeDagoWorkflowProjector,
} from "../acp/DagoWorkflowProjection.ts";
import { makeCursorAdapter } from "./CursorAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("dago");
const decodeDagoWorkflowList = Schema.decodeUnknownEffect(DagoWorkflowListResponse);

export interface DagoAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId: ProviderInstanceId;
  readonly stateDir: string;
}

interface DagoWorkflowRequester {
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function cancelRunningDagoWorkflows(runtime: DagoWorkflowRequester, sessionId: string) {
  return Effect.gen(function* () {
    const response = yield* runtime.request(DAGO_WORKFLOW_LIST_METHOD, {
      version: 1,
      session_id: sessionId,
    });
    const listed = yield* decodeDagoWorkflowList(response).pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "dago returned an invalid workflow list.",
            cause,
          }),
      ),
    );
    yield* Effect.forEach(
      listed.workflows.filter((workflow) => workflow.status === "running"),
      (workflow) =>
        runtime.request(DAGO_WORKFLOW_CANCEL_METHOD, {
          version: 1,
          session_id: sessionId,
          run_id: workflow.run_id,
        }),
      { discard: true },
    );
  });
}

export function makeDagoAdapter(settings: DagoSettings, options: DagoAdapterLiveOptions) {
  const compatibilitySettings = {
    enabled: settings.enabled,
    binaryPath: settings.binaryPath,
    apiEndpoint: "",
    customModels: settings.customModels,
  } satisfies CursorSettings;

  return makeCursorAdapter(compatibilitySettings, {
    provider: PROVIDER,
    runtimeName: "dago",
    includeCursorExtensions: false,
    instanceId: options.instanceId,
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.nativeEventLogger ? { nativeEventLogger: options.nativeEventLogger } : {}),
    makeRuntime: (input) =>
      makeDagoAcpRuntime({
        ...input,
        dagoSettings: settings,
        stateDir: options.stateDir,
      }),
    configureRuntime: ({ runtime, threadId, getActiveTurnId, emit, makeEventStamp }) => {
      const project = makeDagoWorkflowProjector();
      return runtime.handleExtNotification(
        DAGO_WORKFLOW_UPDATE_METHOD,
        DagoWorkflowUpdate,
        (update) =>
          project(update, (event) =>
            Effect.gen(function* () {
              const stamp = yield* makeEventStamp();
              const base = {
                ...stamp,
                provider: PROVIDER,
                threadId,
                ...(getActiveTurnId() ? { turnId: getActiveTurnId() } : {}),
                raw: {
                  source: "acp.dago.extension" as const,
                  method: DAGO_WORKFLOW_UPDATE_METHOD,
                  payload: update,
                },
              };
              switch (event.type) {
                case "task.started":
                  yield* emit({ ...base, type: event.type, payload: event.payload });
                  return;
                case "task.progress":
                  yield* emit({ ...base, type: event.type, payload: event.payload });
                  return;
                case "task.completed":
                  yield* emit({ ...base, type: event.type, payload: event.payload });
              }
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to stamp a dago workflow event.",
                    cause,
                  }),
              ),
            ),
          ),
      );
    },
    beforeInterrupt: ({ runtime, sessionId }) => cancelRunningDagoWorkflows(runtime, sessionId),
  });
}
