import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI from "../index.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

type Harness = {
  ctx: ExtensionContext;
  handlers: Map<string, EventHandler[]>;
  setFooter: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-footer-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(cwd: string, footerMode: "replace" | "status" | "off") {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: false,
        active: false,
        desiredActive: false,
        supportedModels: [],
        usage: { enabled: false },
        footer: { mode: footerMode },
        image: { enabled: false },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createHarness(cwd: string): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const setFooter = vi.fn();
  const setStatus = vi.fn();

  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd,
    hasUI: false,
    signal: undefined,
    model: undefined,
    ui: {
      notify: vi.fn(),
      setFooter,
      setStatus,
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterOpenAI(pi);

  return { ctx, handlers, setFooter, setStatus };
}

async function emit(harness: Harness, event: string, payload: unknown = {}) {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("footer mode ownership", () => {
  test("off mode leaves existing footer customizations untouched on session start", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "off");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("status mode does not clear an external custom footer", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
  });

  test("off mode clears the Better OpenAI footer only after Better OpenAI installed it", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(1);
    expect(harness.setFooter).toHaveBeenLastCalledWith(expect.any(Function));

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    expect(harness.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("off mode does not clear a footer after Better OpenAI's footer was disposed", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    expect(footerFactory).toEqual(expect.any(Function));

    const footer = footerFactory(
      { requestRender: vi.fn() },
      {},
      { onBranchChange: vi.fn(() => vi.fn()) },
    );
    footer.dispose();

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(1);
  });
});
