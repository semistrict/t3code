/**
 * DO SQLite Client - Effect SqlClient adapter for Cloudflare DO SqlStorage.
 *
 * Wraps the Durable Object's built-in `ctx.storage.sql` (SqlStorage) behind
 * Effect's `SqlClient` interface so the orchestration persistence layer can
 * run unchanged inside a Durable Object.
 *
 * @module DoSqliteClient
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as ServiceMap from "effect/ServiceMap";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";
import { identity } from "effect/Function";

/**
 * Minimal subset of Cloudflare DO SqlStorage that we use.
 * This avoids importing Cloudflare types at the module level.
 */
export interface DoSqlStorage {
  exec<T = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: unknown[]
  ): DoSqlCursor<T>;
}

type SqlStorageValue = string | number | null | ArrayBuffer;

interface DoSqlCursor<T> {
  readonly columnNames: readonly string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  toArray(): T[];
  one(): T;
  [Symbol.iterator](): IterableIterator<T>;
}

/**
 * Create an Effect SqlClient backed by a DO SqlStorage instance.
 */
const make = (sql: DoSqlStorage): Effect.Effect<Client.SqlClient, never, Reactivity.Reactivity> =>
  Effect.gen(function* () {
    const compiler = Statement.makeCompilerSqlite();

    // DO SqlStorage forbids BEGIN/COMMIT/ROLLBACK/SAVEPOINT — it manages
    // transactions via ctx.storage.transactionSync(). Writes within a single
    // DO handler invocation are automatically atomic, so we can safely no-op
    // these statements. If the handler throws, uncommitted writes are discarded.
    const TX_PATTERN = /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i;

    const run = (
      query: string,
      params: ReadonlyArray<unknown>,
    ): Effect.Effect<ReadonlyArray<any>, SqlError> => {
      if (TX_PATTERN.test(query)) {
        return Effect.succeed([]);
      }
      return Effect.try({
        try: () => {
          const cursor = sql.exec(query, ...params);
          return cursor.toArray();
        },
        catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
      });
    };

    const connection = identity<Connection>({
      execute(query, params, rowTransform) {
        return rowTransform
          ? Effect.map(run(query, params), rowTransform)
          : run(query, params);
      },
      executeRaw(query, params) {
        return run(query, params);
      },
      executeValues(query, params) {
        return Effect.try({
          try: () => {
            const cursor = sql.exec(query, ...params);
            const columns = cursor.columnNames;
            const rows: unknown[][] = [];
            for (const row of cursor) {
              const values: unknown[] = [];
              for (const col of columns) {
                values.push((row as Record<string, unknown>)[col]);
              }
              rows.push(values);
            }
            return rows as ReadonlyArray<ReadonlyArray<unknown>>;
          },
          catch: (cause) => new SqlError({ cause, message: "Failed to execute statement" }),
        });
      },
      executeUnprepared(query, params, rowTransform) {
        const effect = run(query, params ?? []);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_query, _params) {
        return Stream.die("executeStream not implemented for DO SqlStorage");
      },
    });

    const semaphore = yield* Semaphore.make(1);
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
    const transactionAcquirer = acquirer;

    return yield* Client.make({
      acquirer,
      compiler,
      transactionAcquirer,
      spanAttributes: [["db.system.name", "sqlite"]],
    });
  });

/**
 * Create a Layer that provides SqlClient backed by DO SqlStorage.
 */
export const layer = (sql: DoSqlStorage): Layer.Layer<Client.SqlClient> =>
  Layer.effectServices(
    Effect.map(make(sql), (client) =>
      ServiceMap.make(Client.SqlClient, client),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
