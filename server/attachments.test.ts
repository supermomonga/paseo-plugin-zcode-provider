import { expect, it, vi } from "vitest";
import { uploadAttachments } from "./attachments.js";
import { FakeBridge, snapshot } from "../test/fake-host.js";
import { AdapterError } from "./errors.js";

it("uploads validated bytes in native chunks and sends only committed references", async () => {
  const host = new FakeBridge(snapshot("/workspace"));
  const bytes = Buffer.alloc(512 * 1024 + 1, 7);
  const refs = await uploadAttachments(
    host,
    "/workspace",
    "session-1",
    [
      {
        kind: "image",
        filename: "image.png",
        mimeType: "image/png",
        dataBase64: bytes.toString("base64"),
        sizeBytes: bytes.length,
      },
    ],
    () => {},
  );
  expect(refs).toEqual([
    {
      ref: expect.stringMatching(/^artifact:/),
      fileName: "image.png",
      mime: "image/png",
      bytes: bytes.length,
    },
  ]);
  expect(host.calls.map((c) => c.method)).toEqual([
    "attachmentBeginV4",
    "attachmentChunkV4",
    "attachmentChunkV4",
    "attachmentCommitV4",
  ]);
  expect(host.calls[0]!.params).toMatchObject({
    totalChunks: 2,
    totalBytes: bytes.length,
    checksum: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
  });
  const chunks = host.calls
    .filter((c) => c.method === "attachmentChunkV4")
    .map((c) =>
      Buffer.from((c.params as { dataBase64: string }).dataBase64, "base64"),
    );
  expect(Buffer.concat(chunks)).toEqual(bytes);
});
it.each(["size", "metadata", "base64"])(
  "rejects invalid %s before upload",
  (kind) => {
    const host = new FakeBridge(snapshot("/workspace"));
    const input = {
      kind: "image" as const,
      filename: "image.png",
      mimeType: "image/png",
      dataBase64: "dGVzdA==",
      sizeBytes: 4,
    };
    if (kind === "size") input.sizeBytes = 21 * 1024 * 1024;
    if (kind === "metadata") input.filename = "bad\nname";
    if (kind === "base64") input.dataBase64 = "%%%";
    return expect(
      uploadAttachments(host, "/workspace", "session-1", [input], () => {}),
    )
      .rejects.toMatchObject({ code: "UNSUPPORTED_CONTENT" })
      .then(() => expect(host.calls).toEqual([]));
  },
);
it("aborts staging on failure without retrying failed chunks", async () => {
  const host = new FakeBridge(snapshot("/workspace"));
  const original = host.request.bind(host);
  vi.spyOn(host, "request").mockImplementation(
    async (method, params, schema) => {
      if (method === "attachmentChunkV4") {
        host.calls.push({ method, params });
        throw new AdapterError("NATIVE_TIMEOUT", "No response");
      }
      return original(method, params, schema);
    },
  );
  await expect(
    uploadAttachments(
      host,
      "/workspace",
      "session-1",
      [
        {
          kind: "image",
          filename: "a.png",
          mimeType: "image/png",
          dataBase64: "dGVzdA==",
          sizeBytes: 4,
        },
      ],
      () => {},
    ),
  ).rejects.toMatchObject({ code: "NATIVE_TIMEOUT" });
  expect(host.calls.map((c) => c.method)).toEqual([
    "attachmentBeginV4",
    "attachmentChunkV4",
    "attachmentAbortV4",
  ]);
});
