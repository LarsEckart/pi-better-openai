import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, relative } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import sharp from "sharp";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _test } from "../index.ts";
import { registerOpenAIImage } from "../src/image.ts";
import { makeResolvedConfig } from "./helpers.ts";

vi.mock("../src/usage.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/usage.ts")>();
  return { ...actual, readCodexAuth: vi.fn(() => undefined) };
});

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  ctx: ExtensionContext,
) => Promise<{ content: unknown[]; details?: unknown }>;

type RegisteredTool = {
  name: string;
  execute: ToolExecute;
};

type ImageHarness = {
  ctx: ExtensionContext;
  tool: RegisteredTool;
  getDebug: Awaited<ReturnType<typeof registerOpenAIImage>>["getDebug"];
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-image-"));
  tempDirs.push(cwd);
  return cwd;
}

function sseResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function finalImageEvent(id = "ig_test", data = "Zm9v") {
  return {
    type: "response.output_item.done",
    item: { type: "image_generation_call", id, status: "completed", result: data },
  };
}

async function writeTinyPng(path: string): Promise<void> {
  await sharp({
    create: {
      width: 1,
      height: 1,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toFile(path);
}

function createImageHarness(
  options: {
    cwd?: string;
    registryCredentials?: string | undefined;
    imageConfig?: Partial<typeof _test.DEFAULT_IMAGE_CONFIG>;
  } = {},
): ImageHarness {
  const cwd = options.cwd ?? createTempProject();
  let registeredTool: RegisteredTool | undefined;
  const pi = {
    registerTool: vi.fn((tool: RegisteredTool) => {
      registeredTool = tool;
    }),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    signal: undefined,
    model: { provider: "openai-codex", id: "gpt-5.5" },
    ui: { notify: vi.fn(), setFooter: vi.fn(), setStatus: vi.fn() },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      getApiKeyForProvider: vi.fn(() => Promise.resolve(options.registryCredentials)),
      isUsingOAuth: vi.fn(() => true),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;
  const cfg = makeResolvedConfig({
    image: {
      ..._test.DEFAULT_IMAGE_CONFIG,
      enabled: true,
      defaultSave: "none",
      ...options.imageConfig,
    },
  });
  const debug = registerOpenAIImage(pi, () => cfg);
  if (!registeredTool) throw new Error("openai_image tool was not registered.");
  return { ctx, tool: registeredTool, getDebug: debug.getDebug };
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function executeImageTool(harness: ImageHarness, params: Record<string, unknown>) {
  return harness.tool.execute("tool-call-1", params, undefined, vi.fn(), harness.ctx);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("image helpers", () => {
  test("exposes image tool defaults", () => {
    expect(_test.imageTest.OPENAI_IMAGE_TOOL).toBe("openai_image");
  });

  test("detects image mime types and display paths", () => {
    expect(_test.imageTest.imageMimeType("x.jpg")).toBe("image/jpeg");
    expect(_test.imageTest.displayPath(join(homedir(), "dev", "image.png"))).toBe(
      "~/dev/image.png",
    );
  });

  test("extracts prompts and data URLs", () => {
    expect(
      _test.imageTest.latestUserPromptFromEntries([
        { type: "message", message: { role: "user", content: "draw a dog" } },
      ]),
    ).toBe("draw a dog");
    expect(_test.imageTest.dataUrlParts("data:image/png;base64,Zm9v", "image/png")).toEqual({
      data: "Zm9v",
      mimeType: "image/png",
    });
  });

  test("extracts image generation results from response events", () => {
    const extracted = _test.imageTest.extractImageFromEvent(
      {
        type: "response.output_item.done",
        item: { type: "image_generation_call", id: "ig_1", status: "completed", result: "Zm9v" },
      },
      "image/png",
    );
    expect(extracted?.data).toBe("Zm9v");
  });

  test("builds image generation requests", () => {
    expect(
      _test.imageTest.buildRequest(
        { prompt: "draw an otter" },
        "gpt-5.5",
        makeResolvedConfig({ image: _test.DEFAULT_IMAGE_CONFIG }),
        [],
      ).tool_choice,
    ).toEqual({ type: "image_generation" });
  });
});

describe("openai_image tool execution", () => {
  test("executes through the registered tool and sends a Codex image request", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    const result = await executeImageTool(harness, { prompt: "draw an otter", save: "none" });

    expect(harness.tool.name).toBe("openai_image");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(_test.imageTest.CODEX_RESPONSES_URL);
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-access",
      "chatgpt-account-id": "acct_test",
    });
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.5",
      tool_choice: { type: "image_generation" },
    });
    expect(body.input).toMatchObject([
      { role: "user", content: [{ type: "input_text", text: "draw an otter" }] },
    ]);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("Generated image") },
      { type: "image", data: "Zm9v", mimeType: "image/png" },
    ]);
    expect(result.details).toMatchObject({ id: "ig_test", data: "Zm9v", savedPath: undefined });
  });

  test("uploads project-local reference images and saves generated output to the project", async () => {
    const cwd = createTempProject();
    const relativeInput = join(cwd, "input.png");
    const absoluteInput = join(cwd, "absolute.png");
    await writeTinyPng(relativeInput);
    await writeTinyPng(absoluteInput);
    const relativeData = readFileSync(relativeInput).toString("base64");
    const absoluteData = readFileSync(absoluteInput).toString("base64");
    const fetchMock = stubFetch(sseResponse([finalImageEvent("ig_saved", "Zm9v")]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
      imageConfig: { defaultSave: "project" },
    });

    const result = await executeImageTool(harness, {
      prompt: "edit it",
      images: ["input.png", absoluteInput],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { input: Array<{ content: unknown[] }> };
    expect(body.input[0]?.content).toEqual([
      { type: "input_text", text: "edit it" },
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${relativeData}`,
      },
      {
        type: "input_image",
        detail: "auto",
        image_url: `data:image/png;base64,${absoluteData}`,
      },
    ]);
    const outputDir = join(cwd, ".pi", "generated-images");
    const files = readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^openai-image-.*-ig_saved\.png$/);
    expect(readFileSync(join(outputDir, files[0]!)).toString("base64")).toBe("Zm9v");
    expect(result.details).toMatchObject({ savedPath: join(outputDir, files[0]!) });
  });

  test("rejects image paths outside the workspace before upload", async () => {
    const cwd = createTempProject();
    const outsideDir = createTempProject();
    const outsideImage = join(outsideDir, "outside.png");
    await writeTinyPng(outsideImage);
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "draw", images: [outsideImage] }),
    ).rejects.toThrow("Image input must be a file inside the current workspace");
    await expect(
      executeImageTool(harness, { prompt: "draw", images: [relative(cwd, outsideImage)] }),
    ).rejects.toThrow("Image input must be a file inside the current workspace");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects directory image inputs before upload", async () => {
    const cwd = createTempProject();
    mkdirSync(join(cwd, "images"));
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(executeImageTool(harness, { prompt: "draw", images: ["images"] })).rejects.toThrow(
      "Image input must be a file inside the current workspace",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects non-image files before upload", async () => {
    const cwd = createTempProject();
    writeFileSync(join(cwd, "notes.txt"), "not an image", "utf8");
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "draw", images: ["notes.txt"] }),
    ).rejects.toThrow("Image input is not a readable image");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects oversized image inputs before upload", async () => {
    const cwd = createTempProject();
    const largeImage = join(cwd, "large.png");
    writeFileSync(largeImage, "");
    truncateSync(largeImage, _test.imageTest.MAX_IMAGE_INPUT_BYTES + 1);
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      cwd,
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(
      executeImageTool(harness, { prompt: "draw", images: ["large.png"] }),
    ).rejects.toThrow("Image input is too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects when image generation is disabled before calling fetch", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
      imageConfig: { enabled: false },
    });

    await expect(executeImageTool(harness, { prompt: "draw" })).rejects.toThrow(
      "OpenAI image generation is disabled in config.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects when Codex credentials are missing before calling fetch", async () => {
    const fetchMock = stubFetch(sseResponse([finalImageEvent()]));
    const harness = createImageHarness({ registryCredentials: undefined });

    await expect(executeImageTool(harness, { prompt: "draw" })).rejects.toThrow(
      "Missing openai-codex OAuth credentials.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects non-OK Codex responses", async () => {
    const fetchMock = stubFetch(new Response("upstream nope", { status: 500, statusText: "Nope" }));
    const harness = createImageHarness({
      registryCredentials: JSON.stringify({ access: "test-access", accountId: "acct_test" }),
    });

    await expect(executeImageTool(harness, { prompt: "draw" })).rejects.toThrow(
      "Codex image request failed (500)",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
