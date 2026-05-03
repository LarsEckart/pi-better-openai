import type { Dirent } from "node:fs";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  calculateImageRows,
  getCapabilities,
  getCellDimensions,
  Image,
  imageFallback,
  truncateToWidth,
  type AutocompleteItem,
  type ImageTheme,
} from "@mariozechner/pi-tui";
import sharp from "sharp";
import { isRecord, type PetState } from "./config.ts";

const PETS_COMMAND = "pets";
const PET_COLUMNS = 8;
const PET_ROWS = 9;
const DEFAULT_CELL_WIDTH = 192;
const DEFAULT_CELL_HEIGHT = 208;

export const PET_ANIMATION_ROWS: Record<PetState, { row: number; durations: number[] }> = {
  idle: { row: 0, durations: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, durations: [140, 140, 140, 280] },
  jumping: { row: 4, durations: [140, 140, 140, 140, 280] },
  failed: { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, durations: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, durations: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, durations: [150, 150, 150, 150, 150, 280] },
};

export type CodexPetPackage = {
  slug: string;
  id?: string;
  name: string;
  description?: string;
  dir: string;
  spritesheetPath: string;
  hasSpritesheet: boolean;
};

export type PetFrame = {
  data?: string;
  rawRgbaData?: string;
  kittyImageId?: number;
  kittyUploaded?: boolean;
  mimeType: "image/png";
  durationMs: number;
  widthPx: number;
  heightPx: number;
};

export type LoadedCodexPet = {
  pet: CodexPetPackage;
  states: Record<PetState, PetFrame[]>;
};

export type PetsCommandController = {
  wake?: (ctx: ExtensionContext, slug?: string) => Promise<void> | void;
  tuck?: (ctx: ExtensionContext) => Promise<void> | void;
  select?: (ctx: ExtensionContext, slug?: string) => Promise<void> | void;
};

type ThemeLike = {
  fg(color: string, value: string): string;
};

export function codexHome(env = process.env, home = homedir()): string {
  return env.CODEX_HOME?.trim() || join(home, ".codex");
}

export function codexPetsDir(home = codexHome()): string {
  return join(home, "pets");
}

function petInfoFromJson(
  value: unknown,
  fallback: string,
): { id?: string; name: string; description?: string; spritesheetPath: string } {
  if (!isRecord(value)) return { name: fallback, spritesheetPath: "spritesheet.webp" };
  const id = typeof value.id === "string" && value.id.trim() ? value.id.trim() : undefined;
  const displayName =
    typeof value.displayName === "string" && value.displayName.trim()
      ? value.displayName.trim()
      : undefined;
  const name =
    displayName ??
    (typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined) ??
    id ??
    fallback;
  const description =
    typeof value.description === "string" && value.description.trim()
      ? value.description.trim()
      : undefined;
  const spritesheetPath =
    typeof value.spritesheetPath === "string" && value.spritesheetPath.trim()
      ? value.spritesheetPath.trim()
      : "spritesheet.webp";
  return { id, name, description, spritesheetPath };
}

function resolvePetAssetPath(petDir: string, path: string): string | undefined {
  const resolvedPetDir = resolve(petDir);
  const resolved = resolve(resolvedPetDir, path);
  const prefix = resolvedPetDir.endsWith(sep) ? resolvedPetDir : `${resolvedPetDir}${sep}`;
  return resolved === resolvedPetDir || resolved.startsWith(prefix) ? resolved : undefined;
}

