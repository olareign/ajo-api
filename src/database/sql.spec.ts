import { sql } from "./sql.js";

describe("sql", () => {
  it("asks the query runner for a structured result and returns its rows", async () => {
    const query = vi.fn(async () => ({ records: [{ id: "1" }], affected: 1 }));
    const rows = await sql<{ id: string }>(
      { queryRunner: { query } } as never,
      "UPDATE t SET x = $1",
      [1],
    );
    expect(rows).toEqual([{ id: "1" }]);
    expect(query).toHaveBeenCalledWith("UPDATE t SET x = $1", [1], true);
  });

  it("refuses to run outside a transaction", async () => {
    await expect(sql({ queryRunner: undefined }, "SELECT 1")).rejects.toThrow(/transaction/);
  });
});
