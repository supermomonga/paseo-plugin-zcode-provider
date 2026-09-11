import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { HostBridge } from "./host/bridge.js";
import type { NativePrompt } from "./mapping.js";
import { AdapterError } from "./errors.js";

const progress = z.object({
  uploadId: z.string(),
  nextChunkIndex: z.number().int().nonnegative(),
});
const begun = z.discriminatedUnion("state", [
  progress.extend({ state: z.literal("staging") }),
  progress.extend({ state: z.literal("committed"), ref: z.string().min(1) }),
]);
const reference = z.object({ ref: z.string().min(1) }).strict();
const metadata = z.object({
  fileName: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^\0\r\n]+$/),
  mime: z
    .string()
    .min(3)
    .max(255)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/,
    ),
  bytes: z
    .number()
    .int()
    .min(0)
    .max(20 * 1024 * 1024),
});
const chunkBytes = 512 * 1024;

/** Transfer validated input to ZCode's persisted attachment store before admission. */
export async function uploadAttachments(
  bridge: HostBridge,
  workspacePath: string,
  sessionId: string,
  attachments: NativePrompt["attachments"],
  assertSending: () => void,
) {
  const refs: Array<z.infer<typeof metadata> & { ref: string }> = [];
  for (const attachment of attachments) {
    assertSending();
    const info = metadata.safeParse({
      fileName: attachment.filename,
      mime: attachment.mimeType,
      bytes: attachment.sizeBytes,
    });
    if (!info.success)
      throw new AdapterError(
        "UNSUPPORTED_CONTENT",
        "Attachment exceeds ZCode's size limit or has invalid metadata",
      );
    if (
      !attachment.localPath &&
      (attachment.dataBase64 === undefined ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          attachment.dataBase64,
        ))
    )
      throw new AdapterError(
        "UNSUPPORTED_CONTENT",
        "Attachment has invalid base64 data",
      );
    const data = attachment.localPath
      ? await readFile(attachment.localPath)
      : Buffer.from(attachment.dataBase64!, "base64");
    if (data.length !== info.data.bytes)
      throw new AdapterError(
        "UNSUPPORTED_CONTENT",
        "Attachment changed after validation",
      );
    const uploadId = randomUUID();
    const target = { workspacePath, sessionId, uploadId };
    try {
      const start = await bridge.request(
        "attachmentBeginV4",
        {
          ...target,
          fileName: info.data.fileName,
          mime: info.data.mime,
          totalBytes: data.length,
          totalChunks: Math.ceil(data.length / chunkBytes),
          checksum: `sha256:${createHash("sha256").update(data).digest("hex")}`,
        },
        begun,
      );
      if (
        start.uploadId !== uploadId ||
        start.state !== "staging" ||
        start.nextChunkIndex !== 0
      )
        throw new AdapterError(
          "NATIVE_PROTOCOL_ERROR",
          "Unexpected attachment upload acknowledgement",
        );
      for (
        let offset = 0, chunkIndex = 0;
        offset < data.length;
        offset += chunkBytes, chunkIndex++
      ) {
        assertSending();
        const chunk = await bridge.request(
          "attachmentChunkV4",
          {
            ...target,
            chunkIndex,
            dataBase64: data
              .subarray(offset, offset + chunkBytes)
              .toString("base64"),
          },
          progress,
        );
        if (
          chunk.uploadId !== uploadId ||
          chunk.nextChunkIndex !== chunkIndex + 1
        )
          throw new AdapterError(
            "NATIVE_PROTOCOL_ERROR",
            "Unexpected attachment chunk acknowledgement",
          );
      }
      assertSending();
      const committed = await bridge.request(
        "attachmentCommitV4",
        target,
        reference,
      );
      refs.push({ ...info.data, ref: committed.ref });
    } catch (error) {
      // Abort staged bytes; never retry a command whose result is unknown.
      try {
        await bridge.request(
          "attachmentAbortV4",
          target,
          z.object({}).strict(),
        );
      } catch {
        /* The host expires staging storage after disconnection. */
      }
      throw error;
    }
  }
  return refs;
}