export async function listCodexPets(home = codexHome()): Promise<CodexPetPackage[]> {
  const dir = codexPetsDir(home);
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const pets: CodexPetPackage[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const petDir = join(dir, entry.name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(petDir, "pet.json"), "utf8")) as unknown;
    } catch {
      continue;
    }
    const { id, name, description, spritesheetPath } = petInfoFromJson(parsed, entry.name);
    let hasSpritesheet = false;
    try {
      const resolvedSpritesheetPath = resolvePetAssetPath(petDir, spritesheetPath);
      if (resolvedSpritesheetPath) {
        await access(resolvedSpritesheetPath);
        hasSpritesheet = true;
      }
    } catch {
      hasSpritesheet = false;
    }
    pets.push({
      slug: entry.name,
      id,
      name,
      description,
      dir: petDir,
      spritesheetPath,
      hasSpritesheet,
    });
  }
  return pets.sort((a, b) => a.name.localeCompare(b.name));
}

function petLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function selectPet(pets: CodexPetPackage[], slug?: string): CodexPetPackage | undefined {
  const ready = pets.filter((pet) => pet.hasSpritesheet);
  if (slug?.trim()) {
    const requested = petLookupKey(slug.trim());
    return ready.find(
      (pet) =>
        petLookupKey(pet.slug) === requested ||
        (pet.id !== undefined && petLookupKey(pet.id) === requested) ||
        petLookupKey(pet.name) === requested,
    );
  }
  return ready[0];
}

function kittyImageBaseForPet(slug: string): number {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) % 0xffff;
  return 0x50000000 + hash * 100;
}

export async function loadCodexPet(
  slug?: string,
  home = codexHome(),
  options: { sizeCells?: number } = {},
): Promise<LoadedCodexPet | undefined> {
  const pet = selectPet(await listCodexPets(home), slug);
  if (!pet) return undefined;

  const spritesheetPath = resolvePetAssetPath(pet.dir, pet.spritesheetPath);
  if (!spritesheetPath)
    throw new Error(`Invalid spritesheetPath outside pet folder: ${pet.spritesheetPath}`);
  const source = sharp(spritesheetPath, { animated: false });
  const metadata = await source.metadata();
  if (
    metadata.width !== DEFAULT_CELL_WIDTH * PET_COLUMNS ||
    metadata.height !== DEFAULT_CELL_HEIGHT * PET_ROWS
  ) {
    throw new Error(
      `Invalid Codex pet atlas dimensions: ${metadata.width ?? "?"}x${metadata.height ?? "?"}; expected ${DEFAULT_CELL_WIDTH * PET_COLUMNS}x${DEFAULT_CELL_HEIGHT * PET_ROWS}.`,
    );
  }
  const cellWidth = DEFAULT_CELL_WIDTH;
  const cellHeight = DEFAULT_CELL_HEIGHT;
  const states = {} as Record<PetState, PetFrame[]>;
  const imageProtocol = getCapabilities().images;
  const useKitty = imageProtocol === "kitty";
  const kittyImageBase = kittyImageBaseForPet(pet.slug);
  let kittyFrameOffset = 1;
  const cellDimensions = getCellDimensions();
  const targetWidthPx = options.sizeCells
    ? Math.max(1, Math.round(options.sizeCells * cellDimensions.widthPx))
    : undefined;
  const targetHeightPx = targetWidthPx
    ? Math.max(
        1,
        Math.ceil((cellHeight * targetWidthPx) / cellWidth / cellDimensions.heightPx) *
          cellDimensions.heightPx,
      )
    : undefined;

  for (const [state, animation] of Object.entries(PET_ANIMATION_ROWS) as Array<
    [PetState, (typeof PET_ANIMATION_ROWS)[PetState]]
  >) {
    states[state] = [];
    for (let column = 0; column < animation.durations.length; column++) {
      const durationMs = animation.durations[column] ?? 150;
      const frameWidthPx = targetWidthPx ?? cellWidth;
      const frameHeightPx = targetHeightPx ?? cellHeight;
      if (!imageProtocol) {
        states[state].push({
          mimeType: "image/png",
          durationMs,
          widthPx: frameWidthPx,
          heightPx: frameHeightPx,
        });
        continue;
      }

      let frame = source.clone().extract({
        left: column * cellWidth,
        top: animation.row * cellHeight,
        width: cellWidth,
        height: cellHeight,
      });
      if (targetWidthPx && targetHeightPx) {
        frame = frame.resize(targetWidthPx, targetHeightPx, {
          fit: "fill",
          kernel: sharp.kernel.nearest,
        });
      }
      const encoded = useKitty
        ? { rawRgbaData: (await frame.clone().ensureAlpha().raw().toBuffer()).toString("base64") }
        : { data: (await frame.clone().png().toBuffer()).toString("base64") };
      states[state].push({
        ...encoded,
        kittyImageId: useKitty ? kittyImageBase + kittyFrameOffset++ : undefined,
        mimeType: "image/png",
        durationMs,
        widthPx: frameWidthPx,
        heightPx: frameHeightPx,
      });
    }
  }

  return { pet, states };
}

