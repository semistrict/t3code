import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import {
  makeOpenSweAdapter,
  makeOpenSweDashboardClient,
  openSweAssistantText,
  openSweToolCalls,
  openSweToolResult,
  type OpenSweClient,
} from "./OpenSweAdapter.ts";

describe("openSweAssistantText", () => {
  it("reads assistant message chunks", () => {
    expect(
      openSweAssistantText([
        {
          type: "AIMessageChunk",
          content: [
            { type: "text", text: "hello " },
            { type: "tool_call_chunk", name: "read_file" },
            { type: "text", text: "world" },
          ],
        },
        { run_id: "run-1" },
      ]),
    ).toBe("hello world");
  });

  it("ignores non-assistant messages and malformed payloads", () => {
    expect(openSweAssistantText([{ type: "human", content: "do the work" }])).toBe("");
    expect(openSweAssistantText({ type: "AIMessageChunk", content: "hello" })).toBe("");
  });

  it("reads tool calls and matching results", () => {
    expect(
      openSweToolCalls([
        {
          type: "AIMessageChunk",
          content: "",
          tool_calls: [{ id: "call-1", name: "ls", args: { path: "." } }],
        },
        {},
      ]),
    ).toEqual([{ id: "call-1", name: "ls", input: { path: "." } }]);
    expect(
      openSweToolResult([
        {
          type: "tool",
          tool_call_id: "call-1",
          name: "ls",
          content: "file.txt",
          status: "success",
        },
        {},
      ]),
    ).toEqual({ id: "call-1", name: "ls", output: "file.txt", failed: false });
    expect(
      openSweToolCalls([
        {
          type: "AIMessageChunk",
          content: [
            {
              type: "tool_call_chunk",
              id: "call-2",
              name: "read_file",
              args: '{"path":"README.md"}',
            },
          ],
        },
        {},
      ]),
    ).toEqual([{ id: "call-2", name: "read_file", input: { path: "README.md" } }]);
  });

  it("starts and streams runs through an authenticated remote dashboard", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const responses = [
      new Response(
        JSON.stringify({
          type: "success",
          result: { run_id: "remote-run" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      new Response(
        'data: {"event":"messages","data":[{"type":"AIMessageChunk","content":"hello"},{}]}\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    ];
    const client = makeOpenSweDashboardClient({
      baseUrl: "https://open-swe.example.com/base",
      session: "signed-session",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), init });
        const response = responses.shift();
        if (!response) throw new Error("unexpected request");
        return response;
      },
    });

    const parts = [];
    for await (const part of client.runs.stream("thread-1", "agent", {
      input: { messages: [{ type: "human", content: "hello" }] },
      config: { configurable: {} },
      streamMode: ["messages-tuple", "updates"],
      streamSubgraphs: false,
      signal: new AbortController().signal,
      multitaskStrategy: "interrupt",
    })) {
      parts.push(part);
    }

    expect(parts).toEqual([
      { event: "metadata", data: { run_id: "remote-run" } },
      {
        event: "messages",
        data: [{ type: "AIMessageChunk", content: "hello" }, {}],
      },
    ]);
    expect(requests.map(({ url }) => url)).toEqual([
      "https://open-swe.example.com/dashboard/api/threads/thread-1/commands",
      "https://open-swe.example.com/dashboard/api/threads/thread-1/stream",
    ]);
    expect(new Headers(requests[0]?.init?.headers).get("cookie")).toBe(
      "osw_session=signed-session",
    );
    expect(new Headers(requests[0]?.init?.headers).get("origin")).toBe(
      "https://open-swe.example.com",
    );
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      method: "run.start",
      params: {
        assistant_id: "agent",
        stream_mode: ["messages-tuple", "updates"],
      },
    });
  });

  it.effect("creates the LangGraph thread and streams canonical assistant events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const createdThreads: Array<Record<string, unknown>> = [];
        const streamModes: Array<ReadonlyArray<"messages-tuple" | "updates">> = [];
        const client: OpenSweClient = {
          threads: {
            create: async (payload) => {
              createdThreads.push(payload);
              return payload;
            },
          },
          runs: {
            stream: async function* (_threadId, _assistantId, input) {
              streamModes.push(input.streamMode);
              yield { event: "metadata", data: { run_id: "run-1" } };
              yield {
                event: "messages",
                data: [
                  {
                    type: "AIMessageChunk",
                    content: "",
                    tool_calls: [{ id: "call-1", name: "ls", args: { path: "." } }],
                  },
                  {},
                ],
              };
              yield {
                event: "messages",
                data: [
                  {
                    type: "tool",
                    tool_call_id: "call-1",
                    name: "ls",
                    content: "file.txt",
                    status: "success",
                  },
                  {},
                ],
              };
              yield {
                event: "messages",
                data: [{ type: "AIMessageChunk", content: "hello from Open SWE" }, {}],
              };
            },
            cancel: async () => undefined,
          },
        };
        const adapter = yield* makeOpenSweAdapter(
          { apiUrl: "http://127.0.0.1:2024", graphId: "agent" },
          { client, instanceId: ProviderInstanceId.make("open-swe") },
        );
        const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
        const events: ProviderRuntimeEvent[] = [];
        const turnCompleted = yield* Deferred.make<void>();
        const eventFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("open-swe"),
          cwd: "/workspace",
          runtimeMode: "full-access",
          modelSelection: {
            instanceId: ProviderInstanceId.make("open-swe"),
            model: "default",
          },
        });
        yield* adapter.sendTurn({
          threadId,
          input: "do the work",
          attachments: [],
        });
        yield* Deferred.await(turnCompleted);
        yield* Fiber.interrupt(eventFiber);

        assert.equal(createdThreads.length, 1);
        assert.equal(createdThreads[0]?.threadId, threadId);
        assert.deepEqual(streamModes, [["messages-tuple", "updates"]]);
        assert.includeMembers(
          events.map((event) => event.type),
          ["thread.started", "turn.started", "item.started", "content.delta", "turn.completed"],
        );
        const toolCompleted = events.find(
          (event) =>
            event.type === "item.completed" && event.payload.itemType === "dynamic_tool_call",
        );
        assert.isDefined(toolCompleted);
        if (toolCompleted?.type === "item.completed") {
          assert.equal(toolCompleted.payload.itemType, "dynamic_tool_call");
          assert.equal(toolCompleted.payload.status, "completed");
          assert.equal(toolCompleted.payload.title, "ls");
          assert.equal(toolCompleted.payload.detail, "file.txt");
        }
        const content = events
          .filter(
            (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
              event.type === "content.delta",
          )
          .map((event) => event.payload.delta)
          .join("");
        assert.equal(content, "hello from Open SWE");
      }),
    ),
  );
});
