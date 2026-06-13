import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
export const AUTH_FILE = join(AGENT_DIR, "auth.json");

export type CodexCredentials = {
  accessToken: string;
  accountId: string;
};

export type CodexCredentialsWithSource = CodexCredentials & {
  source: "modelRegistry" | "authFile";
};

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function extractAccountIdFromJwt(token: string): string | undefined {
  try {
    const [, payload] = token.split(".");
    if (!payload) return undefined;
    const parsed = JSON.parse(decodeBase64Url(payload)) as unknown;
    if (!isRecord(parsed)) return undefined;
    const auth = parsed["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function parseCodexRegistryCredentials(
  raw: string | undefined,
): CodexCredentials | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isRecord(parsed)) {
      const accessToken =
        typeof parsed.access === "string"
          ? parsed.access
          : typeof parsed.token === "string"
            ? parsed.token
            : undefined;
      const accountId =
        typeof parsed.accountId === "string"
          ? parsed.accountId
          : typeof parsed.account_id === "string"
            ? parsed.account_id
            : undefined;
      if (accessToken?.trim() && accountId?.trim())
        return { accessToken: accessToken.trim(), accountId: accountId.trim() };
    }
  } catch {
    // Plain bearer token is expected for openai-codex in pi.
  }
  const accountId = extractAccountIdFromJwt(value);
  return accountId ? { accessToken: value, accountId } : undefined;
}

export function readCodexAuth(): CodexCredentials | undefined {
  try {
    const auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")) as Record<
      string,
      | {
          type?: string;
          access?: string | null;
          accountId?: string | null;
          account_id?: string | null;
        }
      | undefined
    >;
    const entry = auth["openai-codex"];
    if (entry?.type !== "oauth") return undefined;
    const accessToken = entry.access?.trim();
    const accountId = (entry.accountId ?? entry.account_id)?.trim();
    return accessToken && accountId ? { accessToken, accountId } : undefined;
  } catch {
    return undefined;
  }
}

export async function getCodexCredentials(
  ctx?: Pick<ExtensionContext, "modelRegistry">,
): Promise<CodexCredentialsWithSource | undefined> {
  const registryToken = await ctx?.modelRegistry
    ?.getApiKeyForProvider("openai-codex")
    .catch(() => undefined);
  const registryCredentials = parseCodexRegistryCredentials(registryToken);
  if (registryCredentials) return { ...registryCredentials, source: "modelRegistry" };
  const auth = readCodexAuth();
  return auth ? { ...auth, source: "authFile" } : undefined;
}
