import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_BASENAME, logPrefix } from "./identity.ts";

export const FOOTER_MODES = ["replace", "status", "off"] as const;
export const IMAGE_SAVE_MODES = ["none", "project", "global", "custom"] as const;
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp"] as const;
export const PET_PLACEMENTS = [
  "stacked",
  "inline-left",
  "inline-right",
  "badge",
  "habitat",
] as const;
export const PET_STATES = [
  "idle",
  "running-right",
  "running-left",
  "waving",
  "jumping",
  "failed",
  "waiting",
  "running",
  "review",
] as const;

export const DEFAULT_SUPPORTED_MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5",
] as const;

export type FooterMode = (typeof FOOTER_MODES)[number];
export type ImageSaveMode = (typeof IMAGE_SAVE_MODES)[number];
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export type PetPlacement = (typeof PET_PLACEMENTS)[number];
export type PetState = (typeof PET_STATES)[number];

export type UsageConfig = {
  enabled?: boolean;
  refreshIntervalMs?: number;
  showOnlyOnSubscriptionModels?: boolean;
  showResetTimes?: boolean;
};

export type FooterConfig = {
  mode?: FooterMode;
};

export type ImageConfig = {
  enabled?: boolean;
  defaultModel?: string;
  defaultSave?: ImageSaveMode;
  outputFormat?: ImageOutputFormat;
  timeoutMs?: number;
};

export type PetConfig = {
  enabled?: boolean;
  slug?: string;
  placement?: PetPlacement;
  state?: PetState;
  thinkingState?: PetState;
  toolState?: PetState;
  failedToolState?: PetState;
  idleEmotes?: boolean;
  idleEmoteIntervalMs?: number;
  sizeCells?: number;
};

export interface ConfigFile {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
  supportedModels?: string[];
  usage?: UsageConfig;
  footer?: FooterConfig;
  image?: ImageConfig;
  pets?: PetConfig;
}

export interface SupportedModel {
  provider: string;
  id: string;
}

export interface ResolvedConfig {
  configPath: string;
  projectConfigPath: string;
  globalConfigPath: string;
  projectConfigExists: boolean;
  globalConfigExists: boolean;
  persistState: boolean;
  active: boolean;
  desiredActive: boolean;
  supportedModels: SupportedModel[];
  usage: Required<UsageConfig>;
  footer: Required<FooterConfig>;
  image: Required<ImageConfig>;
  pets: Required<PetConfig>;
}

export const DEFAULT_USAGE_CONFIG: Required<UsageConfig> = {
  enabled: true,
  refreshIntervalMs: 60_000,
  showOnlyOnSubscriptionModels: true,
  showResetTimes: true,
};

export const DEFAULT_FOOTER_CONFIG: Required<FooterConfig> = {
  mode: "replace",
};

export const DEFAULT_IMAGE_CONFIG: Required<ImageConfig> = {
  enabled: true,
  defaultModel: "gpt-5.5",
  defaultSave: "project",
  outputFormat: "png",
  timeoutMs: 180_000,
};

export const DEFAULT_PET_CONFIG: Required<PetConfig> = {
  enabled: false,
  slug: "",
  placement: "inline-right",
  state: "idle",
  thinkingState: "review",
  toolState: "running",
  failedToolState: "failed",
  idleEmotes: true,
  idleEmoteIntervalMs: 30_000,
  sizeCells: 10,
};

