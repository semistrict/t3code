import { Client } from "@langchain/langgraph-sdk";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ToolLifecycleItemType,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as DateTime from "effect/DateTime";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("open-swe");
const RESUME_SCHEMA_VERSION = 1 as const;

type StreamPart = {
  readonly event: string;
  readonly data: unknown;
};

export interface OpenSweClient {
  readonly threads: {
    readonly create: (payload: {
      readonly threadId: string;
      readonly ifExists: "do_nothing";
      readonly metadata: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  readonly runs: {
    readonly stream: (
      threadId: string,
      assistantId: string,
      input: {
        readonly input: Record<string, unknown>;
        readonly config: Record<string, unknown>;
        readonly streamMode: ReadonlyArray<"messages-tuple" | "updates">;
        readonly streamSubgraphs: false;
        readonly signal: AbortSignal;
        readonly multitaskStrategy: "interrupt";
      },
    ) => AsyncIterable<StreamPart>;
    readonly cancel: (
      threadId: string,
      runId: string,
      wait?: boolean,
      action?: "interrupt" | "rollback",
    ) => Promise<void>;
  };
}

export interface OpenSweAdapterSettings {
  readonly apiUrl: string;
  readonly apiToken?: string | undefined;
  readonly dashboardSession?: string | undefined;
  readonly graphId: string;
  readonly localMode?: boolean | undefined;
  readonly repository?: string | undefined;
}

export interface OpenSweAdapterOptions {
  readonly client?: OpenSweClient;
  readonly instanceId?: ProviderInstanceId;
  readonly fetchImpl?: FetchLike;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function dashboardApiUrl(baseUrl: string, path: string): string {
  return new URL(`/dashboard/api${path}`, baseUrl).toString();
}

function dashboardHeaders(
  baseUrl: string,
  session: string,
  extra: RequestInit["headers"] = {},
): Headers {
  const headers = new Headers(extra);
  headers.set("cookie", `osw_session=${session}`);
  headers.set("origin", new URL(baseUrl).origin);
  return headers;
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text()).replace(/\s+/g, " ").trim();
  return new Error(`Open SWE returned ${response.status}${detail ? `: ${detail}` : ""}`);
}

async function* sseParts(response: Response): AsyncIterable<StreamPart> {
  if (!response.body) throw new Error("Open SWE returned no event stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const parseBlock = (block: string): StreamPart | undefined => {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) return undefined;
    const payload: unknown = JSON.parse(data);
    if (!isRecord(payload) || typeof payload.event !== "string") {
      return undefined;
    }
    return { event: payload.event, data: payload.data };
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const part = parseBlock(block);
      if (part) yield part;
    }
  }
  buffer += decoder.decode();
  const part = parseBlock(buffer);
  if (part) yield part;
}

export function makeOpenSweDashboardClient(input: {
  readonly baseUrl: string;
  readonly session: string;
  readonly fetchImpl?: FetchLike;
}): OpenSweClient {
  const fetchImpl = input.fetchImpl ?? fetch;
  return {
    threads: {
      create: async () => undefined,
    },
    runs: {
      stream: async function* (threadId, assistantId, request) {
        const commandResponse = await fetchImpl(
          dashboardApiUrl(input.baseUrl, `/threads/${encodeURIComponent(threadId)}/commands`),
          {
            method: "POST",
            headers: dashboardHeaders(input.baseUrl, input.session, {
              "content-type": "application/json",
            }),
            body: JSON.stringify({
              method: "run.start",
              params: {
                assistant_id: assistantId,
                input: request.input,
                config: request.config,
                stream_mode: request.streamMode,
                stream_subgraphs: request.streamSubgraphs,
                multitask_strategy: request.multitaskStrategy,
              },
            }),
            signal: request.signal,
          },
        );
        if (!commandResponse.ok) throw await responseError(commandResponse);
        const command: unknown = await commandResponse.json();
        const result = isRecord(command) && isRecord(command.result) ? command.result : undefined;
        const runId = typeof result?.run_id === "string" ? result.run_id : "";
        if (!runId) throw new Error("Open SWE returned no run ID");
        yield { event: "metadata", data: { run_id: runId } };

        const streamResponse = await fetchImpl(
          dashboardApiUrl(input.baseUrl, `/threads/${encodeURIComponent(threadId)}/stream`),
          {
            headers: dashboardHeaders(input.baseUrl, input.session, {
              accept: "text/event-stream",
            }),
            signal: request.signal,
          },
        );
        if (!streamResponse.ok) throw await responseError(streamResponse);
        yield* sseParts(streamResponse);
      },
      cancel: async (threadId, runId, wait = false, action = "interrupt") => {
        const response = await fetchImpl(
          dashboardApiUrl(
            input.baseUrl,
            `/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/cancel?wait=${wait ? "1" : "0"}&action=${encodeURIComponent(action)}`,
          ),
          {
            method: "POST",
            headers: dashboardHeaders(input.baseUrl, input.session, {
              "content-type": "application/json",
            }),
          },
        );
        if (!response.ok) throw await responseError(response);
      },
    },
  };
}

interface TurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface SessionContext {
  session: ProviderSession;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly turns: Array<TurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeRunId: string | undefined;
  abortController: AbortController | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBlockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  if (value.type !== "text" || typeof value.text !== "string") return "";
  return value.text;
}

function openSweMessage(data: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(data) || data.length < 1 || !isRecord(data[0])) {
    return undefined;
  }
  return data[0];
}

export function openSweAssistantText(data: unknown): string {
  const message = openSweMessage(data);
  if (!message) return "";
  const type = typeof message.type === "string" ? message.type.toLowerCase() : "";
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role !== "assistant" && type !== "ai" && type !== "aimessagechunk") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map(contentBlockText).join("");
}

