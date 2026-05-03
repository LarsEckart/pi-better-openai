import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { _test } from "../index.ts";
import { isRecord, readRawConfig, writeConfig } from "../src/config.ts";

describe("config helpers", () => {
  test("exposes expected defaults", () => {
    expect(_test.CONFIG_BASENAME).toBe("pi-better-openai.json");
    expect(_test.DEFAULT_CONFIG.desiredActive).toBe(false);
    expect(_test.DEFAULT_IMAGE_CONFIG.defaultSave).toBe("project");
    expect(_test.DEFAULT_PET_CONFIG.placement).toBe("inline-right");
    expect(_test.DEFAULT_PET_CONFIG.state).toBe("idle");
    expect(_test.DEFAULT_PET_CONFIG.thinkingState).toBe("review");
    expect(_test.DEFAULT_PET_CONFIG.toolState).toBe("running");
    expect(_test.DEFAULT_PET_CONFIG.failedToolState).toBe("failed");
    expect(_test.DEFAULT_PET_CONFIG.idleEmotes).toBe(true);
    expect(_test.DEFAULT_PET_CONFIG.idleEmoteIntervalMs).toBe(30000);
    expect(_test.DEFAULT_SUPPORTED_MODELS).toEqual([
      "openai/gpt-5.4",
      "openai/gpt-5.5",
      "openai-codex/gpt-5.4",
      "openai-codex/gpt-5.5",
    ]);
  });

  test("parses and normalizes model keys", () => {
    expect(_test.parseModelKey("openai/gpt-5.5")).toEqual({
      provider: "openai",
      id: "gpt-5.5",
    });
    expect(_test.parseModelKey("bad")).toBeUndefined();
    expect(_test.normalizeModelKeys(["openai/gpt-5.5", "bad", 42])).toEqual(["openai/gpt-5.5"]);
  });

  test("preserves unknown config fields while writing updates", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-better-openai-"));
    try {
      const configPath = join(tempDir, "config.json");
      writeConfig(configPath, {
        active: false,
        unknownField: "keep me",
        usage: { enabled: true, unknownUsageField: 123 },
      });
      const current = readRawConfig(configPath);
      writeConfig(configPath, { ...current, active: true });
      const afterActiveWrite = readRawConfig(configPath);
      expect(afterActiveWrite.active).toBe(true);
      expect(afterActiveWrite.unknownField).toBe("keep me");
      expect(afterActiveWrite.usage).toEqual({ enabled: true, unknownUsageField: 123 });

      const currentUsage = isRecord(afterActiveWrite.usage) ? afterActiveWrite.usage : {};
      writeConfig(configPath, { ...afterActiveWrite, usage: { ...currentUsage, enabled: false } });
      const afterUsageWrite = readRawConfig(configPath);
      expect(afterUsageWrite.usage).toEqual({ enabled: false, unknownUsageField: 123 });

      const projectConfigPath = _test.configPaths(tempDir).project;
      writeConfig(projectConfigPath, {
        image: { defaultSave: "global", outputFormat: "webp", timeoutMs: 1 },
      });
      const resolved = _test.resolveConfig(tempDir);
      expect(resolved.image.defaultSave).toBe("global");
      expect(resolved.image.outputFormat).toBe("webp");
      expect(resolved.image.timeoutMs).toBe(30000);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
