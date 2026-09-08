import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { SessionPersistenceStore, parsePersistence } from "./persistence.js";

it("writes durable mappings without changing identifiers and rejects damaged records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-state-test-"));
  try {
    const store = new SessionPersistenceStore(directory);
    const data = {
      kind: "logical" as const,
      id: randomUUID(),
      cwd: "/workspace",
    };
    expect(await store.resolve(data)).toBeUndefined();
    await store.save(data, "native-id");
    expect(await new SessionPersistenceStore(directory).resolve(data)).toBe(
      "native-id",
    );
    expect(await readdir(directory)).toEqual([`${data.id}.json`]);
    if (process.platform !== "win32")
      expect(
        (await stat(join(directory, `${data.id}.json`))).mode & 0o777,
      ).toBe(0o600);
    await expect(store.resolve({ ...data, cwd: "/another" })).rejects.toThrow(
      /another workspace/,
    );
    await writeFile(join(directory, `${data.id}.json`), "broken");
    await expect(store.resolve(data)).rejects.toThrow();
    expect(await readFile(join(directory, `${data.id}.json`), "utf8")).toBe(
      "broken",
    );
    expect(() =>
      parsePersistence({ version: 2, data: { ...data, id: "../outside" } }),
    ).toThrow();
    expect(
      await store.resolve({
        kind: "native",
        sessionId: "imported",
        cwd: data.cwd,
      }),
    ).toBe("imported");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
