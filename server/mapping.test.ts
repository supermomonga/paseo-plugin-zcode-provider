import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogModels,
  requireMode,
  decodeModel,
  encodeModel,
  mapMcpServers,
  mapPrompt,
  planMarkdown,
} from "./mapping.js";
import type { SessionSettings } from "./host/schemas.js";

const temporaryDirectories: string[] = [];

function settings(): SessionSettings {
  return {
    model: {
      current: {
        providerId: "anthropic",
        modelId: "claude",
        options: { reasoningLevel: "high" },
      },
      available: [
        {
          ref: { providerId: "anthropic", modelId: "claude" },
          label: "ignored host label",
          providerLabel: "Anthropic",
          reasoningLevels: ["low", "high"],
        },
      ],
    },
    thoughtLevel: {
      enabled: true,
      current: "high",
      defaultLevel: "low",
      available: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    },
    mode: { current: "build" },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ZCode catalog mapping", () => {
  it("uses a reversible model tuple and the native thought-level catalog", () => {
    const ref = { providerId: "anthropic", modelId: "claude" };
    expect(decodeModel(encodeModel(ref))).toEqual(ref);
    expect(
      catalogModels(settings().model.available, settings().model.current),
    ).toEqual([
      expect.objectContaining({
        id: '["anthropic","claude",null]',
        label: "claude",
        description: "Anthropic",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "low", label: "low", isDefault: false },
          { id: "high", label: "high", isDefault: true },
        ],
      }),
    ]);
  });

  it("uses the preferred selection reasoning level before a session exists", () => {
    const value = settings();
    value.thoughtLevel.current = undefined;
    value.model.current!.options = { reasoningLevel: "low" };
    expect(
      catalogModels(value.model.available, value.model.current)[0],
    ).toEqual(
      expect.objectContaining({
        defaultThinkingOptionId: "low",
        thinkingOptions: [
          { id: "low", label: "low", isDefault: true },
          { id: "high", label: "high", isDefault: false },
        ],
      }),
    );
  });

  it("rejects duplicate models and unknown modes", () => {
    const value = settings();
    value.model.available.push({ ...value.model.available[0]! });
    expect(() =>
      catalogModels(value.model.available, value.model.current),
    ).toThrow(/Duplicate ZCode model/u);
    value.model.available.pop();
    value.mode.current = "future";
    expect(() => requireMode(value.mode.current)).toThrow(/unknown mode/u);
  });
});

describe("ZCode prompt and MCP mapping", () => {
  it("maps files only after canonical workspace containment checks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "zcode-workspace-"));
    temporaryDirectories.push(workspace);
    const nested = join(workspace, "files");
    await mkdir(nested);
    const file = join(nested, "sample.wav");
    await writeFile(file, "audio");

    await expect(
      mapPrompt(
        [
          { type: "text", text: "inspect" },
          {
            type: "uploaded_file",
            id: "1",
            fileName: "sample.wav",
            mimeType: "audio/wav",
            size: 5,
            path: file,
          },
        ],
        workspace,
      ),
    ).resolves.toEqual({
      content: "inspect",
      attachments: [
        {
          kind: "audio",
          filename: "sample.wav",
          mimeType: "audio/wav",
          localPath: await realpath(file),
          sizeBytes: 5,
        },
      ],
    });
    await expect(
      mapPrompt(
        [
          {
            type: "uploaded_file",
            id: "2",
            fileName: "outside",
            mimeType: "text/plain",
            size: 1,
            path: "/etc/hosts",
          },
        ],
        workspace,
      ),
    ).rejects.toThrow(/inside the workspace/u);
  });

  it("losslessly maps supported MCP transports and rejects unsupported fields", () => {
    expect(
      mapMcpServers({
        local: {
          type: "stdio",
          command: "/usr/bin/env",
          args: ["node"],
          env: { A: "B" },
        },
        remote: {
          type: "http",
          url: "https://example.test/mcp",
          headers: { Authorization: "placeholder" },
        },
      }),
    ).toEqual([
      {
        name: "local",
        command: "/usr/bin/env",
        args: ["node"],
        env: [{ name: "A", value: "B" }],
      },
      {
        type: "http",
        name: "remote",
        url: "https://example.test/mcp",
        headers: [{ name: "Authorization", value: "placeholder" }],
      },
    ]);
    expect(() =>
      mapMcpServers({
        unsupported: {
          type: "stdio",
          command: "/bin/echo",
          alwaysLoad: true,
        },
      }),
    ).toThrow(/alwaysLoad/u);
  });
});

it("rejects variant IDs instead of converting them to reasoning levels", () => {
  expect(() => decodeModel('["provider","model","high"]')).toThrow(
    /Invalid ZCode model ID/,
  );
  expect(
    encodeModel({
      providerId: "provider",
      modelId: "model",
      options: { reasoningLevel: "high" },
    }),
  ).toBe('["provider","model",null]');
});
