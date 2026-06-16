import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, test, vi } from "vitest";
import { _test } from "../index.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "../src/format.ts";

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: ExtensionContext) => unknown | Promise<unknown>;

type UsageHarness = {
  ctx: ExtensionContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, { handler: CommandHandler }>;
};

const tempDirs: string[] = [];
const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeCodexAuth(agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    `${JSON.stringify(
      {
        "openai-codex": {
          type: "oauth",
          access: "usage-access",
          accountId: "acct_usage",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeProjectConfig(cwd: string, config: Record<string, unknown>): void {
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
        usage: { enabled: true, refreshIntervalMs: 60000 },
        footer: { mode: "status" },
        image: { enabled: false },
        pets: { enabled: false },
        ...config,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function usageResponseBody() {
  return {
    rate_limit: {
      allowed: true,
      primary_window: { used_percent: 10, reset_after_seconds: 60 },
      secondary_window: { used_percent: 20, reset_after_seconds: 3600 },
    },
  };
}

function usageJsonResponse(): Response {
  return new Response(JSON.stringify(usageResponseBody()));
}

function stubUsageFetch(response: Response | (() => Response)): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve(typeof response === "function" ? response() : response),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function importUsageWithAgentDir(agentDir: string) {
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  return import("../src/usage.ts");
}

async function createUsageHarness(options: {
  usageConfig?: Record<string, unknown>;
  model?: ExtensionContext["model"];
  isUsingOAuth?: boolean;
  writeAuth?: boolean;
  signal?: AbortSignal;
}): Promise<UsageHarness> {
  const cwd = createTempDir("pi-better-openai-usage-project-");
  const agentDir = createTempDir("pi-better-openai-usage-agent-");
  if (options.writeAuth !== false) writeCodexAuth(agentDir);
  writeProjectConfig(cwd, {
    usage: options.usageConfig ?? { enabled: true, refreshIntervalMs: 60000 },
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  vi.resetModules();
  const { default: betterOpenAI } = await import("../index.ts");

  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();
  const pi = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: true,
    signal: options.signal,
    model: options.model ?? { provider: "openai", id: "gpt-5.5" },
    ui: {
      notify: vi.fn(),
      setFooter: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => options.isUsingOAuth ?? true),
      getApiKeyForProvider: vi.fn(() => Promise.resolve(undefined)),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  } as unknown as ExtensionContext;

  betterOpenAI(pi);
  return { ctx, handlers, commands };
}

async function emit(harness: UsageHarness, event: string, payload: unknown = {}): Promise<void> {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload, harness.ctx);
  }
}

async function settleAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("usage helpers", () => {
  test("masks and sanitizes diagnostic identifiers", () => {
    expect(maskIdentifier("acct_1234567890abcdef")).toBe("acct...cdef");

    const sanitized = sanitizeDiagnosticError(
      `\u001b[31mAuthorization: Bearer sk-secretsecret accountId=acct_1234567890abcdef ${"x".repeat(700)}`,
    );

    expect(sanitized).not.toContain("\u001b");
    expect(sanitized).not.toContain("sk-secretsecret");
    expect(sanitized).not.toContain("acct_1234567890abcdef");
    expect(sanitized.length).toBeLessThanOrEqual(500);
  });

  test("formats percentages", () => {
    expect(_test.formatPercent(99.4)).toBe("99%");
    expect(_test.formatPercent(null)).toBe("--");
  });

  test("parses and formats usage snapshots", () => {
    const usage = _test.parseUsageSnapshot(
      {
        rate_limit: {
          allowed: true,
          primary_window: { used_percent: 1, reset_after_seconds: 60 },
          secondary_window: { used_percent: 49, reset_after_seconds: 3600 },
        },
      },
      "gpt-5.5",
    );
    expect(usage.fiveHourLeftPercent).toBe(99);
    expect(usage.sevenDayLeftPercent).toBe(51);
    expect(usage.isLimited).toBe(false);
    expect(_test.formatUsageSnapshot(usage, { showResetTimes: false })).toMatch(
      /^Usage: 5h: 99% \| 7d: 51%$/,
    );
  });
});

describe("requestCodexUsage", () => {
  test("reads isolated auth and sends usage fetch headers", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    writeCodexAuth(agentDir);
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);

    const response = await usage.requestCodexUsage();

    expect(response).toEqual(usageResponseBody());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(usage.USAGE_URL);
    expect(init.headers).toMatchObject({
      authorization: "Bearer usage-access",
      "chatgpt-account-id": "acct_usage",
    });
  });

  test("uses refreshed model-registry credentials before auth-file fallback", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);
    const ctx = {
      modelRegistry: {
        getApiKeyForProvider: vi.fn(() =>
          Promise.resolve(
            JSON.stringify({ access: "registry-access", accountId: "acct_registry" }),
          ),
        ),
      },
    } as unknown as ExtensionContext;

    const response = await usage.requestCodexUsage(ctx);

    expect(response).toEqual(usageResponseBody());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openai-codex");
    expect(init.headers).toMatchObject({
      authorization: "Bearer registry-access",
      "chatgpt-account-id": "acct_registry",
    });
  });

  test("returns undefined without fetch when isolated auth is missing", async () => {
    const agentDir = createTempDir("pi-better-openai-usage-agent-");
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const usage = await importUsageWithAgentDir(agentDir);

    await expect(usage.requestCodexUsage()).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("usage polling lifecycle", () => {
  test("does not fetch usage when usage display is disabled", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const harness = await createUsageHarness({ usageConfig: { enabled: false } });

    await emit(harness, "session_start");
    await settleAsyncWork();
    await emit(harness, "session_shutdown");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("does not fetch usage for non-OAuth subscription-gated models", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse());
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: false,
    });

    await emit(harness, "session_start");
    await settleAsyncWork();
    await emit(harness, "session_shutdown");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("fetches usage for OAuth OpenAI models and updates status text", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
        showResetTimes: false,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(harness.ctx.ui.setStatus).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining("Usage:"),
      ),
    );

    expect(harness.ctx.ui.setStatus).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("5h: 90%"),
    );
    await emit(harness, "session_shutdown");
  });

  test("stops interval polling when the session signal aborts", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 15000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
      signal: abortController.signal,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    abortController.abort();
    Object.defineProperty(harness.ctx, "model", {
      get() {
        throw new Error("stale ctx model access");
      },
    });
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(60000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("stops interval polling when pi marks the captured ctx stale", async () => {
    vi.useFakeTimers();
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 15000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    Object.defineProperty(harness.ctx, "model", {
      get() {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    });
    fetchMock.mockClear();

    await vi.advanceTimersByTimeAsync(60000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("throttles repeated turn-end refreshes within the configured interval", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await emit(harness, "turn_end");
    await emit(harness, "turn_end");
    await settleAsyncWork();
    await emit(harness, "session_shutdown");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("forces refreshes for model selection and manual usage status", async () => {
    const fetchMock = stubUsageFetch(usageJsonResponse);
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    harness.ctx.model = { provider: "openai", id: "gpt-5.5" } as ExtensionContext["model"];
    await emit(harness, "model_select", { model: harness.ctx.model });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await harness.commands.get("openai-usage")?.handler("", harness.ctx);
    await emit(harness, "session_shutdown");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "info");
  });

  test("surfaces usage fetch errors through /openai-usage", async () => {
    const fetchMock = stubUsageFetch(new Response("nope", { status: 500 }));
    const harness = await createUsageHarness({
      usageConfig: {
        enabled: true,
        refreshIntervalMs: 60000,
        showOnlyOnSubscriptionModels: true,
      },
      isUsingOAuth: true,
    });

    await emit(harness, "session_start");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await harness.commands.get("openai-usage")?.handler("", harness.ctx);
    await emit(harness, "session_shutdown");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Codex usage request failed (500)"),
      "warning",
    );
  });
});
