import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { maskIdentifier } from "./format.ts";
import {
  AUTH_FILE,
  type UsageSnapshot,
  formatResetCountdown,
  formatUsageSnapshot,
  parseUsageSnapshot,
  readCodexAuth,
  requestCodexUsage,
} from "./usage.ts";
import { currentModelKey } from "./fast-controller.ts";

export function isOpenAISubscriptionModel(ctx: ExtensionContext, cfg: ResolvedConfig): boolean {
  if (!ctx.model || (ctx.model.provider !== "openai" && ctx.model.provider !== "openai-codex"))
    return false;
  return !cfg.usage.showOnlyOnSubscriptionModels || ctx.modelRegistry.isUsingOAuth(ctx.model);
}

type UsageRefreshOptions = { notify?: boolean; force?: boolean };

type QueuedUsageRefresh = {
  ctx: ExtensionContext;
  modelId?: string;
  notify?: boolean;
  force?: boolean;
};

export class UsageController {
  private usageSnapshot: UsageSnapshot | undefined;
  private usageUpdatedAt: number | undefined;
  private usageError: string | undefined;
  private usageLastFetchAt: number | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private usageRefreshInFlight = false;
  private queuedUsageRefresh: QueuedUsageRefresh | undefined;
  private shuttingDown = false;
  private usageAbortController: AbortController | undefined;
  private sessionAbortSignal: AbortSignal | undefined;
  private sessionAbortHandler: (() => void) | undefined;

  constructor(
    private readonly getConfig: (ctx: ExtensionContext) => ResolvedConfig,
    private readonly updateFooter: (ctx: ExtensionContext) => void,
  ) {}

  get snapshot(): UsageSnapshot | undefined {
    return this.usageSnapshot;
  }

  statusLine(ctx: ExtensionContext, cfg = this.getConfig(ctx)): string | undefined {
    return this.usageSnapshot && cfg.usage.enabled && isOpenAISubscriptionModel(ctx, cfg)
      ? formatUsageSnapshot(this.usageSnapshot, cfg.usage)
      : undefined;
  }

  formatStatus(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return "Usage display is disabled.";
    if (!isOpenAISubscriptionModel(ctx, cfg))
      return "Usage hidden: current model is not an OpenAI subscription model.";
    if (!this.usageSnapshot)
      return `Usage unavailable${this.usageError ? `: ${this.usageError}` : "."}`;
    const stale =
      this.usageUpdatedAt && Date.now() - this.usageUpdatedAt > cfg.usage.refreshIntervalMs * 2
        ? ` | stale ${formatResetCountdown((Date.now() - this.usageUpdatedAt) / 1000)}`
        : "";
    return `${formatUsageSnapshot(this.usageSnapshot, cfg.usage)}${stale}`;
  }

  formatDebug(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    const auth = readCodexAuth();
    return [
      `Usage enabled: ${cfg.usage.enabled}`,
      `Current model: ${currentModelKey(ctx)}`,
      `Current model eligible: ${isOpenAISubscriptionModel(ctx, cfg)}`,
      `Requires subscription model: ${cfg.usage.showOnlyOnSubscriptionModels}`,
      `Auth: ${auth ? "found" : "missing"}`,
      `Account ID: ${maskIdentifier(auth?.accountId) ?? "none"}`,
      `Last fetch: ${this.usageLastFetchAt ? new Date(this.usageLastFetchAt).toLocaleTimeString() : "never"}`,
      `Last successful update: ${this.usageUpdatedAt ? new Date(this.usageUpdatedAt).toLocaleTimeString() : "never"}`,
      `Last error: ${this.usageError ?? "none"}`,
      `Refresh interval: ${cfg.usage.refreshIntervalMs}ms`,
      `Endpoint: https://chatgpt.com/backend-api/wham/usage`,
    ].join("\n");
  }

