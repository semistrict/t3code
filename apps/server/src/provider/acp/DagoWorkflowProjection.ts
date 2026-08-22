import {
  RuntimeTaskId,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const DAGO_WORKFLOW_UPDATE_METHOD = "_dago/workflow/update";
export const DAGO_WORKFLOW_CANCEL_METHOD = "_dago/workflow/cancel";
export const DAGO_WORKFLOW_LIST_METHOD = "_dago/workflow/list";

const DagoWorkflowPhase = Schema.Struct({
  title: Schema.String,
  detail: Schema.optional(Schema.String),
});

const DagoWorkflowEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: Schema.Int,
  kind: Schema.Literals([
    "phase",
    "log",
    "agent_started",
    "agent_progress",
    "agent_finished",
    "agent_failed",
  ]),
  phase: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  call: Schema.optional(Schema.Int),
  tokens: Schema.optional(Schema.Int),
  timestamp: Schema.optional(Schema.String),
  cached: Schema.optional(Schema.Boolean),
});

const DagoWorkflowResult = Schema.Struct({
  version: Schema.Literal(1),
  value: Schema.Unknown,
  agent_calls: Schema.Number,
  tokens: Schema.Number,
});

export const DagoWorkflowStatus = Schema.Struct({
  version: Schema.Literal(1),
  task_id: Schema.String,
  run_id: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  phases: Schema.optional(Schema.Array(DagoWorkflowPhase)),
  status: Schema.Literals(["running", "success", "cancelled", "error"]),
  created_at: Schema.String,
  updated_at: Schema.String,
  events: Schema.optional(Schema.Array(DagoWorkflowEvent)),
  result: Schema.optional(DagoWorkflowResult),
  error: Schema.optional(Schema.String),
  script_path: Schema.optional(Schema.String),
  transcript_dir: Schema.optional(Schema.String),
  output_path: Schema.optional(Schema.String),
});

export const DagoWorkflowUpdate = Schema.Struct({
  version: Schema.Literal(1),
  session_id: Schema.String,
  workflow: DagoWorkflowStatus,
});
export type DagoWorkflowUpdate = typeof DagoWorkflowUpdate.Type;

export const DagoWorkflowListResponse = Schema.Struct({
  version: Schema.Literal(1),
  workflows: Schema.Array(DagoWorkflowStatus),
});

export type DagoWorkflowProjectedEvent =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

interface WorkflowProjectionState {
  lastSequence: number;
  coordinatorStarted: boolean;
  coordinatorCompleted: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function nonNegativeInt(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function makeDagoWorkflowProjector() {
  const runs = new Map<string, WorkflowProjectionState>();

  return <E>(
    update: DagoWorkflowUpdate,
    emit: (event: DagoWorkflowProjectedEvent) => Effect.Effect<void, E>,
  ): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      const workflow = update.workflow;
      const state = runs.get(workflow.run_id) ?? {
        lastSequence: 0,
        coordinatorStarted: false,
        coordinatorCompleted: false,
      };
      runs.set(workflow.run_id, state);
      const phases = (workflow.phases ?? []).map((phase, index) => ({
        index,
        title: nonEmpty(phase.title) ?? `Phase ${index + 1}`,
      }));
      const runHandles = {
        runId: workflow.run_id,
        ...(nonEmpty(workflow.script_path) ? { scriptPath: workflow.script_path } : {}),
        ...(nonEmpty(workflow.transcript_dir) ? { transcriptDir: workflow.transcript_dir } : {}),
      };

      if (!state.coordinatorStarted) {
        state.coordinatorStarted = true;
        yield* emit({
          type: "task.started",
          payload: {
            taskId: RuntimeTaskId.make(workflow.task_id),
            description: nonEmpty(workflow.description),
            taskType: "local_workflow",
            title: nonEmpty(workflow.name) ?? workflow.task_id,
            workflowName: nonEmpty(workflow.name),
            ...(phases.length > 0 ? { phases } : {}),
            runHandles,
          },
        });
      }

      for (const event of workflow.events ?? []) {
        if (event.sequence <= state.lastSequence) continue;
        state.lastSequence = Math.max(state.lastSequence, event.sequence);
        const label = nonEmpty(event.label) ?? `agent ${event.call ?? ""}`.trim();
        const phaseIndex = event.phase
          ? phases.findIndex((phase) => phase.title === event.phase)
          : -1;
        const call = nonNegativeInt(event.call);
        const agentIndex = call === undefined ? undefined : Math.max(0, call - 1);
        const memberTaskId = RuntimeTaskId.make(
          `${workflow.task_id}:wf:${agentIndex ?? Math.max(0, event.sequence - 1)}`,
        );
        const memberLinkage = {
          parentAgentId: workflow.task_id,
          ...(agentIndex !== undefined ? { agentIndex } : {}),
          ...(phaseIndex >= 0 ? { phaseIndex } : {}),
          ...(nonEmpty(event.phase) ? { phaseTitle: event.phase } : {}),
          timelineBypass: true,
        };
        const typedUsage =
          nonNegativeInt(event.tokens) !== undefined
            ? { totalTokens: nonNegativeInt(event.tokens)! }
            : undefined;

        switch (event.kind) {
          case "agent_started":
          case "agent_progress":
            yield* emit({
              type: "task.progress",
              payload: {
                taskId: memberTaskId,
                description: label,
                title: label,
                status: "running",
                ...(typedUsage ? { typedUsage } : {}),
                ...memberLinkage,
              },
            });
            break;
          case "agent_finished":
            yield* emit({
              type: "task.completed",
              payload: {
                taskId: memberTaskId,
                status: "completed",
                summary: nonEmpty(event.message),
                ...(typedUsage ? { typedUsage } : {}),
                ...memberLinkage,
              },
            });
            break;
          case "agent_failed":
            yield* emit({
              type: "task.completed",
              payload: {
                taskId: memberTaskId,
                status: "failed",
                summary: nonEmpty(event.message),
                ...(typedUsage ? { typedUsage } : {}),
                ...memberLinkage,
              },
            });
            break;
          case "phase":
          case "log":
            yield* emit({
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.make(workflow.task_id),
                description: nonEmpty(workflow.description) ?? workflow.name,
                summary: nonEmpty(event.message) ?? nonEmpty(event.phase),
                status: "running",
                taskType: "local_workflow",
                workflowName: nonEmpty(workflow.name),
                ...(phases.length > 0 ? { phases } : {}),
                runHandles,
              },
            });
            break;
        }
      }

      if (workflow.status !== "running" && !state.coordinatorCompleted) {
        state.coordinatorCompleted = true;
        const status =
          workflow.status === "success"
            ? "completed"
            : workflow.status === "cancelled"
              ? "stopped"
              : "failed";
        yield* emit({
          type: "task.completed",
          payload: {
            taskId: RuntimeTaskId.make(workflow.task_id),
            status,
            summary:
              nonEmpty(workflow.error) ??
              (status === "completed"
                ? `${workflow.name} completed`
                : `${workflow.name} ${status}`),
            ...(workflow.result && nonNegativeInt(workflow.result.tokens) !== undefined
              ? { typedUsage: { totalTokens: nonNegativeInt(workflow.result.tokens)! } }
              : {}),
            taskType: "local_workflow",
            workflowName: nonEmpty(workflow.name),
            ...(phases.length > 0 ? { phases } : {}),
            runHandles,
          },
        });
      }
    });
}