function animationCursor(frames: PetFrame[], now = Date.now(), durationMultiplier = 1) {
  const multiplier = Math.max(0.1, durationMultiplier);
  const total = frames.reduce((sum, frame) => sum + frame.durationMs * multiplier, 0);
  return { multiplier, total, cursor: total > 0 ? now % total : 0 };
}

export function animationFrameAt(
  frames: PetFrame[],
  now = Date.now(),
  durationMultiplier = 1,
): PetFrame | undefined {
  if (frames.length === 0) return undefined;
  let { cursor, multiplier } = animationCursor(frames, now, durationMultiplier);
  for (const frame of frames) {
    cursor -= frame.durationMs * multiplier;
    if (cursor < 0) return frame;
  }
  return frames[0];
}

export function nextAnimationFrameDelayMs(
  frames: PetFrame[],
  now = Date.now(),
  durationMultiplier = 1,
): number {
  if (frames.length === 0) return 120;
  let { cursor, multiplier } = animationCursor(frames, now, durationMultiplier);
  for (const frame of frames) {
    const duration = frame.durationMs * multiplier;
    if (cursor < duration) return Math.max(1, Math.ceil(duration - cursor));
    cursor -= duration;
  }
  return Math.max(1, Math.ceil(frames[0]?.durationMs ?? 120));
}

const previousKittyFrameByPlacement = new Map<number, number>();

export function resetCodexPetKittyCache(pet?: LoadedCodexPet, placementImageId?: number): void {
  if (placementImageId !== undefined) previousKittyFrameByPlacement.delete(placementImageId);
  if (!pet) return;
  for (const frames of Object.values(pet.states)) {
    for (const frame of frames) frame.kittyUploaded = false;
  }
}

export function deleteCodexPetKittyPlacement(imageId: number): string {
  return `\x1b_Ga=d,d=i,i=${imageId},p=1,q=2\x1b\\`;
}

function placeKittyImage(imageId: number, columns: number, rows: number): string {
  return `\x1b_Ga=p,i=${imageId},p=1,c=${columns},r=${rows},q=2\x1b\\`;
}

function encodeKittyRawRgba(frame: PetFrame, imageId: number): string {
  const rawRgbaData = frame.rawRgbaData;
  if (!rawRgbaData) return "";
  const chunkSize = 4096;
  const params = [
    "a=t",
    "f=32",
    `s=${frame.widthPx}`,
    `v=${frame.heightPx}`,
    `i=${imageId}`,
    "q=2",
  ];
  if (rawRgbaData.length <= chunkSize) {
    return `\x1b_G${params.join(",")};${rawRgbaData}\x1b\\`;
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < rawRgbaData.length; offset += chunkSize) {
    const chunk = rawRgbaData.slice(offset, offset + chunkSize);
    const first = offset === 0;
    const last = offset + chunkSize >= rawRgbaData.length;
    if (first) chunks.push(`\x1b_G${params.join(",")},m=1;${chunk}\x1b\\`);
    else chunks.push(`\x1b_Gm=${last ? 0 : 1};${chunk}\x1b\\`);
  }
  return chunks.join("");
}

