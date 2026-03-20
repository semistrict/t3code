/**
 * Push message helpers for broadcasting to browser WebSocket clients.
 *
 * @module user-do/push
 */
import { Effect, ManagedRuntime, Schema } from "effect";
import {
  WsResponse,
  WsPush,
  type WsResponse as WsResponseMessage,
  type WsPushChannel,
  type WsPushData,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";

export const encodeWsResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));
const encodePush = Schema.encodeUnknownEffect(Schema.fromJsonString(WsPush));

export function broadcastPush<C extends WsPushChannel>(
  runtime: ManagedRuntime.ManagedRuntime<any, any>,
  clients: Set<WebSocket>,
  sequence: { value: number },
  channel: C,
  data: WsPushData<C>,
): void {
  const seq = ++sequence.value;
  const push: WsPushEnvelopeBase = { type: "push", sequence: seq, channel, data };

  void runtime.runPromise(
    encodePush(push).pipe(
      Effect.tap((msg) =>
        Effect.sync(() => {
          for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
              client.send(msg);
            }
          }
        }),
      ),
      Effect.ignore,
    ),
  );
}

export function sendPush<C extends WsPushChannel>(
  runtime: ManagedRuntime.ManagedRuntime<any, any>,
  sequence: { value: number },
  ws: WebSocket,
  channel: C,
  data: WsPushData<C>,
): void {
  const seq = ++sequence.value;
  const push: WsPushEnvelopeBase = { type: "push", sequence: seq, channel, data };

  void runtime.runPromise(
    encodePush(push).pipe(
      Effect.tap((msg) => Effect.sync(() => ws.send(msg))),
      Effect.ignore,
    ),
  );
}

export function sendError(
  runtime: ManagedRuntime.ManagedRuntime<any, any> | null,
  ws: WebSocket,
  id: string,
  message: string,
): void {
  if (runtime) {
    const response: WsResponseMessage = { id, error: { message } };
    void runtime.runPromise(
      encodeWsResponse(response).pipe(
        Effect.tap((msg) => Effect.sync(() => ws.send(msg))),
        Effect.ignore,
      ),
    );
  } else {
    ws.send(JSON.stringify({ id, error: { message } }));
  }
}
