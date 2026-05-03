/**
 * Better OpenAI for pi.
 *
 * Adds `service_tier: "priority"` to OpenAI provider payloads while fast mode is
 * enabled and the selected model is in the configured allow-list.
 */
import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  getCapabilities,
  getCellDimensions,
  Key,
  matchesKey,
  SettingsList,
} from "@mariozechner/pi-tui";
import { CONFIG_BASENAME, STATUS_KEY } from "./src/identity.ts";
import { formatTokens, sanitizeStatusText, truncateToWidth, visibleWidth } from "./src/format.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  DEFAULT_SUPPORTED_MODELS,
  FOOTER_MODES,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  PET_PLACEMENTS,
  PET_STATES,
  configPaths,
  type ResolvedConfig,
  type PetPlacement,
  type PetState,
  type SupportedModel,
  isRecord,
  parseModelKey,
  normalizeModelKeys,
  parseModels,
  readRawConfig,
  resolveConfig,
  writeConfig,
} from "./src/config.ts";
import {
  AUTH_FILE,
  type UsageSnapshot,
  formatPercent,
  formatResetCountdown,
  formatUsageSnapshot,
  parseUsageSnapshot,
  readCodexAuth,
  requestCodexUsage,
} from "./src/usage.ts";
import { registerOpenAIImage, _imageTest } from "./src/image.ts";
import {
  type LoadedCodexPet,
  loadCodexPet,
  animationFrameAt,
  listCodexPets,
  nextAnimationFrameDelayMs,
  PET_ANIMATION_ROWS,
  registerOpenAIPets,
  renderCodexPetFrame,
  resetCodexPetKittyCache,
  _petsTest,
} from "./src/pets.ts";

const COMMAND = "fast";
const OPENAI_STATUS_COMMAND = "openai-usage";
const OPENAI_SETTINGS_COMMAND = "openai-settings";
const FLAG = "fast";
const PET_RESIZE_FREEZE_MS = 500;
const PET_RENDER_CACHE_LIMIT = 48;
const SERVICE_TIER = "priority";
type SettingsPickerItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (
    currentValue: string,
    done: (selectedValue?: string) => void,
  ) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void };
};

function currentModelKey(ctx: ExtensionContext): string {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
}

function supportsFast(ctx: ExtensionContext, supportedModels: SupportedModel[]): boolean {
  const current = ctx.model;
  if (!current) return false;
  return supportedModels.some(
    (model) => model.provider === current.provider && model.id === current.id,
  );
}

function modelList(supportedModels: SupportedModel[]): string {
  return supportedModels.length > 0
    ? supportedModels.map((model) => `${model.provider}/${model.id}`).join(", ")
    : "none configured";
}

function stateText(
  ctx: ExtensionContext,
  desiredActive: boolean,
  active: boolean,
  supportedModels: SupportedModel[],
): string {
  const model = currentModelKey(ctx);
  if (active) return `Fast mode is on for ${model}.`;
  if (desiredActive) {
    return `Fast mode is requested, but inactive for unsupported model ${model}. Supported models: ${modelList(supportedModels)}.`;
  }
  return `Fast mode is off. Current model: ${model}.`;
}

function isOpenAISubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  if (!ctx.model || (ctx.model.provider !== "openai" && ctx.model.provider !== "openai-codex"))
    return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || ctx.modelRegistry.isUsingOAuth(ctx.model);
}

function randomIdleEmoteState(idleState: PetState, random = Math.random): PetState {
  const candidates = (["waving", "jumping"] as const).filter((state) => state !== idleState);
  return candidates[Math.floor(random() * candidates.length)] ?? "waving";
}

function isInlinePetPlacement(placement: PetPlacement): boolean {
  return placement === "inline-left" || placement === "inline-right" || placement === "badge";
}

function petSizeCellsForPlacement(placement: PetPlacement, sizeCells: number): number {
  return placement === "badge" ? Math.min(6, sizeCells) : sizeCells;
}

function spaces(width: number): string {
  return " ".repeat(Math.max(0, width));
}

function padTextToWidth(value: string, width: number): string {
  return value + spaces(width - visibleWidth(value));
}

function isTerminalImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

function petLineCell(line: string, width: number): string {
  if (!line) return spaces(width);
  if (isTerminalImageLine(line)) return `\x1b[0m${line}`;
  const clipped = truncateToWidth(line, width, "");
  return clipped + spaces(width - visibleWidth(clipped));
}

function combineInlinePetFooter(
  petLines: string[],
  textLines: string[],
  width: number,
  placement: PetPlacement,
  petWidth: number,
): string[] {
  const gap = 2;
  const textWidth = Math.max(1, width - petWidth - gap);
  const totalRows = Math.max(petLines.length, textLines.length);
  const petStart = 0;
  const textStart = 0;
  const imagePetLines = petLines.some(isTerminalImageLine);
  const renderPetOnRight = placement === "inline-right" || imagePetLines;
  const lines: string[] = [];

  for (let row = 0; row < totalRows; row++) {
    const petLine = row >= petStart ? (petLines[row - petStart] ?? "") : "";
    const textLine = row >= textStart ? (textLines[row - textStart] ?? "") : "";
    const textPart = truncateToWidth(textLine, textWidth, "...");
    const petPart = petLineCell(petLine, petWidth);
    if (renderPetOnRight) {
      lines.push(`${padTextToWidth(textPart, textWidth)}${spaces(gap)}${petPart}`);
    } else {
      lines.push(`${petPart}${spaces(gap)}${textPart}`);
    }
  }

  return lines;
}

function petFrameInfo(pet: LoadedCodexPet, state: PetState, elapsedMs: number) {
  const frames = pet.states[state] ?? pet.states.idle;
  const frame = animationFrameAt(frames, elapsedMs);
  return { frame, frameIndex: frame ? frames.indexOf(frame) : -1 };
}

function petRenderCacheKey(
  pet: LoadedCodexPet,
  state: PetState,
  frameIndex: number,
  placement: PetPlacement,
  width: number,
  sizeCells: number,
): string {
  const cellDimensions = getCellDimensions();
  const imageProtocol = getCapabilities().images ?? "none";
  return [
    pet.pet.slug,
    state,
    frameIndex,
    placement,
    width,
    sizeCells,
    imageProtocol,
    cellDimensions.widthPx,
    cellDimensions.heightPx,
  ].join(":");
}