export interface OpenSweToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface OpenSweToolResult {
  readonly id: string;
  readonly name?: string | undefined;
  readonly output: string;
  readonly failed: boolean;
}

function openSweToolCall(value: unknown): OpenSweToolCall | undefined {
  if (!isRecord(value)) return undefined;
  const nestedFunction = isRecord(value.function) ? value.function : undefined;
  const rawId = value.id ?? value.call_id ?? value.tool_call_id;
  const rawName = value.name ?? nestedFunction?.name;
  if (typeof rawId !== "string" || typeof rawName !== "string") {
    return undefined;
  }
  const id = rawId.trim();
  const name = rawName.trim();
  if (!id || !name) return undefined;

  const rawInput = value.args ?? value.arguments ?? nestedFunction?.arguments;
  if (typeof rawInput !== "string") {
    return { id, name, input: rawInput ?? {} };
  }
  let input: unknown = rawInput;
  try {
    input = rawInput ? JSON.parse(rawInput) : {};
  } catch {
    // Partial streamed JSON remains visible until a parsed call arrives.
  }
  return { id, name, input };
}

export function openSweToolCalls(data: unknown): ReadonlyArray<OpenSweToolCall> {
  const message = openSweMessage(data);
  if (!message) return [];
  const sources = [
    ...(Array.isArray(message.tool_calls) ? message.tool_calls : []),
    ...(Array.isArray(message.tool_call_chunks) ? message.tool_call_chunks : []),
    ...(Array.isArray(message.content)
      ? message.content.filter(
          (value) =>
            isRecord(value) && (value.type === "tool_call" || value.type === "tool_call_chunk"),
        )
      : []),
  ];
  const calls = new Map<string, OpenSweToolCall>();
  for (const source of sources) {
    const call = openSweToolCall(source);
    if (call) calls.set(call.id, call);
  }
  return [...calls.values()];
}

export function openSweToolResult(data: unknown): OpenSweToolResult | undefined {
  const message = openSweMessage(data);
  if (!message) return undefined;
  const type = typeof message.type === "string" ? message.type.toLowerCase() : "";
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (type !== "tool" && type !== "toolmessage" && role !== "tool") {
    return undefined;
  }
  const rawId = message.tool_call_id ?? message.toolCallId;
  if (typeof rawId !== "string" || !rawId.trim()) return undefined;
  const output = Array.isArray(message.content)
    ? message.content.map(contentBlockText).join("")
    : typeof message.content === "string"
      ? message.content
      : "";
  return {
    id: rawId.trim(),
    ...(typeof message.name === "string" && message.name.trim()
      ? { name: message.name.trim() }
      : {}),
    output,
    failed: message.status === "error" || message.status === "failed" || message.is_error === true,
  };
}

