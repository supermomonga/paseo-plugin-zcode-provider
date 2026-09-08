import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProviderPersistence } from "@getpaseo/plugin/server/provider";
import { AdapterError } from "./errors.js";

const workspace = z.string().min(1);
const dataSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("logical"), id: z.uuid(), cwd: workspace })
    .strict(),
  z
    .object({
      kind: z.literal("native"),
      sessionId: z.string().min(1),
      cwd: workspace,
    })
    .strict(),
]);
const recordSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    cwd: workspace,
  })
  .strict();
export type PersistenceData = z.infer<typeof dataSchema>;

export function parsePersistence(handle: ProviderPersistence): PersistenceData {
  if (handle.version !== 2)
    throw new AdapterError(
      "PERSISTENCE_VERSION_UNSUPPORTED",
      "Unsupported ZCode persistence version; expected version 2",
    );
  try {
    return dataSchema.parse(handle.data);
  } catch {
    throw new AdapterError(
      "PERSISTENCE_INVALID",
      "Invalid ZCode persistence handle",
    );
  }
}

export function persistenceHandle(data: PersistenceData): ProviderPersistence {
  return { version: 2, data };
}

// Outside the plugin checkout: reinstalling/building the plugin must not erase handles.
export class SessionPersistenceStore {
  constructor(
    readonly directory = join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "paseo-plugin-zcode-provider",
      "sessions",
    ),
  ) {}

  private filename(id: string): string {
    return join(this.directory, `${z.uuid().parse(id)}.json`);
  }

  async resolve(data: PersistenceData): Promise<string | undefined> {
    if (data.kind === "native") return data.sessionId;
    let content: string;
    try {
      content = await readFile(this.filename(data.id), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Cannot read ZCode persistence record",
        {},
        { cause: error },
      );
    }
    let record: z.infer<typeof recordSchema>;
    try {
      record = recordSchema.parse(JSON.parse(content));
    } catch (error) {
      throw new AdapterError(
        "PERSISTENCE_INVALID",
        "Invalid ZCode persistence record",
        {},
        { cause: error },
      );
    }
    if (record.cwd !== data.cwd)
      throw new AdapterError(
        "INVALID_WORKSPACE",
        "ZCode persistence belongs to another workspace",
      );
    return record.sessionId;
  }

  async save(data: PersistenceData, sessionId: string): Promise<void> {
    if (data.kind === "native") return;
    const record = recordSchema.parse({ version: 1, sessionId, cwd: data.cwd });
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.write(data.id, record);
    } catch (error) {
      throw new AdapterError(
        "PERSISTENCE_WRITE_FAILED",
        "Cannot save ZCode resume information; prompt was not sent",
        {},
        { cause: error },
      );
    }
  }

  private async write(
    id: string,
    record: z.infer<typeof recordSchema>,
  ): Promise<void> {
    const destination = this.filename(id);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(record));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, destination);
      // Windows does not support opening directories for fsync.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