function renderKittyPetFrame(
  frame: PetFrame,
  width: number,
  options: { sizeCells: number; imageId: number },
): string[] {
  const columns = Math.max(1, Math.min(Math.max(1, width - 2), options.sizeCells));
  const rows = calculateImageRows(
    { widthPx: frame.widthPx, heightPx: frame.heightPx },
    columns,
    getCellDimensions(),
  );
  const frameImageId = frame.kittyImageId ?? options.imageId;
  const previousFrameImageId = previousKittyFrameByPlacement.get(options.imageId);
  const deletePrevious =
    previousFrameImageId !== undefined && previousFrameImageId !== frameImageId
      ? deleteCodexPetKittyPlacement(previousFrameImageId)
      : "";
  const deleteCurrent = deleteCodexPetKittyPlacement(frameImageId);
  const upload = frame.kittyUploaded ? "" : encodeKittyRawRgba(frame, frameImageId);
  frame.kittyUploaded = true;
  previousKittyFrameByPlacement.set(options.imageId, frameImageId);
  const sequence = `${deletePrevious}${deleteCurrent}${upload}${placeKittyImage(frameImageId, columns, rows)}`;
  const lines: string[] = [];
  for (let i = 0; i < rows - 1; i++) lines.push("");
  const moveUp = rows > 1 ? `\x1b[${rows - 1}A` : "";
  lines.push(moveUp + sequence);
  return lines;
}

export function renderCodexPetFrame(
  pet: LoadedCodexPet,
  state: PetState,
  width: number,
  theme: ThemeLike,
  options: { sizeCells: number; imageId: number; now?: number; durationMultiplier?: number },
): string[] {
  const frame = animationFrameAt(
    pet.states[state] ?? pet.states.idle,
    options.now,
    options.durationMultiplier,
  );
  if (!frame) return [];
  const imageProtocol = getCapabilities().images;
  if (imageProtocol === "kitty") return renderKittyPetFrame(frame, width, options);
  if (!imageProtocol) {
    const fallback = imageFallback(frame.mimeType, {
      widthPx: frame.widthPx,
      heightPx: frame.heightPx,
    });
    return [truncateToWidth(theme.fg("dim", fallback), width, theme.fg("dim", "..."))];
  }

  if (!frame.data) return [];
  const imageTheme: ImageTheme = { fallbackColor: (value) => theme.fg("dim", value) };
  const image = new Image(
    frame.data,
    frame.mimeType,
    imageTheme,
    { maxWidthCells: Math.min(options.sizeCells, width), imageId: options.imageId },
    { widthPx: frame.widthPx, heightPx: frame.heightPx },
  );
  return image.render(width);
}

export function formatCodexPetsHelp(home = codexHome()): string {
  return [
    "Codex pets can now render in the pi Better OpenAI footer too.",
    "",
    "Commands:",
    `  /${PETS_COMMAND} wake [slug]   Render a custom Codex pet in the footer`,
    `  /${PETS_COMMAND} tuck          Hide the footer pet`,
    `  /${PETS_COMMAND} select <slug> Select a pet without changing visibility`,
    `  /${PETS_COMMAND} list          List local custom pets`,
    "",
    "Create a custom Codex pet:",
    "  $skill-installer hatch-pet",
    "  Cmd/Ctrl+K → Force Reload Skills",
    "  $hatch-pet create a new pet inspired by pi-better-openai",
    "",
    `Custom pet folder: ${codexPetsDir(home)}/<pet-name>/`,
    "Expected files: pet.json and spritesheet.webp",
    "",
    "The Codex app overlay is still controlled by Codex Settings → Appearance → Pets or /pet.",
  ].join("\n");
}