  async refresh(
    ctx: ExtensionContext,
    modelId = ctx.model?.id,
    options?: UsageRefreshOptions,
  ): Promise<void> {
    if (this.shuttingDown || !ctx.hasUI) return;
    if (this.usageRefreshInFlight) {
      this.queuedUsageRefresh = {
        ctx,
        modelId,
        notify: this.queuedUsageRefresh?.notify || options?.notify,
        force: this.queuedUsageRefresh?.force || options?.force,
      };
      return;
    }
    this.usageRefreshInFlight = true;
    const cfg = this.getConfig(ctx);
    try {
      if (!cfg.usage.enabled) {
        this.usageSnapshot = undefined;
        this.usageError = "Usage display is disabled.";
        if (!this.shuttingDown) this.updateFooter(ctx);
        if (!this.shuttingDown && options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
        return;
      }
      if (!isOpenAISubscriptionModel(ctx, cfg)) {
        if (!this.shuttingDown) this.updateFooter(ctx);
        if (!this.shuttingDown && options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
        return;
      }
      const shouldThrottle =
        !options?.force &&
        !options?.notify &&
        this.usageLastFetchAt !== undefined &&
        Date.now() - this.usageLastFetchAt < cfg.usage.refreshIntervalMs &&
        this.usageSnapshot !== undefined &&
        this.usageError === undefined;
      if (shouldThrottle) {
        if (!this.shuttingDown) this.updateFooter(ctx);
        return;
      }
      this.usageAbortController = new AbortController();
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal, this.usageAbortController.signal])
        : AbortSignal.any([timeoutSignal, this.usageAbortController.signal]);
      const data = await requestCodexUsage(ctx, signal);
      this.usageLastFetchAt = Date.now();
      this.usageSnapshot = data ? parseUsageSnapshot(data, modelId) : undefined;
      this.usageUpdatedAt = this.usageSnapshot ? Date.now() : undefined;
      this.usageError = data
        ? undefined
        : `Missing openai-codex OAuth credentials in ${AUTH_FILE}.`;
      if (!this.shuttingDown) this.updateFooter(ctx);
      if (!this.shuttingDown && options?.notify)
        ctx.ui.notify(this.formatStatus(ctx), this.usageSnapshot ? "info" : "warning");
    } catch (error) {
      if (this.shuttingDown) return;
      this.usageError = error instanceof Error ? error.message : String(error);
      this.updateFooter(ctx);
      if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
    } finally {
      this.usageAbortController = undefined;
      this.usageRefreshInFlight = false;
      if (!this.shuttingDown && this.queuedUsageRefresh) {
        const next = this.queuedUsageRefresh;
        this.queuedUsageRefresh = undefined;
        void this.refresh(next.ctx, next.modelId, { notify: next.notify, force: next.force });
      }
    }
  }

  private stopTimer(): void {
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.sessionAbortSignal && this.sessionAbortHandler) {
      this.sessionAbortSignal.removeEventListener("abort", this.sessionAbortHandler);
    }
    this.sessionAbortSignal = undefined;
    this.sessionAbortHandler = undefined;
  }

  start(ctx: ExtensionContext): void {
    this.shuttingDown = false;
    this.stopTimer();
    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return;
    const sessionSignal = ctx.signal;
    if (sessionSignal?.aborted) return;
    this.sessionAbortSignal = sessionSignal;
    this.sessionAbortHandler = () => {
      this.stopTimer();
      this.usageAbortController?.abort();
      this.usageAbortController = undefined;
      this.queuedUsageRefresh = undefined;
    };
    sessionSignal?.addEventListener("abort", this.sessionAbortHandler, { once: true });
    void this.refresh(ctx, undefined, { force: true });
    this.usageTimer = setInterval(() => {
      if (sessionSignal?.aborted) {
        this.stopTimer();
        return;
      }
      void this.refresh(ctx);
    }, cfg.usage.refreshIntervalMs);
    this.usageTimer.unref?.();
  }

  restartAfterSettingsChange(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    this.stopTimer();
    if (cfg.usage.enabled) this.start(ctx);
    else {
      this.usageSnapshot = undefined;
      this.usageError = "Usage display is disabled.";
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.queuedUsageRefresh = undefined;
    this.usageAbortController?.abort();
    this.usageAbortController = undefined;
    this.stopTimer();
  }
}
