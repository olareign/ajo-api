import type { EntityManager, QueryRunner } from "typeorm";

/**
 * Runs a parameterised statement inside a transaction and always returns its rows.
 * TypeORM's plain `query()` returns `[rows, rowCount]` for UPDATE and DELETE but bare
 * rows for SELECT and INSERT; the query runner's structured result removes that trap.
 */
export async function sql<T>(
  tx: Pick<EntityManager, "queryRunner">,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const runner: QueryRunner | undefined = tx.queryRunner;
  if (!runner) {
    throw new Error("sql() must run inside a transaction (EntityManager with a query runner)");
  }
  const result = await runner.query(text, params, true);
  return result.records as T[];
}
