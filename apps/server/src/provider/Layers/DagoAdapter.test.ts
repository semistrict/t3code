import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "@effect/vitest";

import {
  DAGO_WORKFLOW_CANCEL_METHOD,
  DAGO_WORKFLOW_LIST_METHOD,
} from "../acp/DagoWorkflowProjection.ts";
import { cancelRunningDagoWorkflows } from "./DagoAdapter.ts";

const workflow = (runId: string, status: string) => ({
  version: 1,
  task_id: `task-${runId}`,
  run_id: runId,
  name: runId,
  status,
  created_at: "2026-08-22T12:00:00Z",
  updated_at: "2026-08-22T12:00:01Z",
});

describe("cancelRunningDagoWorkflows", () => {
  it.effect("lists the session and cancels every running workflow", () =>
    Effect.gen(function* () {
      const request = vi.fn((method: string) =>
        Effect.succeed(
          method === DAGO_WORKFLOW_LIST_METHOD
            ? {
                version: 1,
                workflows: [
                  workflow("wf-running-1", "running"),
                  workflow("wf-done", "success"),
                  workflow("wf-running-2", "running"),
                ],
              }
            : { version: 1, status: "cancelling" },
        ),
      );

      yield* cancelRunningDagoWorkflows({ request } as never, "session-1");

      expect(request).toHaveBeenNthCalledWith(1, DAGO_WORKFLOW_LIST_METHOD, {
        version: 1,
        session_id: "session-1",
      });
      expect(request).toHaveBeenNthCalledWith(2, DAGO_WORKFLOW_CANCEL_METHOD, {
        version: 1,
        session_id: "session-1",
        run_id: "wf-running-1",
      });
      expect(request).toHaveBeenNthCalledWith(3, DAGO_WORKFLOW_CANCEL_METHOD, {
        version: 1,
        session_id: "session-1",
        run_id: "wf-running-2",
      });
      expect(request).toHaveBeenCalledTimes(3);
    }),
  );

  it.effect("rejects workflow lists from an unsupported protocol version", () =>
    Effect.gen(function* () {
      const error = yield* cancelRunningDagoWorkflows(
        { request: () => Effect.succeed({ version: 2, workflows: [] }) } as never,
        "session-1",
      ).pipe(Effect.flip);

      expect(error._tag).toBe("AcpTransportError");
    }),
  );
});