function toolLifecycleItemType(name: string): ToolLifecycleItemType {
  const normalized = name.toLowerCase();
  if (
    normalized.includes("execute") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("bash")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("patch") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("web") || normalized.includes("fetch_url")) {
    return "web_search";
  }
  if (normalized.includes("image")) return "image_view";
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  if (normalized.includes("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function runIdFromMetadata(data: unknown): string | undefined {
  if (!isRecord(data) || typeof data.run_id !== "string" || !data.run_id.trim()) {
    return undefined;
  }
  return data.run_id.trim();
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : "The Open SWE run failed.";
}

export function makeOpenSweAdapter(
  settings: OpenSweAdapterSettings,
  options: OpenSweAdapterOptions = {},
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> {
  return Effect.gen(function* () {
    const boundInstanceId = options.instanceId ?? ProviderInstanceId.make("open-swe");
    const client =
      options.client ??
      (settings.dashboardSession
        ? makeOpenSweDashboardClient({
            baseUrl: settings.apiUrl,
            session: settings.dashboardSession,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          })
        : (new Client({
            apiUrl: settings.apiUrl,
            apiKey: null,
            ...(settings.apiToken
              ? {
                  defaultHeaders: {
                    authorization: `Bearer ${settings.apiToken}`,
                  },
                }
              : {}),
          }) as unknown as OpenSweClient));
    const sessions = new Map<ThreadId, SessionContext>();
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nextId = Effect.all([Random.nextInt, Random.nextInt]).pipe(
      Effect.map(([left, right]) => `${left.toString(36)}-${right.toString(36)}`),
    );
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const eventBase = (threadId: ThreadId, turnId?: TurnId, itemId?: RuntimeItemId) =>
      Effect.all({
        eventId: nextId.pipe(Effect.map(EventId.make)),
        createdAt: nowIso,
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          createdAt,
          ...(turnId ? { turnId } : {}),
          ...(itemId ? { itemId } : {}),
        })),
      );
    const emit = (event: ProviderRuntimeEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const session = sessions.get(threadId);
      return session
        ? Effect.succeed(session)
        : Effect.fail(
            new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            }),
          );
    };
    const updateSession = (context: SessionContext, status: ProviderSession["status"]) =>
      nowIso.pipe(
        Effect.map((updatedAt) => {
          context.session = { ...context.session, status, updatedAt };
        }),
      );

    const completeRun = (input: {
      readonly context: SessionContext;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly itemId: RuntimeItemId;
      readonly text: string;
      readonly state: "completed" | "failed" | "cancelled";
      readonly error?: string | undefined;
    }) =>
      Effect.gen(function* () {
        if (input.text) {
          input.context.turns.push({
            id: input.turnId,
            items: [{ type: "assistant_message", text: input.text }],
          });
          yield* emit({
            ...(yield* eventBase(input.threadId, input.turnId, input.itemId)),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: input.state === "completed" ? "completed" : "failed",
              data: { text: input.text },
            },
          });
        }
        yield* emit({
          ...(yield* eventBase(input.threadId, input.turnId)),
          type: "turn.completed",
          payload: {
            state: input.state,
            ...(input.error ? { errorMessage: input.error } : {}),
          },
        });
        input.context.activeTurnId = undefined;
        input.context.activeRunId = undefined;
        input.context.abortController = undefined;
        input.context.session = {
          ...input.context.session,
          status: "ready",
          updatedAt: yield* nowIso,
        };
        delete (input.context.session as ProviderSession & { activeTurnId?: TurnId }).activeTurnId;
        yield* emit({
          ...(yield* eventBase(input.threadId)),
          type: "session.state.changed",
          payload: { state: "ready" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        const existing = sessions.get(input.threadId);
        if (existing) return existing.session;
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Open SWE requires a project working directory.",
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            client.threads.create({
              threadId: input.threadId,
              ifExists: "do_nothing",
              metadata: { source: "t3", project_path: input.cwd },
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "threads.create",
              detail: errorMessage(cause),
              cause,
            }),
        });
        const scope = yield* Scope.make();
        const timestamp = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd,
          model: input.modelSelection?.model ?? "default",
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: RESUME_SCHEMA_VERSION,
            threadId: input.threadId,
          },
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const context: SessionContext = {
          session,
          cwd: input.cwd,
          scope,
          turns: [],
          activeTurnId: undefined,
          activeRunId: undefined,
          abortController: undefined,
        };
        sessions.set(input.threadId, context);
        yield* emit({
          ...(yield* eventBase(input.threadId)),
          type: "session.started",
          payload: { resume: session.resumeCursor },
        });
        yield* emit({
          ...(yield* eventBase(input.threadId)),
          type: "session.state.changed",
          payload: { state: "ready" },
        });
        yield* emit({
          ...(yield* eventBase(input.threadId)),
          type: "thread.started",
          payload: { providerThreadId: input.threadId },
        });
        return session;
      });

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const message = input.input?.trim();
        if (!message) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Open SWE requires a non-empty text prompt.",
          });
        }
        if (input.attachments?.length) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Open SWE image attachments are not supported yet.",
          });
        }
        if (context.activeTurnId) {
          context.abortController?.abort();
        }

        const turnId = TurnId.make(yield* nextId);
        const itemId = RuntimeItemId.make(yield* nextId);
        const abortController = new AbortController();
        context.activeTurnId = turnId;
        context.abortController = abortController;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: yield* nowIso,
        };

        yield* emit({
          ...(yield* eventBase(input.threadId, turnId)),
          type: "turn.started",
          payload: { model: context.session.model ?? "default" },
        });
        yield* emit({
          ...(yield* eventBase(input.threadId)),
          type: "session.state.changed",
          payload: { state: "running" },
        });

        const run = Effect.tryPromise({
          try: async () => {
            let text = "";
            let itemStarted = false;
            const toolCalls = new Map<string, OpenSweToolCall>();
            const completedToolCalls = new Set<string>();
            for await (const part of client.runs.stream(input.threadId, settings.graphId, {
              input: { messages: [{ type: "human", content: message }] },
              config: {
                configurable: {
                  ...(settings.localMode
                    ? {
                        source: "desktop",
                        local_project_path: context.cwd,
                      }
                    : {
                        source: "dashboard",
                        ...(settings.repository ? { repo: settings.repository } : {}),
                      }),
                },
              },
              streamMode: ["messages-tuple", "updates"],
              streamSubgraphs: false,
              signal: abortController.signal,
              multitaskStrategy: "interrupt",
            })) {
              if (part.event === "metadata") {
                context.activeRunId = runIdFromMetadata(part.data);
                continue;
              }
              if (part.event !== "messages") continue;
              for (const call of openSweToolCalls(part.data)) {
                const previous = toolCalls.get(call.id);
                toolCalls.set(call.id, call);
                const toolItemId = RuntimeItemId.make(call.id);
                await Effect.runPromise(
                  emit({
                    ...(await Effect.runPromise(eventBase(input.threadId, turnId, toolItemId))),
                    type: previous ? "item.updated" : "item.started",
                    payload: {
                      itemType: toolLifecycleItemType(call.name),
                      status: "inProgress",
                      title: call.name,
                      data: { tool: call.name, input: call.input },
                    },
                  }),
                );
              }
              const toolResult = openSweToolResult(part.data);
              if (toolResult && !completedToolCalls.has(toolResult.id)) {
                const call = toolCalls.get(toolResult.id);
                const toolName = toolResult.name ?? call?.name ?? "tool";
                const toolItemId = RuntimeItemId.make(toolResult.id);
                if (!call) {
                  await Effect.runPromise(
                    emit({
                      ...(await Effect.runPromise(eventBase(input.threadId, turnId, toolItemId))),
                      type: "item.started",
                      payload: {
                        itemType: toolLifecycleItemType(toolName),
                        status: "inProgress",
                        title: toolName,
                        data: { tool: toolName },
                      },
                    }),
                  );
                }
                completedToolCalls.add(toolResult.id);
                await Effect.runPromise(
                  emit({
                    ...(await Effect.runPromise(eventBase(input.threadId, turnId, toolItemId))),
                    type: "item.completed",
                    payload: {
                      itemType: toolLifecycleItemType(toolName),
                      status: toolResult.failed ? "failed" : "completed",
                      title: toolName,
                      ...(toolResult.output.trim() ? { detail: toolResult.output } : {}),
                      data: {
                        tool: toolName,
                        ...(call ? { input: call.input } : {}),
                        output: toolResult.output,
                      },
                    },
                  }),
                );
                continue;
              }
              const delta = openSweAssistantText(part.data);
              if (!delta) continue;
              text += delta;
              if (!itemStarted) {
                itemStarted = true;
                await Effect.runPromise(
                  emit({
                    ...(await Effect.runPromise(eventBase(input.threadId, turnId, itemId))),
                    type: "item.started",
                    payload: {
                      itemType: "assistant_message",
                      status: "inProgress",
                    },
                  }),
                );
              }
              await Effect.runPromise(
                emit({
                  ...(await Effect.runPromise(eventBase(input.threadId, turnId, itemId))),
                  type: "content.delta",
                  payload: { streamKind: "assistant_text", delta },
                }),
              );
            }
            return text;
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "runs.stream",
              detail: errorMessage(cause),
              cause,
            }),
        }).pipe(
          Effect.flatMap((text) =>
            completeRun({
              context,
              threadId: input.threadId,
              turnId,
              itemId,
              text,
              state: "completed",
            }),
          ),
          Effect.catch((cause) => {
            const cancelled = abortController.signal.aborted;
            const message = cancelled ? undefined : cause.message;
            return Effect.gen(function* () {
              if (message) {
                yield* emit({
                  ...(yield* eventBase(input.threadId, turnId)),
                  type: "runtime.error",
                  payload: { message, class: "transport_error" },
                });
              }
              yield* completeRun({
                context,
                threadId: input.threadId,
                turnId,
                itemId,
                text: "",
                state: cancelled ? "cancelled" : "failed",
                error: message,
              });
            });
          }),
        );
        yield* Effect.forkIn(run, context.scope);

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.abortController?.abort();
        const activeRunId = context.activeRunId;
        if (activeRunId) {
          yield* Effect.tryPromise({
            try: () => client.runs.cancel(threadId, activeRunId, false, "interrupt"),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "runs.cancel",
                detail: errorMessage(cause),
                cause,
              }),
          }).pipe(Effect.ignore);
        }
      });

    const unsupportedRequest = (operation: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: "Open SWE local sessions do not expose interactive provider requests.",
        }),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.abortController?.abort();
        sessions.delete(threadId);
        yield* Scope.close(context.scope, Exit.void);
        yield* updateSession(context, "closed");
        yield* emit({
          ...(yield* eventBase(threadId)),
          type: "session.exited",
          payload: { exitKind: "graceful" },
        });
      });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const context of sessions.values()) {
          context.abortController?.abort();
          yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        }
        sessions.clear();
        yield* Queue.shutdown(events);
      }),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () => unsupportedRequest("respondToRequest"),
      respondToUserInput: () => unsupportedRequest("respondToUserInput"),
      stopSession,
      listSessions: () => Effect.succeed([...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.map((context): ProviderThreadSnapshot => ({
            threadId,
            turns: context.turns,
          })),
        ),
      rollbackThread: (threadId) =>
        requireSession(threadId).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "rollbackThread",
                issue: "Open SWE thread rollback is not supported.",
              }),
            ),
          ),
        ),
      stopAll: () =>
        Effect.forEach([...sessions.keys()], stopSession, {
          concurrency: "unbounded",
          discard: true,
        }),
      streamEvents: Stream.fromQueue(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