export const DEFAULT_CONFIG: ConfigFile = {
  persistState: true,
  active: false,
  desiredActive: false,
  supportedModels: [...DEFAULT_SUPPORTED_MODELS],
  usage: DEFAULT_USAGE_CONFIG,
  footer: DEFAULT_FOOTER_CONFIG,
  image: DEFAULT_IMAGE_CONFIG,
  pets: DEFAULT_PET_CONFIG,
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function configPaths(cwd: string, home = homedir()) {
  return {
    project: join(cwd, ".pi", "extensions", CONFIG_BASENAME),
    global: join(home, ".pi", "agent", "extensions", CONFIG_BASENAME),
  };
}

export function parseModelKey(value: string): SupportedModel | undefined {
  const key = value.trim();
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  const provider = key.slice(0, slash).trim();
  const id = key.slice(slash + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

export function normalizeModelKeys(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => parseModelKey(entry))
    .filter((entry): entry is SupportedModel => entry !== undefined)
    .map((entry) => `${entry.provider}/${entry.id}`);
}

export function parseModels(value: unknown): SupportedModel[] | undefined {
  const keys = normalizeModelKeys(value);
  if (keys === undefined) return undefined;
  return keys
    .map((key) => parseModelKey(key))
    .filter((entry): entry is SupportedModel => entry !== undefined);
}

export function readRawConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to read ${path}: ${message}`);
    return {};
  }
}

export function readConfig(path: string): ConfigFile | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = readRawConfig(path);
  const config: ConfigFile = {};
  if (typeof parsed.persistState === "boolean") config.persistState = parsed.persistState;
  if (typeof parsed.active === "boolean") config.active = parsed.active;
  if (typeof parsed.desiredActive === "boolean") config.desiredActive = parsed.desiredActive;
  const supportedModels = normalizeModelKeys(parsed.supportedModels);
  if (supportedModels !== undefined) config.supportedModels = supportedModels;
  if (isRecord(parsed.usage)) {
    config.usage = {};
    if (typeof parsed.usage.enabled === "boolean") config.usage.enabled = parsed.usage.enabled;
    if (typeof parsed.usage.refreshIntervalMs === "number")
      config.usage.refreshIntervalMs = parsed.usage.refreshIntervalMs;
    if (typeof parsed.usage.showOnlyOnSubscriptionModels === "boolean")
      config.usage.showOnlyOnSubscriptionModels = parsed.usage.showOnlyOnSubscriptionModels;
    if (typeof parsed.usage.showResetTimes === "boolean")
      config.usage.showResetTimes = parsed.usage.showResetTimes;
  }
  if (
    isRecord(parsed.footer) &&
    typeof parsed.footer.mode === "string" &&
    (FOOTER_MODES as readonly string[]).includes(parsed.footer.mode)
  ) {
    config.footer = { mode: parsed.footer.mode as FooterMode };
  }
  if (isRecord(parsed.image)) {
    config.image = {};
    if (typeof parsed.image.enabled === "boolean") config.image.enabled = parsed.image.enabled;
    if (typeof parsed.image.defaultModel === "string" && parsed.image.defaultModel.trim())
      config.image.defaultModel = parsed.image.defaultModel.trim();
    if (
      typeof parsed.image.defaultSave === "string" &&
      (IMAGE_SAVE_MODES as readonly string[]).includes(parsed.image.defaultSave)
    )
      config.image.defaultSave = parsed.image.defaultSave as ImageSaveMode;
    if (
      typeof parsed.image.outputFormat === "string" &&
      (IMAGE_OUTPUT_FORMATS as readonly string[]).includes(parsed.image.outputFormat)
    )
      config.image.outputFormat = parsed.image.outputFormat as ImageOutputFormat;
    if (typeof parsed.image.timeoutMs === "number") config.image.timeoutMs = parsed.image.timeoutMs;
  }
  if (isRecord(parsed.pets)) {
    config.pets = {};
    if (typeof parsed.pets.enabled === "boolean") config.pets.enabled = parsed.pets.enabled;
    if (typeof parsed.pets.slug === "string") config.pets.slug = parsed.pets.slug.trim();
    if (
      typeof parsed.pets.placement === "string" &&
      (PET_PLACEMENTS as readonly string[]).includes(parsed.pets.placement)
    )
      config.pets.placement = parsed.pets.placement as PetPlacement;
    if (
      typeof parsed.pets.state === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.state)
    )
      config.pets.state = parsed.pets.state as PetState;
    if (
      typeof parsed.pets.thinkingState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.thinkingState)
    )
      config.pets.thinkingState = parsed.pets.thinkingState as PetState;
    if (
      typeof parsed.pets.toolState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.toolState)
    )
      config.pets.toolState = parsed.pets.toolState as PetState;
    if (
      typeof parsed.pets.failedToolState === "string" &&
      (PET_STATES as readonly string[]).includes(parsed.pets.failedToolState)
    )
      config.pets.failedToolState = parsed.pets.failedToolState as PetState;
    if (typeof parsed.pets.idleEmotes === "boolean")
      config.pets.idleEmotes = parsed.pets.idleEmotes;
    if (typeof parsed.pets.idleEmoteIntervalMs === "number")
      config.pets.idleEmoteIntervalMs = parsed.pets.idleEmoteIntervalMs;
    if (typeof parsed.pets.sizeCells === "number") config.pets.sizeCells = parsed.pets.sizeCells;
  }
  return config;
}

export type SettingPatchContext = {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
  petEmptyValue?: string;
};

export function applySettingToRawConfig(
  current: Record<string, unknown>,
  id: string,
  rawValue: string,
  context: SettingPatchContext = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const bool = rawValue === "true";
  const num = Number(rawValue);
  if (id === "fast.enabled") {
    if (context.persistState) {
      next.active = context.active ?? bool;
      next.desiredActive = context.desiredActive ?? bool;
    }
  } else if (id === "persistState") next.persistState = bool;
  else if (id.startsWith("usage.")) {
    const usage = isRecord(next.usage) ? { ...next.usage } : {};
    const key = id.slice("usage.".length);
    usage[key] = key === "refreshIntervalMs" ? num : bool;
    next.usage = usage;
  } else if (id === "footer.mode") {
    const footer = isRecord(next.footer) ? { ...next.footer } : {};
    footer.mode = rawValue;
    next.footer = footer;
  } else if (id.startsWith("pets.")) {
    const pets = isRecord(next.pets) ? { ...next.pets } : {};
    const key = id.slice("pets.".length);
    pets[key] =
      key === "sizeCells" || key === "idleEmoteIntervalMs"
        ? num
        : key === "slug"
          ? rawValue === (context.petEmptyValue ?? "not selected")
            ? ""
            : rawValue
          : rawValue === "true"
            ? true
            : rawValue === "false"
              ? false
              : rawValue;
    next.pets = pets;
  } else if (id.startsWith("image.")) {
    const image = isRecord(next.image) ? { ...next.image } : {};
    const key = id.slice("image.".length);
    image[key] =
      key === "timeoutMs"
        ? num
        : rawValue === "true"
          ? true
          : rawValue === "false"
            ? false
            : rawValue;
    next.image = image;
  }
  return next;
}

export function writeConfig(path: string, config: ConfigFile | Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`${logPrefix()} Failed to write ${path}: ${message}`);
  }
}

function ensureConfigFile(projectConfigPath: string, globalConfigPath: string): void {
  if (existsSync(projectConfigPath) || existsSync(globalConfigPath)) return;
  writeConfig(globalConfigPath, DEFAULT_CONFIG);
}

export function resolveConfig(cwd: string): ResolvedConfig {
  const paths = configPaths(cwd);
  ensureConfigFile(paths.project, paths.global);

  const projectConfigExists = existsSync(paths.project);
  const globalConfigExists = existsSync(paths.global);
  const globalConfig = readConfig(paths.global) ?? {};
  const projectConfig = readConfig(paths.project) ?? {};
  const merged = { ...DEFAULT_CONFIG, ...globalConfig, ...projectConfig };
  const selectedPath = projectConfigExists ? paths.project : paths.global;
  const desiredActive = merged.desiredActive ?? merged.active ?? false;

  return {
    configPath: selectedPath,
    projectConfigPath: paths.project,
    globalConfigPath: paths.global,
    projectConfigExists,
    globalConfigExists,
    persistState: merged.persistState ?? true,
    active: merged.active ?? desiredActive,
    desiredActive,
    supportedModels:
      parseModels(merged.supportedModels) ?? parseModels(DEFAULT_SUPPORTED_MODELS) ?? [],
    usage: {
      ...DEFAULT_USAGE_CONFIG,
      ...globalConfig.usage,
      ...projectConfig.usage,
      refreshIntervalMs: Math.max(
        15_000,
        Math.min(
          10 * 60_000,
          projectConfig.usage?.refreshIntervalMs ??
            globalConfig.usage?.refreshIntervalMs ??
            DEFAULT_USAGE_CONFIG.refreshIntervalMs,
        ),
      ),
    },
    footer: {
      ...DEFAULT_FOOTER_CONFIG,
      ...globalConfig.footer,
      ...projectConfig.footer,
    },
    image: {
      ...DEFAULT_IMAGE_CONFIG,
      ...globalConfig.image,
      ...projectConfig.image,
      timeoutMs: Math.max(
        30_000,
        Math.min(
          5 * 60_000,
          projectConfig.image?.timeoutMs ??
            globalConfig.image?.timeoutMs ??
            DEFAULT_IMAGE_CONFIG.timeoutMs,
        ),
      ),
    },
    pets: {
      ...DEFAULT_PET_CONFIG,
      ...globalConfig.pets,
      ...projectConfig.pets,
      idleEmoteIntervalMs: Math.max(
        5_000,
        Math.min(
          5 * 60_000,
          projectConfig.pets?.idleEmoteIntervalMs ??
            globalConfig.pets?.idleEmoteIntervalMs ??
            DEFAULT_PET_CONFIG.idleEmoteIntervalMs,
        ),
      ),
      sizeCells: Math.max(
        4,
        Math.min(
          16,
          projectConfig.pets?.sizeCells ??
            globalConfig.pets?.sizeCells ??
            DEFAULT_PET_CONFIG.sizeCells,
        ),
      ),
    },
  };
}
