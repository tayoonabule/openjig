import { expect, it } from "vitest";
import { listNativeProcesses } from "../src/domain/native-process-lineage.js";

it("observes the real current process even with a British host time locale", async () => {
  const original = process.env.LC_ALL;
  process.env.LC_ALL = "en_GB.UTF-8";
  try {
    const rows = await listNativeProcesses();
    const current = rows.find(row => row.pid === process.pid);
    expect(current).toBeDefined();
    expect(current?.startedAt).toMatch(/^\w{3} \w{3}\s+\d+ \d{2}:\d{2}:\d{2} \d{4}$/);
    expect(process.env.LC_ALL).toBe("en_GB.UTF-8");
  } finally {
    if (original === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = original;
  }
});