const PET_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "help", label: "help", description: "Show Codex pets setup and usage help" },
  { value: "list", label: "list", description: "List local custom Codex pets" },
  { value: "wake", label: "wake", description: "Render a footer pet" },
  { value: "tuck", label: "tuck", description: "Hide the footer pet" },
  {
    value: "select",
    label: "select",
    description: "Select a footer pet without changing visibility",
  },
];

function petCompletionValue(subcommand: string, pet: CodexPetPackage): string {
  return `${subcommand} ${pet.name}`;
}

export async function openAIPetsArgumentCompletions(
  argumentPrefix: string,
  home = codexHome(),
): Promise<AutocompleteItem[] | null> {
  const normalizedPrefix = argumentPrefix.trimStart();
  const parts = normalizedPrefix.split(/\s+/).filter(Boolean);
  const hasTrailingSpace = /\s$/.test(normalizedPrefix);
  const subcommand = parts[0]?.toLowerCase();

  if (!subcommand || (!hasTrailingSpace && parts.length <= 1)) {
    const query = subcommand ?? "";
    const matches = PET_SUBCOMMANDS.filter((item) => item.value.startsWith(query));
    return matches.length > 0 ? matches : null;
  }

  if (subcommand !== "wake" && subcommand !== "select") return null;

  const petQuery = hasTrailingSpace ? "" : parts.slice(1).join(" ");
  const normalizedPetQuery = petLookupKey(petQuery);
  const pets = (await listCodexPets(home)).filter((pet) => pet.hasSpritesheet);
  const matches = pets.filter((pet) => {
    if (!normalizedPetQuery) return true;
    return (
      petLookupKey(pet.slug).includes(normalizedPetQuery) ||
      (pet.id !== undefined && petLookupKey(pet.id).includes(normalizedPetQuery)) ||
      petLookupKey(pet.name).includes(normalizedPetQuery)
    );
  });
  return matches.length > 0
    ? matches.map((pet) => ({
        value: petCompletionValue(subcommand, pet),
        label: pet.name,
        description: `${pet.slug}${pet.description ? ` — ${pet.description}` : ""}`,
      }))
    : null;
}

async function notifyPetsList(ctx: ExtensionContext): Promise<void> {
  const home = codexHome();
  const pets = await listCodexPets(home);
  if (pets.length === 0) {
    ctx.ui.notify(`No custom Codex pets found in ${codexPetsDir(home)}.`, "warning");
    return;
  }
  ctx.ui.notify(
    pets
      .map((pet) => {
        const status = pet.hasSpritesheet ? "ready" : "missing spritesheet.webp";
        return `${pet.name} (${pet.slug}) — ${status}${pet.description ? `\n  ${pet.description}` : ""}`;
      })
      .join("\n"),
    "info",
  );
}

export function registerOpenAIPets(pi: ExtensionAPI, controller: PetsCommandController = {}): void {
  pi.registerCommand(PETS_COMMAND, {
    description: "Render, configure, or list Codex pets for the Better OpenAI footer",
    getArgumentCompletions: openAIPetsArgumentCompletions,
    handler: async (args, ctx) => {
      const [subcommand = "help", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const normalized = subcommand.toLowerCase();
      const slug = rest.join(" ").trim() || undefined;
      if (normalized === "help") {
        ctx.ui.notify(formatCodexPetsHelp(), "info");
        return;
      }
      if (normalized === "list") {
        await notifyPetsList(ctx);
        return;
      }
      if (normalized === "wake" && controller.wake) {
        await controller.wake(ctx, slug);
        return;
      }
      if (normalized === "tuck" && controller.tuck) {
        await controller.tuck(ctx);
        return;
      }
      if (normalized === "select" && controller.select) {
        await controller.select(ctx, slug);
        return;
      }
      ctx.ui.notify(`Usage: /${PETS_COMMAND} [help|list|wake [slug]|tuck|select <slug>]`, "error");
    },
  });
}

export const _petsTest = {
  PETS_COMMAND,
  codexPetsDir,
  petInfoFromJson,
  petLookupKey,
  selectPet,
};
