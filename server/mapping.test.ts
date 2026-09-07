import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogModels,
  decodeModel,
  encodeModel,
  historyTimeline,
  mapMcpServers,
  mapPrompt,
  mapQuestionRequest,
  permissionActions,
  planMarkdown,
  questionContent,
} from "./mapping.js";
import type {
  PermissionRequest,
  SessionSettings,
  UserInputRequest,
} from "./protocol/v1/host-schemas.js";

const temporaryDirectories: string[] = [];

function settings(): SessionSettings {
  return {
    model: {
      current: { providerId: "anthropic", modelId: "claude", variant: "fast" },
      available: [
        {
          ref: { providerId: "anthropic", modelId: "claude", variant: "fast" },
          label: "ignored host label",
          providerLabel: "Anthropic",
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
    mode: { current: "plan" },
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
    const ref = { providerId: "anthropic", modelId: "claude", variant: "fast" };
    expect(decodeModel(encodeModel(ref))).toEqual(ref);
    expect(catalogModels(settings())).toEqual([
      expect.objectContaining({
        id: '["anthropic","claude","fast"]',
        label: "claude",
        description: "Anthropic",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "low", label: "Low", isDefault: false },
          { id: "high", label: "High", isDefault: true },
        ],
      }),
    ]);
  });

  it("uses the workspace default thought level before a session exists", () => {
    const value = settings();
    value.thoughtLevel.current = undefined;
    value.thoughtLevel.defaultLevel = "low";
    expect(catalogModels(value)[0]).toEqual(
      expect.objectContaining({
        defaultThinkingOptionId: "low",
        thinkingOptions: [
          { id: "low", label: "Low", isDefault: true },
          { id: "high", label: "High", isDefault: false },
        ],
      }),
    );
  });

  it("rejects duplicate models and unknown modes", () => {
    const value = settings();
    value.model.available.push({ ...value.model.available[0]! });
    expect(() => catalogModels(value)).toThrow(/Duplicate ZCode model/u);
    value.model.available.pop();
    value.mode.current = "future";
    expect(() => catalogModels(value)).toThrow(/unknown mode/u);
  });

  it("rejects an enabled thought-level catalog without a valid default", () => {
    const value = settings();
    value.thoughtLevel.current = undefined;
    value.thoughtLevel.defaultLevel = "future";
    expect(() => catalogModels(value)).toThrow(/default thinking option/u);
  });
});

describe("ZCode persisted history", () => {
  it("maps content in order and ignores only known host bookkeeping parts", () => {
    const timeline = historyTimeline({
      session: {
        sessionId: "session-1",
        status: "idle",
        workspace: { workspacePath: "/workspace" },
      },
      settings: settings(),
      messages: [
        {
          info: { messageId: "assistant-meta", role: "assistant" },
          parts: [{ type: "timeline", timelineType: "session_started" }],
        },
        {
          info: { messageId: "user-1", role: "user" },
          parts: [{ type: "text", text: "question" }],
        },
        {
          info: { messageId: "assistant-1", role: "assistant" },
          parts: [
            { type: "step-start" },
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "answer" },
            { type: "step-finish", reason: "stop" },
          ],
        },
      ],
      runtime: {},
      todos: [],
      slashCommands: [],
    });
    expect(timeline).toEqual([
      { type: "user_message", text: "question", messageId: "user-1" },
      { type: "reasoning", text: "thinking" },
      { type: "assistant_message", text: "answer", messageId: "assistant-1" },
      { type: "todo", items: [] },
    ]);
  });

  it("still fails closed for unknown persisted content", () => {
    const value = {
      session: {
        sessionId: "session-1",
        status: "idle",
        workspace: { workspacePath: "/workspace" },
      },
      settings: settings(),
      messages: [
        {
          info: { messageId: "assistant-1", role: "assistant" as const },
          parts: [{ type: "future-part" }],
        },
      ],
      runtime: {},
      slashCommands: [],
    };
    expect(() => historyTimeline(value)).toThrow(
      /Unsupported persisted message part/u,
    );
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

describe("ZCode interactions", () => {
  it("round-trips displayed question labels to native values", () => {
    const request = {
      requestId: "q1",
      sessionId: "s1",
      prompt: "Choose",
      questions: [
        {
          question: "Which mode?",
          header: "Mode",
          options: [
            { value: "fast", label: "Fast" },
            { value: "safe", label: "Safe" },
          ],
        },
        {
          question: "Features?",
          header: "Features",
          multiSelect: true,
          options: [
            { value: "tools", label: "Tools" },
            { value: "todos", label: "Todos" },
          ],
        },
      ],
    } satisfies UserInputRequest;
    const mapped = mapQuestionRequest(request, "question:q1");
    expect(mapped.request.kind).toBe("question");
    expect(
      questionContent(mapped.fields, {
        Mode: "Fast",
        Features: "Tools, Todos",
      }),
    ).toEqual({
      answer_0: "fast",
      answer_1: ["tools", "todos"],
      answer: "fast",
      answers: {
        "Which mode?": ["fast"],
        "Features?": ["tools", "todos"],
      },
    });
    expect(() => questionContent(mapped.fields, { Mode: "Unknown" })).toThrow(
      /unknown option/u,
    );
  });

  it("keeps native permission option IDs and requires plan allow and deny", () => {
    const request = {
      requestId: "p1",
      sessionId: "s1",
      toolCallId: "t1",
      toolName: "ExitPlanMode",
      reason: "Review",
      riskLevel: "low",
      input: { plan: "# Plan" },
      options: [
        {
          optionId: "approve-native",
          kind: "allow_once",
          name: "Approve",
          response: { decision: "allow" },
        },
        {
          optionId: "dismiss-native",
          kind: "deny_once",
          name: "Dismiss",
          response: { decision: "deny" },
        },
      ],
    } satisfies PermissionRequest;
    expect(permissionActions(request, true).map((action) => action.id)).toEqual(
      ["approve-native", "dismiss-native"],
    );
    expect(planMarkdown(request.input)).toBe("# Plan");
    expect(() =>
      permissionActions(
        { ...request, options: request.options.slice(0, 1) },
        true,
      ),
    ).toThrow(/allow and deny/u);
  });
});
