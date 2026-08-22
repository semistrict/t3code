import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  type DagoWorkflowProjectedEvent,
  type DagoWorkflowUpdate,
  makeDagoWorkflowProjector,
} from "./DagoWorkflowProjection.ts";

const runningUpdate = {
  version: 1,
  session_id: "session-1",
  workflow: {
    version: 1,
    task_id: "workflow-1",
    run_id: "wf_1",
    name: "audit",
    description: "Audit the service",
    phases: [{ title: "Scan" }, { title: "Verify" }],
    status: "running",
    created_at: "2026-08-22T12:00:00Z",
    updated_at: "2026-08-22T12:00:03Z",
    script_path: "/state/workflows/scripts/audit.js",
    transcript_dir: "/state/workflows/runs/wf_1",
    events: [
      { version: 1, sequence: 1, kind: "phase", phase: "Scan" },
      {
        version: 1,
        sequence: 2,
        kind: "agent_started",
        phase: "Scan",
        label: "scan:api",
        call: 1,
      },
      {
        version: 1,
        sequence: 3,
        kind: "agent_progress",
        phase: "Scan",
        label: "scan:api",
        call: 1,
        tokens: 1200,
      },
      {
        version: 1,
        sequence: 4,
        kind: "agent_finished",
        phase: "Scan",
        label: "scan:api",
        call: 1,
        tokens: 1400,
      },
    ],
  },
} satisfies DagoWorkflowUpdate;

describe("makeDagoWorkflowProjector", () => {
  it.effect("projects coordinator phases, stable members, usage, and terminal state", () =>
    Effect.gen(function* () {
      const project = makeDagoWorkflowProjector();
      const events: DagoWorkflowProjectedEvent[] = [];
      const emit = (event: DagoWorkflowProjectedEvent) =>
        Effect.sync(() => {
          events.push(event);
        });

      yield* project(runningUpdate, emit);
      expect(events[0]).toMatchObject({
        type: "task.started",
        payload: {
          taskId: "workflow-1",
          taskType: "local_workflow",
          workflowName: "audit",
          phases: [
            { index: 0, title: "Scan" },
            { index: 1, title: "Verify" },
          ],
          runHandles: { runId: "wf_1", scriptPath: "/state/workflows/scripts/audit.js" },
        },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.progress",
          payload: expect.objectContaining({
            taskId: "workflow-1:wf:0",
            parentAgentId: "workflow-1",
            agentIndex: 0,
            phaseIndex: 0,
            status: "running",
            typedUsage: { totalTokens: 1200 },
            timelineBypass: true,
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "task.completed",
          payload: expect.objectContaining({
            taskId: "workflow-1:wf:0",
            status: "completed",
            typedUsage: { totalTokens: 1400 },
          }),
        }),
      );

      const beforeReplay = events.length;
      yield* project(runningUpdate, emit);
      expect(events).toHaveLength(beforeReplay);

      yield* project(
        {
          ...runningUpdate,
          workflow: {
            ...runningUpdate.workflow,
            status: "success",
            result: { version: 1, value: { findings: 2 }, agent_calls: 1, tokens: 1400 },
          },
        },
        emit,
      );
      expect(events.at(-1)).toMatchObject({
        type: "task.completed",
        payload: {
          taskId: "workflow-1",
          status: "completed",
          typedUsage: { totalTokens: 1400 },
          runHandles: { runId: "wf_1" },
        },
      });
    }),
  );
});
