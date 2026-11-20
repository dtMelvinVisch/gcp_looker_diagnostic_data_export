import { describe, expect, it } from "vitest";
import { catalog } from "../src/catalog";
import { countByMinute, detectLate } from "../src/late";

describe("late rows", () => {
  it("counts rows per minute and ignores invalid times", () => {
    const rows = [{ "history.created_time": "2026-11-18 10:00:05" }, { "history.created_time": "2026-11-18 10:00:59" }, { "history.created_time": "x" }];
    expect(Object.values(countByMinute(rows, catalog))).toEqual([2]);
  });
  it("only reports increases, with an upper-bound delay", () => {
    const m = Date.UTC(2026, 10, 18, 10, 0);
    const d = detectLate({ [m]: 2, [m + 60000]: 3 }, { [m]: 5, [m + 60000]: 3 }, m + 10 * 60_000);
    expect(d).toMatchObject({ late: 3, delayS: 540 });
    expect(Object.keys(d.updated)).toEqual([String(m)]);
  });
  it("fewer rows now (retention) is not late", () => {
    expect(detectLate({ "0": 5 }, {}, 1e12).late).toBe(0);
  });
});