export default function betterOpenAI(pi: ExtensionAPI): void {
  let desiredActive = false;
  let active = false;
  let cachedConfig: ResolvedConfig | undefined;
  let usageSnapshot: UsageSnapshot | undefined;
  let usageUpdatedAt: number | undefined;
  let usageError: string | undefined;
  let usageLastFetchAt: number | undefined;
  let usageTimer: ReturnType<typeof setInterval> | undefined;
  let footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let usageRefreshInFlight = false;
  let queuedUsageRefresh: { ctx: ExtensionContext; modelId?: string; notify?: boolean } | undefined;
  let shuttingDown = false;
  let usageAbortController: AbortController | undefined;
  let footerInstalled = false;
  let statusInstalled = false;
  let requestFooterRender: (() => void) | undefined;
  let lastInjectedAt: number | undefined;
  let lastInjectedModel: string | undefined;
  let lastInjectedTier: string | undefined;
  let pet: LoadedCodexPet | undefined;
  let petError: string | undefined;
  let petLoadKey: string | undefined;
  let petLoadInFlight = false;
  let petTimer: ReturnType<typeof setTimeout> | undefined;
  let petRenderRequestTimer: ReturnType<typeof setTimeout> | undefined;
  let petRuntimeState: PetState = "idle";
  let petPreviewState: PetState | undefined;
  let petFlashState: PetState | undefined;
  let petFlashUntil: number | undefined;
  let petFlashTimer: ReturnType<typeof setTimeout> | undefined;
  let petIdleEmoteTimer: ReturnType<typeof setTimeout> | undefined;
  let petResizeTimer: ReturnType<typeof setTimeout> | undefined;
  let petResizeFreezeUntil = 0;
  let stdoutResizeHandler: (() => void) | undefined;
  let petAnimationState: PetState | undefined;
  let petAnimationStartedAt = Date.now();
  let lastPetRender: { key: string; lines: string[] } | undefined;
  const petRenderCache = new Map<string, string[]>();
  const activeToolCallIds = new Set<string>();
  const petImageId = 0x70657401;

  function refresh(ctx: ExtensionContext): ResolvedConfig {
    cachedConfig = resolveConfig(ctx.cwd || process.cwd());
    return cachedConfig;
  }

  function config(ctx: ExtensionContext): ResolvedConfig {
    return cachedConfig ?? refresh(ctx);
  }

  function persist(nextConfig: ResolvedConfig): void {
    cachedConfig = { ...nextConfig, active, desiredActive };
    if (!nextConfig.persistState) return;
    writeConfig(nextConfig.configPath, {
      ...readRawConfig(nextConfig.configPath),
      active,
      desiredActive,
    });
  }

  function petStateAnimationDurationMs(state: PetState): number {
    return PET_ANIMATION_ROWS[state].durations.reduce((sum, duration) => sum + duration, 0);
  }

  function clearPetFlash(): void {
    if (petFlashTimer) clearTimeout(petFlashTimer);
    petFlashTimer = undefined;
    petFlashState = undefined;
    petFlashUntil = undefined;
    petAnimationState = undefined;
  }

  function stopPetIdleEmotes(): void {
    if (petIdleEmoteTimer) clearTimeout(petIdleEmoteTimer);
    petIdleEmoteTimer = undefined;
  }

  function resetPetRenderCache(): void {
    lastPetRender = undefined;
    petRenderCache.clear();
  }

  function rememberPetRender(key: string, lines: string[]): void {
    petRenderCache.set(key, lines);
    while (petRenderCache.size > PET_RENDER_CACHE_LIMIT) {
      const firstKey = petRenderCache.keys().next().value;
      if (firstKey === undefined) break;
      petRenderCache.delete(firstKey);
    }
    lastPetRender = { key, lines };
  }

  function petResizeFrozen(now = Date.now()): boolean {
    return now < petResizeFreezeUntil;
  }

  function clearPetResizeFreeze(): void {
    if (petResizeTimer) clearTimeout(petResizeTimer);
    petResizeTimer = undefined;
    petResizeFreezeUntil = 0;
  }

  function freezePetForResize(ctx: ExtensionContext, now = Date.now()): void {
    petResizeFreezeUntil = now + PET_RESIZE_FREEZE_MS;
    stopPetAnimation();
    stopPetIdleEmotes();
    stopPendingPetRenderRequest();
    if (petResizeTimer) clearTimeout(petResizeTimer);
    petResizeTimer = setTimeout(() => {
      petResizeTimer = undefined;
      petResizeFreezeUntil = 0;
      resetCodexPetKittyCache(pet, petImageId);
      resetPetRenderCache();
      updateFooter(ctx);
    }, PET_RESIZE_FREEZE_MS);
    petResizeTimer.unref?.();
  }

  function installPetResizeGuard(ctx: ExtensionContext): void {
    if (stdoutResizeHandler || !process.stdout.isTTY) return;
    stdoutResizeHandler = () => freezePetForResize(ctx);
    process.stdout.on("resize", stdoutResizeHandler);
  }

  function uninstallPetResizeGuard(): void {
    if (stdoutResizeHandler) process.stdout.off("resize", stdoutResizeHandler);
    stdoutResizeHandler = undefined;
    clearPetResizeFreeze();
  }

  function currentPetState(ctx: ExtensionContext, cfg = config(ctx)): PetState {
    if (petPreviewState) return petPreviewState;
    const now = Date.now();
    if (petFlashState && petFlashUntil !== undefined && now < petFlashUntil) return petFlashState;
    if (petFlashState) clearPetFlash();
    return petRuntimeState === "idle" ? cfg.pets.state : petRuntimeState;
  }

  function currentPetAnimation(ctx: ExtensionContext, cfg = config(ctx)) {
    const state = currentPetState(ctx, cfg);
    const now = Date.now();
    if (state !== petAnimationState) {
      petAnimationState = state;
      petAnimationStartedAt = now;
    }
    return { state, elapsedMs: now - petAnimationStartedAt };
  }

  function stopPetAnimation(): void {
    if (petTimer) clearTimeout(petTimer);
    petTimer = undefined;
  }

  function stopPendingPetRenderRequest(): void {
    if (petRenderRequestTimer) clearTimeout(petRenderRequestTimer);
    petRenderRequestTimer = undefined;
  }

  function requestPetFooterRender(): void {
    if (petRenderRequestTimer) return;
    petRenderRequestTimer = setTimeout(() => {
      petRenderRequestTimer = undefined;
      requestFooterRender?.();
    }, 16);
    petRenderRequestTimer.unref?.();
  }

  function schedulePetAnimation(ctx: ExtensionContext): void {
    if (!pet || petTimer || petResizeFrozen() || !getCapabilities().images) return;
    const { state, elapsedMs } = currentPetAnimation(ctx);
    const frames = pet.states[state] ?? pet.states.idle;
    petTimer = setTimeout(
      () => {
        petTimer = undefined;
        if (petResizeFrozen()) return;
        requestPetFooterRender();
        schedulePetAnimation(ctx);
      },
      nextAnimationFrameDelayMs(frames, elapsedMs),
    );
    petTimer.unref?.();
  }

  function startPetAnimation(ctx: ExtensionContext): void {
    schedulePetAnimation(ctx);
    void refreshPet(ctx);
  }

  function shouldRunIdleEmotes(ctx: ExtensionContext, cfg = config(ctx)): boolean {
    return (
      cfg.pets.enabled &&
      cfg.pets.idleEmotes &&
      getCapabilities().images !== null &&
      pet !== undefined &&
      petRuntimeState === "idle" &&
      activeToolCallIds.size === 0 &&
      petPreviewState === undefined &&
      petFlashState === undefined &&
      !petResizeFrozen()
    );
  }

  function playPetFlash(ctx: ExtensionContext, state: PetState, cfg = config(ctx)): void {
    if (!cfg.pets.enabled || !getCapabilities().images) return;
    clearPetFlash();
    const durationMs = petStateAnimationDurationMs(state);
    petFlashState = state;
    petFlashUntil = Date.now() + durationMs;
    petFlashTimer = setTimeout(() => {
      petFlashTimer = undefined;
      petFlashState = undefined;
      petFlashUntil = undefined;
      petAnimationState = undefined;
      updateFooter(ctx);
    }, durationMs);
    petFlashTimer.unref?.();
    updateFooter(ctx);
  }

  function schedulePetIdleEmote(ctx: ExtensionContext, cfg = config(ctx)): void {
    if (petIdleEmoteTimer || !shouldRunIdleEmotes(ctx, cfg)) return;
    const delayMs = Math.round(cfg.pets.idleEmoteIntervalMs * (0.75 + Math.random() * 0.75));
    petIdleEmoteTimer = setTimeout(() => {
      petIdleEmoteTimer = undefined;
      const nextConfig = config(ctx);
      if (shouldRunIdleEmotes(ctx, nextConfig)) {
        playPetFlash(ctx, randomIdleEmoteState(nextConfig.pets.state), nextConfig);
      }
      schedulePetIdleEmote(ctx, nextConfig);
    }, delayMs);
    petIdleEmoteTimer.unref?.();
  }

  async function refreshPet(
    ctx: ExtensionContext,
    cfg = config(ctx),
    notify = false,
  ): Promise<void> {
    if (!cfg.pets.enabled) {
      resetCodexPetKittyCache(pet, petImageId);
      pet = undefined;
      petError = undefined;
      petLoadKey = undefined;
      resetPetRenderCache();
      clearPetFlash();
      stopPetIdleEmotes();
      stopPetAnimation();
      return;
    }
    const cellDimensions = getCellDimensions();
    const key = [
      cfg.pets.slug || "__first__",
      cfg.pets.sizeCells,
      getCapabilities().images ?? "none",
      cellDimensions.widthPx,
      cellDimensions.heightPx,
    ].join(":");
    if (petLoadInFlight || petLoadKey === key) return;
    petLoadInFlight = true;
    petError = undefined;
    try {
      pet = await loadCodexPet(cfg.pets.slug || undefined, undefined, {
        sizeCells: cfg.pets.sizeCells,
      });
      petAnimationState = undefined;
      resetPetRenderCache();
      petLoadKey = pet ? key : undefined;
      if (!pet) petError = "No ready custom Codex pet found.";
      if (notify) {
        ctx.ui.notify(
          pet
            ? `Rendering ${pet.pet.name} in the Better OpenAI footer.`
            : "No ready custom Codex pet found. Run /pets list.",
          pet ? "info" : "warning",
        );
      }
    } catch (error) {
      pet = undefined;
      petLoadKey = undefined;
      petError = error instanceof Error ? error.message : String(error);
      if (notify) ctx.ui.notify(`Could not render Codex pet: ${petError}`, "warning");
    } finally {
      petLoadInFlight = false;
      updateFooter(ctx);
    }
  }

  function writePetConfig(ctx: ExtensionContext, patch: Record<string, unknown>): ResolvedConfig {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    const pets = isRecord(current.pets) ? current.pets : {};
    writeConfig(cfg.configPath, { ...current, pets: { ...pets, ...patch } });
    petLoadKey = undefined;
    return refresh(ctx);
  }

  function applyDesiredFastState(ctx: ExtensionContext, cfg = config(ctx)): void {
    active = desiredActive && supportsFast(ctx, cfg.supportedModels);
  }

  function setActive(ctx: ExtensionContext, next: boolean): void {
    const nextConfig = refresh(ctx);
    desiredActive = next;
    applyDesiredFastState(ctx, nextConfig);
    persist(nextConfig);
    updateFooter(ctx);
    if (next && !active) {
      ctx.ui.notify(
        `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(nextConfig.supportedModels)}.`,
        "warning",
      );
      return;
    }
    ctx.ui.notify(stateText(ctx, desiredActive, active, nextConfig.supportedModels), "info");
  }

  async function refreshUsage(
    ctx: ExtensionContext,
    modelId = ctx.model?.id,
    options?: { notify?: boolean },
  ): Promise<void> {
    if (shuttingDown || !ctx.hasUI) return;
    if (usageRefreshInFlight) {
      queuedUsageRefresh = { ctx, modelId, notify: queuedUsageRefresh?.notify || options?.notify };
      return;
    }
    usageRefreshInFlight = true;
    const cfg = config(ctx);
    try {
      if (!cfg.usage.enabled) {
        usageSnapshot = undefined;
        usageError = "Usage display is disabled.";
        if (!shuttingDown) updateFooter(ctx);
        return;
      }
      if (!isOpenAISubscriptionModel(ctx, cfg)) {
        if (!shuttingDown) updateFooter(ctx);
        return;
      }
      usageAbortController = new AbortController();
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal, usageAbortController.signal])
        : AbortSignal.any([timeoutSignal, usageAbortController.signal]);
      const data = await requestCodexUsage(signal);
      usageLastFetchAt = Date.now();
      usageSnapshot = data ? parseUsageSnapshot(data, modelId) : undefined;
      usageUpdatedAt = usageSnapshot ? Date.now() : undefined;
      usageError = data ? undefined : `Missing openai-codex OAuth credentials in ${AUTH_FILE}.`;
      if (!shuttingDown) updateFooter(ctx);
      if (!shuttingDown && options?.notify)
        ctx.ui.notify(formatUsageStatus(ctx), usageSnapshot ? "info" : "warning");
    } catch (error) {
      if (shuttingDown) return;
      usageError = error instanceof Error ? error.message : String(error);
      updateFooter(ctx);
      if (options?.notify) ctx.ui.notify(formatUsageStatus(ctx), "warning");
    } finally {
      usageAbortController = undefined;
      usageRefreshInFlight = false;
      if (!shuttingDown && queuedUsageRefresh) {
        const next = queuedUsageRefresh;
        queuedUsageRefresh = undefined;
        void refreshUsage(next.ctx, next.modelId, { notify: next.notify });
      }
    }
  }

  function startUsageRefresh(ctx: ExtensionContext): void {
    if (usageTimer) clearInterval(usageTimer);
    const cfg = config(ctx);
    if (!cfg.usage.enabled) return;
    void refreshUsage(ctx);
    usageTimer = setInterval(() => void refreshUsage(ctx), cfg.usage.refreshIntervalMs);
    usageTimer.unref?.();
  }

  function refreshFooterTotals(ctx: ExtensionContext): void {
    footerTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      footerTotals.input += entry.message.usage.input;
      footerTotals.output += entry.message.usage.output;
      footerTotals.cacheRead += entry.message.usage.cacheRead;
      footerTotals.cacheWrite += entry.message.usage.cacheWrite;
      footerTotals.cost += entry.message.usage.cost.total;
    }
  }

  function formatUsageDebug(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    const auth = readCodexAuth();
    return [
      `Usage enabled: ${cfg.usage.enabled}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Current model eligible: ${isOpenAISubscriptionModel(ctx, cfg)}`,
      `Requires subscription model: ${cfg.usage.showOnlyOnSubscriptionModels}`,
      `Auth: ${auth ? "found" : "missing"}`,
      `Account ID: ${auth?.accountId ?? "none"}`,
      `Last fetch: ${usageLastFetchAt ? new Date(usageLastFetchAt).toLocaleTimeString() : "never"}`,
      `Last successful update: ${usageUpdatedAt ? new Date(usageUpdatedAt).toLocaleTimeString() : "never"}`,
      `Last error: ${usageError ?? "none"}`,
      `Refresh interval: ${cfg.usage.refreshIntervalMs}ms`,
      `Endpoint: https://chatgpt.com/backend-api/wham/usage`,
    ].join("\n");
  }

  function formatUsageStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    if (!cfg.usage.enabled) return "Usage display is disabled.";
    if (!isOpenAISubscriptionModel(ctx, cfg))
      return "Usage hidden: current model is not an OpenAI subscription model.";
    if (!usageSnapshot) return `Usage unavailable${usageError ? `: ${usageError}` : "."}`;
    const stale =
      usageUpdatedAt && Date.now() - usageUpdatedAt > cfg.usage.refreshIntervalMs * 2
        ? ` | stale ${formatResetCountdown((Date.now() - usageUpdatedAt) / 1000)}`
        : "";
    return `${formatUsageSnapshot(usageSnapshot, cfg.usage)}${stale}`;
  }

  pi.registerFlag(FLAG, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });

  function formatDebugStatus(ctx: ExtensionContext): string {
    const cfg = config(ctx);
    return [
      `Fast desired: ${desiredActive}`,
      `Fast active: ${active}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Supported model: ${supportsFast(ctx, cfg.supportedModels)}`,
      `Configured service_tier: ${SERVICE_TIER}`,
      `Last injected: ${lastInjectedAt ? `${new Date(lastInjectedAt).toLocaleTimeString()} (${lastInjectedModel}, ${lastInjectedTier})` : "never"}`,
      `Footer mode: ${cfg.footer.mode}`,
      "",
      formatUsageDebug(ctx),
      "",
      `Image enabled: ${cfg.image.enabled}`,
      `Image default save: ${cfg.image.defaultSave}`,
      `Pet enabled: ${cfg.pets.enabled}`,
      `Pet slug: ${cfg.pets.slug || "first ready pet"}`,
      `Pet placement: ${cfg.pets.placement}`,
      `Pet failed tool state: ${cfg.pets.failedToolState}`,
      `Pet idle emotes: ${cfg.pets.idleEmotes} (${cfg.pets.idleEmoteIntervalMs}ms)`,
      `Pet loaded: ${pet?.pet.name ?? "none"}`,
      `Pet error: ${petError ?? "none"}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  }

  function formatOpenAIStatus(ctx: ExtensionContext): string {
    refresh(ctx);
    return formatUsageStatus(ctx);
  }

  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (!arg) return setActive(ctx, !desiredActive);
      ctx.ui.notify("Usage: /fast", "error");
    },
  });

  pi.registerCommand(OPENAI_STATUS_COMMAND, {
    description: "Show OpenAI subscription usage status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatOpenAIStatus(ctx), "info");
    },
  });

  function textPanel(title: string, lines: string[], done: () => void) {
    return {
      render(width: number) {
        const clipped = lines.map((line) => truncateToWidth(line, width, "..."));
        return [title, "", ...clipped, "", "Esc/q to go back"];
      },
      invalidate() {},
      handleInput(data: string) {
        if (data.includes("\x1b") || data === "escape" || data === "q" || data === "\x03") done();
      },
    };
  }

  function buildPetSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      {
        id: "pets.enabled",
        label: "Enabled",
        currentValue: String(cfg.pets.enabled),
        values: ["true", "false"],
        description:
          "Render a custom Codex pet from ${CODEX_HOME:-~/.codex}/pets in the Better OpenAI footer.",
      },
      {
        id: "pets.placement",
        label: "Placement",
        currentValue: cfg.pets.placement,
        values: [...PET_PLACEMENTS],
        description:
          "Footer layout: stacked, inline-left, inline-right, badge, or habitat divider.",
      },
      {
        id: "pets.state",
        label: "Idle state",
        currentValue: cfg.pets.state,
        values: [...PET_STATES],
        description: "Animation row to show when pi is idle.",
      },
      {
        id: "pets.thinkingState",
        label: "Thinking state",
        currentValue: cfg.pets.thinkingState,
        values: [...PET_STATES],
        description: "Animation row to show while the model is thinking or streaming.",
      },
      {
        id: "pets.toolState",
        label: "Tool state",
        currentValue: cfg.pets.toolState,
        values: [...PET_STATES],
        description: "Animation row to show during tool execution.",
      },
      {
        id: "pets.failedToolState",
        label: "Failed tool state",
        currentValue: cfg.pets.failedToolState,
        values: [...PET_STATES],
        description: "Animation row to flash after any tool call returns an error.",
      },
      {
        id: "pets.idleEmotes",
        label: "Random idle emotes",
        currentValue: String(cfg.pets.idleEmotes),
        values: ["true", "false"],
        description: "Occasionally flash a wave or jump while pi is idle.",
      },
      {
        id: "pets.idleEmoteIntervalMs",
        label: "Idle emote interval",
        currentValue: String(cfg.pets.idleEmoteIntervalMs),
        values: ["5000", "15000", "30000", "60000", "120000", "300000"],
        description: "Average delay between random idle pet emotes in milliseconds.",
      },
      {
        id: "pets.sizeCells",
        label: "Size",
        currentValue: String(cfg.pets.sizeCells),
        values: ["4", "6", "8", "10", "12", "16"],
        description: "Pet image width in terminal cells.",
      },
    ];
  }

  function petPreviewFromItem(item: SettingsPickerItem | undefined): PetState | undefined {
    if (
      item?.id !== "pets.state" &&
      item?.id !== "pets.thinkingState" &&
      item?.id !== "pets.toolState" &&
      item?.id !== "pets.failedToolState"
    )
      return undefined;
    const value = item.currentValue;
    return (PET_STATES as readonly string[]).includes(value) ? (value as PetState) : undefined;
  }

  function settingsSubmenu(
    title: string,
    items: () => SettingsPickerItem[],
    ctx: ExtensionContext,
    done: () => void,
    options?: {
      onSelection?: (item: SettingsPickerItem | undefined) => void;
      onClose?: () => void;
    },
  ) {
    const theme = getSettingsListTheme();
    let selectedIndex = 0;
    let searchQuery = "";
    let closed = false;

    function currentItems(): SettingsPickerItem[] {
      const allItems = items();
      const query = searchQuery.trim().toLowerCase();
      const current = query
        ? allItems.filter((item) => item.label.toLowerCase().includes(query))
        : allItems;
      selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, current.length - 1)));
      return current;
    }

    function selectedItem(): SettingsPickerItem | undefined {
      return currentItems()[selectedIndex];
    }

    function close(): void {
      closed = true;
      options?.onClose?.();
      done();
    }

    function cycleSelected(): void {
      const item = selectedItem();
      if (!item?.values?.length) return;
      const currentIndex = item.values.indexOf(item.currentValue);
      const newValue = item.values[(currentIndex + 1) % item.values.length] ?? item.currentValue;
      writeSetting(ctx, item.id, newValue);
      options?.onSelection?.(selectedItem());
    }

    return {
      render(width: number) {
        const current = currentItems();
        const selected = selectedItem();
        if (!closed) options?.onSelection?.(selected);
        const lines = [title, "", `> ${searchQuery}`, ""];
        const maxVisible = 8;
        const startIndex = Math.max(
          0,
          Math.min(selectedIndex - Math.floor(maxVisible / 2), current.length - maxVisible),
        );
        const visible = current.slice(startIndex, startIndex + maxVisible);
        if (current.length === 0) {
          lines.push(theme.hint("  No matching settings"));
          lines.push("", theme.hint("  Type to search · Esc to go back"));
          return lines;
        }
        const maxLabelWidth = Math.min(
          30,
          Math.max(1, ...current.map((item) => visibleWidth(item.label))),
        );
        for (let i = 0; i < visible.length; i++) {
          const item = visible[i];
          if (!item) continue;
          const itemIndex = startIndex + i;
          const isSelected = itemIndex === selectedIndex;
          const prefix = isSelected ? theme.cursor : "  ";
          const labelPadded =
            item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
          const valueMaxWidth = Math.max(1, width - visibleWidth(prefix) - maxLabelWidth - 4);
          lines.push(
            truncateToWidth(
              prefix +
                theme.label(labelPadded, isSelected) +
                "  " +
                theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected),
              width,
            ),
          );
        }
        if (selected?.description) {
          lines.push(
            "",
            theme.description(`  ${truncateToWidth(selected.description, width - 4)}`),
          );
        }
        lines.push(
          "",
          theme.hint("  Type to search · ↑↓ navigate · Enter/Space to change · Esc to go back"),
        );
        return lines;
      },
      invalidate() {},
      handleInput(data: string) {
        const current = currentItems();
        if (current.length === 0) {
          if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) close();
          else if (matchesKey(data, Key.backspace)) searchQuery = searchQuery.slice(0, -1);
          else if (data.length === 1 && data >= "!" && data <= "~") searchQuery += data;
          return;
        }
        if (matchesKey(data, Key.up))
          selectedIndex = selectedIndex === 0 ? current.length - 1 : selectedIndex - 1;
        else if (matchesKey(data, Key.down))
          selectedIndex = selectedIndex === current.length - 1 ? 0 : selectedIndex + 1;
        else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === " ")
          cycleSelected();
        else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) close();
        else if (matchesKey(data, Key.backspace)) {
          searchQuery = searchQuery.slice(0, -1);
          selectedIndex = 0;
        } else if (data.length === 1 && data >= "!" && data <= "~") {
          searchQuery += data;
          selectedIndex = 0;
        }
        if (!closed) options?.onSelection?.(selectedItem());
      },
    };
  }

  function buildSettingsItems(ctx: ExtensionContext, cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      {
        id: "fast.enabled",
        label: "Fast mode",
        currentValue: String(desiredActive),
        values: ["true", "false"],
        description: `Request OpenAI fast mode. Activates for supported models: ${modelList(cfg.supportedModels)}.`,
      },
      {
        id: "persistState",
        label: "Persist fast state",
        currentValue: String(cfg.persistState),
        values: ["true", "false"],
        description: "Remember fast-mode state across sessions.",
      },
      {
        id: "footer.mode",
        label: "Footer mode",
        currentValue: cfg.footer.mode,
        values: [...FOOTER_MODES],
        description:
          "replace = custom footer, status = pi footer plus status line, off = no Better OpenAI footer/status unless Footer pet is enabled.",
      },
      {
        id: "pets.menu",
        label: "Footer pet",
        currentValue: "configure",
        description: "Configure footer pet visibility, animation-state mapping, and size.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Footer pet settings",
            () => buildPetSettingsItems(config(ctx)),
            ctx,
            () => done(),
            {
              onSelection: (item) => {
                const previewState = petPreviewFromItem(item);
                if (previewState !== petPreviewState) {
                  petPreviewState = previewState;
                  updateFooter(ctx);
                }
              },
              onClose: () => {
                petPreviewState = undefined;
                updateFooter(ctx);
              },
            },
          ),
      },
      {
        id: "usage.enabled",
        label: "Usage display",
        currentValue: String(cfg.usage.enabled),
        values: ["true", "false"],
        description: "Fetch and display OpenAI subscription usage windows.",
      },
      {
        id: "usage.refreshIntervalMs",
        label: "Usage refresh",
        currentValue: String(cfg.usage.refreshIntervalMs),
        values: ["15000", "30000", "60000", "120000", "300000", "600000"],
        description: "Usage refresh interval in milliseconds.",
      },
      {
        id: "usage.showOnlyOnSubscriptionModels",
        label: "Usage only on OAuth",
        currentValue: String(cfg.usage.showOnlyOnSubscriptionModels),
        values: ["true", "false"],
        description: "Only show usage when the current OpenAI model uses subscription/OAuth auth.",
      },
      {
        id: "usage.showResetTimes",
        label: "Usage reset times",
        currentValue: String(cfg.usage.showResetTimes),
        values: ["true", "false"],
        description: "Include compact reset countdowns and local reset times.",
      },
      {
        id: "image.enabled",
        label: "Image tool",
        currentValue: String(cfg.image.enabled),
        values: ["true", "false"],
        description: "Allow the openai_image tool to make image requests.",
      },
      {
        id: "image.defaultModel",
        label: "Image model",
        currentValue: cfg.image.defaultModel,
        values: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5"],
        description:
          "Mainline model used for image generation when current model is not openai-codex.",
      },
      {
        id: "image.defaultSave",
        label: "Image save",
        currentValue: cfg.image.defaultSave,
        values: [...IMAGE_SAVE_MODES],
        description: "Where generated images are saved by default.",
      },
      {
        id: "image.outputFormat",
        label: "Image format",
        currentValue: cfg.image.outputFormat,
        values: [...IMAGE_OUTPUT_FORMATS],
        description: "Generated image file format.",
      },
      {
        id: "image.timeoutMs",
        label: "Image timeout",
        currentValue: String(cfg.image.timeoutMs),
        values: ["30000", "60000", "120000", "180000", "300000"],
        description: "Image request timeout in milliseconds.",
      },
      {
        id: "debug",
        label: "Debug info",
        currentValue: "open",
        description: "Show Better OpenAI diagnostics.",
        submenu: (_value, done) =>
          textPanel("Debug info", formatDebugStatus(ctx).split("\n"), () => done()),
      },
      {
        id: "config.path",
        label: "Config path",
        currentValue: cfg.configPath,
        description: `Project: ${cfg.projectConfigPath}\nGlobal: ${cfg.globalConfigPath}`,
      },
      {
        id: "config.print",
        label: "Print config",
        currentValue: "open",
        description: "Show the selected raw config JSON.",
        submenu: (_value, done) =>
          textPanel(
            "Config",
            JSON.stringify(readRawConfig(cfg.configPath), null, 2).split("\n"),
            () => done(),
          ),
      },
    ];
  }

  function writeSetting(ctx: ExtensionContext, id: string, rawValue: string): void {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    const bool = rawValue === "true";
    const num = Number(rawValue);
    if (id === "fast.enabled") {
      desiredActive = bool;
      applyDesiredFastState(ctx, cfg);
      if (cfg.persistState) {
        current.active = active;
        current.desiredActive = desiredActive;
      }
    } else if (id === "persistState") current.persistState = bool;
    else if (id.startsWith("usage.")) {
      const usage = isRecord(current.usage) ? current.usage : {};
      const key = id.slice("usage.".length);
      usage[key] = key === "refreshIntervalMs" ? num : bool;
      current.usage = usage;
    } else if (id === "footer.mode") {
      const footer = isRecord(current.footer) ? current.footer : {};
      footer.mode = rawValue;
      current.footer = footer;
    } else if (id.startsWith("pets.")) {
      const pets = isRecord(current.pets) ? current.pets : {};
      const key = id.slice("pets.".length);
      pets[key] =
        key === "sizeCells" || key === "idleEmoteIntervalMs"
          ? num
          : rawValue === "true"
            ? true
            : rawValue === "false"
              ? false
              : rawValue;
      current.pets = pets;
      if (key === "enabled" || key === "sizeCells") petLoadKey = undefined;
      if (key === "placement" || key === "sizeCells") resetPetRenderCache();
      if (key === "idleEmotes" || key === "idleEmoteIntervalMs") stopPetIdleEmotes();
    } else if (id.startsWith("image.")) {
      const image = isRecord(current.image) ? current.image : {};
      const key = id.slice("image.".length);
      image[key] =
        key === "timeoutMs"
          ? num
          : rawValue === "true"
            ? true
            : rawValue === "false"
              ? false
              : rawValue;
      current.image = image;
    }
    writeConfig(cfg.configPath, current);
    const next = refresh(ctx);
    if (id === "pets.enabled" || id === "pets.sizeCells") void refreshPet(ctx, next);
    if (id.startsWith("usage.")) {
      if (usageTimer) clearInterval(usageTimer);
      usageTimer = undefined;
      if (next.usage.enabled) startUsageRefresh(ctx);
      else {
        usageSnapshot = undefined;
        usageError = "Usage display is disabled.";
      }
    }
    updateFooter(ctx);
  }

  async function showSettingsPicker(ctx: ExtensionContext): Promise<void> {
    try {
      await ctx.ui.custom((tui, theme, _kb, done) => {
        const container = new Container();
        container.addChild(
          new (class {
            render(_width: number) {
              const cfg = config(ctx);
              return [
                theme.fg("accent", theme.bold("Better OpenAI Settings")),
                theme.fg("dim", cfg.configPath),
                "",
              ];
            }
            invalidate() {}
          })(),
        );
        const settingsList = new SettingsList(
          buildSettingsItems(ctx, refresh(ctx)),
          13,
          getSettingsListTheme(),
          (id, newValue) => {
            writeSetting(ctx, id, newValue);
            settingsList.updateValue(
              id,
              buildSettingsItems(ctx, config(ctx)).find((item) => item.id === id)?.currentValue ??
                newValue,
            );
            tui.requestRender();
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(settingsList);
        return {
          render(width: number) {
            return container.render(width);
          },
          invalidate() {
            container.invalidate();
          },
          handleInput(data: string) {
            settingsList.handleInput(data);
            tui.requestRender();
          },
        };
      });
    } finally {
      if (petPreviewState !== undefined) {
        petPreviewState = undefined;
        updateFooter(ctx);
      }
    }
  }

  pi.registerCommand(OPENAI_SETTINGS_COMMAND, {
    description: "Open Better OpenAI settings picker",
    handler: async (_args, ctx) => {
      await showSettingsPicker(ctx);
    },
  });

  registerOpenAIImage(pi, config);
  registerOpenAIPets(pi, {
    wake: async (ctx, slug) => {
      const next = writePetConfig(ctx, { enabled: true, ...(slug ? { slug } : {}) });
      updateFooter(ctx);
      await refreshPet(ctx, next, true);
    },
    tuck: (ctx) => {
      writePetConfig(ctx, { enabled: false });
      resetCodexPetKittyCache(pet, petImageId);
      pet = undefined;
      petError = undefined;
      resetPetRenderCache();
      clearPetFlash();
      stopPetIdleEmotes();
      stopPetAnimation();
      updateFooter(ctx);
      ctx.ui.notify("Footer pet tucked away.", "info");
    },
    select: async (ctx, slug) => {
      if (!slug) {
        const pets = await listCodexPets();
        ctx.ui.notify(
          pets.length
            ? `Choose one with /pets select <slug>:\n${pets.map((item) => `- ${item.slug}`).join("\n")}`
            : "No custom Codex pets found.",
          pets.length ? "info" : "warning",
        );
        return;
      }
      const next = writePetConfig(ctx, { slug });
      updateFooter(ctx);
      await refreshPet(ctx, next, true);
    },
  });

  function installFooter(ctx: ExtensionContext): void {
    if (footerInstalled) {
      requestFooterRender?.();
      return;
    }
    footerInstalled = true;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestFooterRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange?.(() => tui.requestRender());
      let lastFooterSizeKey: string | undefined;
      return {
        dispose: () => {
          unsubscribe?.();
          stopPetIdleEmotes();
          stopPetAnimation();
          stopPendingPetRenderRequest();
          footerInstalled = false;
          requestFooterRender = undefined;
        },
        invalidate() {
          resetCodexPetKittyCache(pet, petImageId);
          resetPetRenderCache();
        },
        render(width: number): string[] {
          const now = Date.now();
          const footerSizeKey = `${width}:${process.stdout.rows ?? 0}`;
          if (lastFooterSizeKey !== undefined && lastFooterSizeKey !== footerSizeKey) {
            freezePetForResize(ctx, now);
          }
          lastFooterSizeKey = footerSizeKey;
          const freezePetFrame = petResizeFrozen(now);

          const totalInput = footerTotals.input;
          const totalOutput = footerTotals.output;
          const totalCacheRead = footerTotals.cacheRead;
          const totalCacheWrite = footerTotals.cacheWrite;
          const totalCost = footerTotals.cost;

          let pwd = ctx.sessionManager.getCwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

          const branch = footerData.getGitBranch?.();
          if (branch) pwd = `${pwd} (${branch})`;

          const sessionName = ctx.sessionManager.getSessionName();
          if (sessionName) pwd = `${pwd} • ${sessionName}`;

          const parts: string[] = [];
          if (totalInput) parts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) parts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) parts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) parts.push(`W${formatTokens(totalCacheWrite)}`);

          const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
          if (totalCost || usingSubscription)
            parts.push(`$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

          const contextUsage = ctx.getContextUsage();
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const contextPercentValue = contextUsage?.percent ?? 0;
          const contextPercent =
            contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
          const contextDisplay =
            contextPercent === "?"
              ? `?/${formatTokens(contextWindow)} (auto)`
              : `${contextPercent}%/${formatTokens(contextWindow)} (auto)`;
          const contextText =
            contextPercentValue > 90
              ? theme.fg("error", contextDisplay)
              : contextPercentValue > 70
                ? theme.fg("warning", contextDisplay)
                : contextDisplay;
          parts.push(contextText);

          const cfg = config(ctx);
          const cfgForPets = cfg;
          const requestedPetPlacement = cfgForPets.pets.placement;
          const requestedPetSizeCells = petSizeCellsForPlacement(
            requestedPetPlacement,
            cfgForPets.pets.sizeCells,
          );
          const inlinePet = Boolean(
            cfgForPets.pets.enabled &&
            pet &&
            isInlinePetPlacement(requestedPetPlacement) &&
            width >= requestedPetSizeCells + 32,
          );
          const petRenderSizeCells = inlinePet ? requestedPetSizeCells : cfgForPets.pets.sizeCells;
          const petColumnWidth = Math.min(petRenderSizeCells, Math.max(1, width - 1));
          const footerTextWidth = inlinePet ? Math.max(1, width - petColumnWidth - 2) : width;

          let usageLine: string | undefined;
          if (usageSnapshot && cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg)) {
            usageLine = theme.fg("dim", formatUsageSnapshot(usageSnapshot, cfg.usage));
          }

          let statsLeft = parts.join(" ");
          let statsLeftWidth = visibleWidth(statsLeft);
          if (statsLeftWidth > footerTextWidth) {
            statsLeft = truncateToWidth(statsLeft, footerTextWidth, "...");
            statsLeftWidth = visibleWidth(statsLeft);
          }

          const modelName = ctx.model?.id || "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const fastSuffix =
            active && supportsFast(ctx, config(ctx).supportedModels) ? " fast" : "";
          let rightWithoutProvider = modelName;
          if (ctx.model?.reasoning) {
            rightWithoutProvider =
              thinkingLevel === "off"
                ? `${modelName}${fastSuffix} • thinking off`
                : `${modelName}${fastSuffix} • ${thinkingLevel}`;
          } else if (fastSuffix) {
            rightWithoutProvider = `${modelName}${fastSuffix}`;
          }

          let rightSide = rightWithoutProvider;
          if ((footerData.getAvailableProviderCount?.() ?? 0) > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightWithoutProvider}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= footerTextWidth)
              rightSide = withProvider;
          }

          const rightWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightWidth;
          let statsLine: string;
          if (totalNeeded <= footerTextWidth) {
            statsLine =
              statsLeft + " ".repeat(footerTextWidth - statsLeftWidth - rightWidth) + rightSide;
          } else {
            const availableForRight = footerTextWidth - statsLeftWidth - 2;
            if (availableForRight > 0) {
              const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
              statsLine =
                statsLeft +
                " ".repeat(
                  Math.max(0, footerTextWidth - statsLeftWidth - visibleWidth(truncatedRight)),
                ) +
                truncatedRight;
            } else {
              statsLine = statsLeft;
            }
          }

          const textLines: string[] = [
            truncateToWidth(theme.fg("dim", pwd), footerTextWidth, theme.fg("dim", "...")),
            theme.fg("dim", statsLeft) + theme.fg("dim", statsLine.slice(statsLeft.length)),
          ];

          if (usageLine) {
            textLines.push(truncateToWidth(usageLine, footerTextWidth, theme.fg("dim", "...")));
          }

          const extensionStatuses = footerData.getExtensionStatuses?.();
          if (extensionStatuses?.size) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => String(a).localeCompare(String(b)))
              .map(([, text]) => sanitizeStatusText(String(text)))
              .join(" ");
            textLines.push(truncateToWidth(statusLine, footerTextWidth, theme.fg("dim", "...")));
          }

          const petLines: string[] = [];
          if (cfgForPets.pets.enabled) {
            if (pet) {
              if (freezePetFrame && lastPetRender) {
                petLines.push(...lastPetRender.lines);
              } else {
                const { state: petState, elapsedMs } = currentPetAnimation(ctx, cfgForPets);
                const { frameIndex } = petFrameInfo(pet, petState, elapsedMs);
                const cacheKey = petRenderCacheKey(
                  pet,
                  petState,
                  frameIndex,
                  requestedPetPlacement,
                  petColumnWidth,
                  petRenderSizeCells,
                );
                const cachedPetLines = petRenderCache.get(cacheKey);
                const imageProtocol = getCapabilities().images;
                if (cachedPetLines) {
                  petLines.push(...cachedPetLines);
                  lastPetRender = { key: cacheKey, lines: cachedPetLines };
                } else {
                  const renderedPetLines = renderCodexPetFrame(
                    pet,
                    petState,
                    petColumnWidth,
                    theme,
                    {
                      sizeCells: petRenderSizeCells,
                      imageId: petImageId,
                      now: elapsedMs,
                      durationMultiplier: 1,
                    },
                  );
                  petLines.push(...renderedPetLines);
                  if (renderedPetLines.length > 0) {
                    if (imageProtocol !== null && imageProtocol !== "kitty")
                      rememberPetRender(cacheKey, renderedPetLines);
                    else lastPetRender = { key: cacheKey, lines: renderedPetLines };
                  }
                }
              }
            } else if (petError) {
              petLines.push(truncateToWidth(theme.fg("warning", `pet: ${petError}`), width, "..."));
            }
          }

          if (!cfgForPets.pets.enabled || petLines.length === 0) return textLines;

          if (inlinePet) {
            return combineInlinePetFooter(
              petLines,
              textLines,
              width,
              requestedPetPlacement,
              petColumnWidth,
            );
          }

          if (requestedPetPlacement === "habitat" && pet) {
            const label = ` ${pet.pet.name} `;
            const divider = theme.fg(
              "dim",
              truncateToWidth(`─${label}${"─".repeat(width)}`, width, ""),
            );
            return [divider, ...petLines, ...textLines];
          }

          return [...petLines, ...textLines];
        },
      };
    });
  }

  function clearFooter(ctx: ExtensionContext): void {
    if (!footerInstalled) return;
    ctx.ui.setFooter(undefined);
    footerInstalled = false;
    requestFooterRender = undefined;
  }

  function setStatus(ctx: ExtensionContext, text: string | undefined): void {
    if (!text && !statusInstalled) return;
    ctx.ui.setStatus(STATUS_KEY, text);
    statusInstalled = text !== undefined;
  }

  function updateFooter(ctx: ExtensionContext): void {
    const cfg = config(ctx);
    const resizeFrozen = petResizeFrozen();
    stopPetAnimation();
    if (cfg.pets.enabled && !resizeFrozen) startPetAnimation(ctx);
    if (!resizeFrozen && shouldRunIdleEmotes(ctx, cfg)) schedulePetIdleEmote(ctx, cfg);
    else stopPetIdleEmotes();

    if (cfg.footer.mode === "replace" || cfg.pets.enabled) {
      setStatus(ctx, undefined);
      installFooter(ctx);
      return;
    }

    clearFooter(ctx);

    if (cfg.footer.mode === "off") {
      setStatus(ctx, undefined);
      return;
    }

    const fast =
      active && supportsFast(ctx, cfg.supportedModels)
        ? `${ctx.model?.id ?? "model"} fast`
        : undefined;
    const usage =
      usageSnapshot && cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg)
        ? formatUsageSnapshot(usageSnapshot, cfg.usage)
        : undefined;
    setStatus(ctx, [fast, usage].filter(Boolean).join(" | ") || undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    const nextConfig = refresh(ctx);
    desiredActive = nextConfig.persistState ? nextConfig.desiredActive : false;
    if (pi.getFlag(FLAG) === true) desiredActive = true;
    applyDesiredFastState(ctx, nextConfig);
    if (desiredActive !== nextConfig.desiredActive || active !== nextConfig.active)
      persist(nextConfig);
    if (desiredActive && !active) {
      ctx.ui.notify(
        `Fast mode requested, but ${currentModelKey(ctx)} is unsupported. It will activate automatically when you switch to a supported model: ${modelList(nextConfig.supportedModels)}.`,
        "warning",
      );
    }
    installPetResizeGuard(ctx);
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    if (nextConfig.pets.enabled) void refreshPet(ctx, nextConfig);
    startUsageRefresh(ctx);
    if (active)
      ctx.ui.notify(stateText(ctx, desiredActive, active, nextConfig.supportedModels), "info");
  });

  pi.on("agent_start", (_event, ctx) => {
    activeToolCallIds.clear();
    clearPetFlash();
    petRuntimeState = config(ctx).pets.thinkingState;
    updateFooter(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    activeToolCallIds.add(event.toolCallId);
    petRuntimeState = config(ctx).pets.toolState;
    updateFooter(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    activeToolCallIds.delete(event.toolCallId);
    const cfg = config(ctx);
    petRuntimeState = activeToolCallIds.size > 0 ? cfg.pets.toolState : cfg.pets.thinkingState;
    if (event.isError) {
      playPetFlash(ctx, cfg.pets.failedToolState, cfg);
      return;
    }
    updateFooter(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    activeToolCallIds.clear();
    petRuntimeState = "idle";
    updateFooter(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshFooterTotals(ctx);
    updateFooter(ctx);
    void refreshUsage(ctx);
  });

  pi.on("session_compact", (_event, ctx) => {
    refreshFooterTotals(ctx);
    resetCodexPetKittyCache(pet, petImageId);
    resetPetRenderCache();
    updateFooter(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    refreshFooterTotals(ctx);
    resetCodexPetKittyCache(pet, petImageId);
    resetPetRenderCache();
    updateFooter(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    const cfg = config(ctx);
    const wasActive = active;
    applyDesiredFastState(ctx, cfg);
    if (active !== wasActive) {
      persist(cfg);
      ctx.ui.notify(
        active
          ? stateText(ctx, desiredActive, active, cfg.supportedModels)
          : `Fast mode inactive for unsupported model ${currentModelKey(ctx)}.`,
        active ? "info" : "warning",
      );
    }
    updateFooter(ctx);
    void refreshUsage(ctx, event.model.id);
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    queuedUsageRefresh = undefined;
    usageAbortController?.abort();
    usageAbortController = undefined;
    if (usageTimer) clearInterval(usageTimer);
    usageTimer = undefined;
    activeToolCallIds.clear();
    uninstallPetResizeGuard();
    resetPetRenderCache();
    clearPetFlash();
    stopPetIdleEmotes();
    stopPetAnimation();
    stopPendingPetRenderRequest();
  });

  pi.on("before_provider_request", (event, ctx) => {
    const nextConfig = config(ctx);
    if (!active || !supportsFast(ctx, nextConfig.supportedModels) || !isRecord(event.payload))
      return;
    lastInjectedAt = Date.now();
    lastInjectedModel = currentModelKey(ctx);
    lastInjectedTier = SERVICE_TIER;
    return { ...event.payload, service_tier: SERVICE_TIER };
  });
}

export const _test = {
  CONFIG_BASENAME,
  DEFAULT_SUPPORTED_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  DEFAULT_PET_CONFIG,
  SERVICE_TIER,
  configPaths,
  parseModelKey,
  normalizeModelKeys,
  parseModels,
  resolveConfig,
  readRawConfig,
  supportsFast,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  readCodexAuth,
  imageTest: _imageTest,
  petsTest: _petsTest,
};
