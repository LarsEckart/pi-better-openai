import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@mariozechner/pi-tui";
import sharp from "sharp";
import { _test } from "../index.ts";
import {
  type LoadedCodexPet,
  type PetFrame,
  animationFrameAt,
  codexHome,
  deleteCodexPetKittyPlacement,
  describeCodexPetSelectionIssue,
  formatCodexPetsHelp,
  formatCodexPetsListMessage,
  formatNoReadyCodexPetsMessage,
  listCodexPets,
  loadCodexPet,
  nextAnimationFrameDelayMs,
  openAIPetsArgumentCompletions,
  PET_ANIMATION_ROWS,
  renderCodexPetFrame,
} from "../src/pets.ts";

afterEach(() => {
  resetCapabilitiesCache();
});

describe("Codex pets helpers", () => {
  test("resolves Codex home and pets directory", () => {
    expect(codexHome({ CODEX_HOME: "/tmp/codex" }, "/home/user")).toBe("/tmp/codex");
    expect(codexHome({}, "/home/user")).toBe("/home/user/.codex");
    expect(_test.petsTest.codexPetsDir("/tmp/codex")).toBe("/tmp/codex/pets");
  });

  test("lists valid local custom pets", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-better-openai-pets-"));
    try {
      const petsDir = join(tempDir, "pets");
      const petDir = join(petsDir, "stacky-plus");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(
        join(petDir, "pet.json"),
        JSON.stringify({
          id: "stacky-plus",
          displayName: "Stacky Plus",
          description: "A stack of helpful tokens.",
          spritesheetPath: "spritesheet.webp",
        }),
      );
      writeFileSync(join(petDir, "spritesheet.webp"), "webp");

      mkdirSync(join(petsDir, "broken"), { recursive: true });
      writeFileSync(join(petsDir, "broken", "spritesheet.webp"), "webp");

      const pets = await listCodexPets(tempDir);
      expect(pets).toHaveLength(1);
      expect(pets[0]).toMatchObject({
        slug: "stacky-plus",
        name: "Stacky Plus",
        description: "A stack of helpful tokens.",
        id: "stacky-plus",
        hasSpritesheet: true,
      });
      expect(_test.petsTest.selectPet(pets, "Stacky Plus")?.slug).toBe("stacky-plus");
      expect(_test.petsTest.selectPet(pets, "STACKY_PLUS")?.slug).toBe("stacky-plus");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns empty lists and actionable setup text when no pets exist", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-better-openai-pets-empty-"));
    try {
      expect(await listCodexPets(tempDir)).toEqual([]);
      const missingDirMessage = formatNoReadyCodexPetsMessage([], tempDir);
      expect(missingDirMessage).toContain("No custom Codex pets found.");
      expect(missingDirMessage).toContain(join(tempDir, "pets"));
      expect(missingDirMessage).toContain("$skill-installer hatch-pet");

      mkdirSync(join(tempDir, "pets"), { recursive: true });
      expect(await listCodexPets(tempDir)).toEqual([]);
      expect(formatCodexPetsListMessage([], tempDir)).toContain("Expected folder:");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("reports custom pets that are missing spritesheets as not ready", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-better-openai-pets-broken-"));
    try {
      const petDir = join(tempDir, "pets", "ghost");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Ghost" }));

      const pets = await listCodexPets(tempDir);
      expect(pets).toHaveLength(1);
      expect(pets[0]).toMatchObject({ slug: "ghost", hasSpritesheet: false });
      expect(formatCodexPetsListMessage(pets, tempDir)).toContain(
        "Ghost (ghost) — missing spritesheet.webp",
      );

      const issue = describeCodexPetSelectionIssue(pets, "ghost", tempDir);
      expect(issue.short).toBe('Pet "Ghost" is not ready.');
      expect(issue.message).toContain("exists but is not ready");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("explains requested pet slugs that do not match a ready pet", () => {
    const pets = [
      {
        slug: "stacky-plus",
        name: "Stacky Plus",
        dir: "/tmp/stacky-plus",
        spritesheetPath: "spritesheet.webp",
        hasSpritesheet: true,
      },
    ];

    const issue = describeCodexPetSelectionIssue(pets, "missing", "/tmp/codex");
    expect(issue.short).toBe('No ready pet matching "missing".');
    expect(issue.message).toContain("Ready pets:");
    expect(issue.message).toContain("stacky-plus");
  });

  test("formats /pets select prompts with only ready pets as choices", () => {
    const pets = [
      {
        slug: "ready",
        name: "Ready",
        dir: "/tmp/ready",
        spritesheetPath: "spritesheet.webp",
        hasSpritesheet: true,
      },
      {
        slug: "broken",
        name: "Broken",
        dir: "/tmp/broken",
        spritesheetPath: "spritesheet.webp",
        hasSpritesheet: false,
      },
    ];

    expect(_test.formatPetSelectPrompt(pets, "/tmp/codex")).toEqual({
      message:
        "Choose one with /pets select <slug>:\n- ready (Ready)\n\nNot ready:\n- broken (Broken) — missing spritesheet.webp",
      level: "info",
    });

    const noReadyPrompt = _test.formatPetSelectPrompt([pets[1]], "/tmp/codex");
    expect(noReadyPrompt.level).toBe("warning");
    expect(noReadyPrompt.message).toContain("Found custom Codex pets, but none are ready.");
  });

  test("uses the official Codex atlas row order and frame durations", () => {
    expect(Object.entries(PET_ANIMATION_ROWS)).toEqual([
      ["idle", { row: 0, durations: [280, 110, 110, 140, 140, 320] }],
      ["running-right", { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] }],
      ["running-left", { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] }],
      ["waving", { row: 3, durations: [140, 140, 140, 280] }],
      ["jumping", { row: 4, durations: [140, 140, 140, 140, 280] }],
      ["failed", { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] }],
      ["waiting", { row: 6, durations: [150, 150, 150, 150, 150, 260] }],
      ["running", { row: 7, durations: [120, 120, 120, 120, 120, 220] }],
      ["review", { row: 8, durations: [150, 150, 150, 150, 150, 280] }],
    ]);
  });

  test("loads and slices a Codex pet spritesheet", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-better-openai-pet-load-"));
    try {
      const petDir = join(tempDir, "pets", "tiny");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Tiny" }));
      const sheet = await sharp({
        create: {
          width: 1536,
          height: 1872,
          channels: 4,
          background: { r: 255, g: 0, b: 0, alpha: 1 },
        },
      })
        .webp()
        .toBuffer();
      writeFileSync(join(petDir, "spritesheet.webp"), sheet);

      const loaded = await loadCodexPet("tiny", tempDir);
      expect(loaded?.pet.name).toBe("Tiny");
      expect(loaded?.states.idle).toHaveLength(6);
      expect(loaded?.states.idle[0]).toMatchObject({
        mimeType: "image/png",
        durationMs: 280,
        widthPx: 192,
        heightPx: 208,
      });
      expect(animationFrameAt(loaded?.states.idle ?? [], 0)?.durationMs).toBe(280);
      expect(animationFrameAt(loaded?.states.idle ?? [], 559)?.durationMs).toBe(140);
      expect(animationFrameAt(loaded?.states.idle ?? [], 559, 2)?.durationMs).toBe(280);
      expect(nextAnimationFrameDelayMs(loaded?.states.idle ?? [], 0)).toBe(280);
      expect(nextAnimationFrameDelayMs(loaded?.states.idle ?? [], 279)).toBe(1);
      expect(nextAnimationFrameDelayMs(loaded?.states.idle ?? [], 280)).toBe(110);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("avoids per-frame image encoding and animation output when terminal images are unsupported", async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    const tempDir = await mkdtemp(join(tmpdir(), "pi-better-openai-pet-no-images-"));
    try {
      const petDir = join(tempDir, "pets", "fallback");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Fallback" }));
      const sheet = await sharp({
        create: {
          width: 1536,
          height: 1872,
          channels: 4,
          background: { r: 0, g: 255, b: 0, alpha: 1 },
        },
      })
        .webp()
        .toBuffer();
      writeFileSync(join(petDir, "spritesheet.webp"), sheet);

      const loaded = await loadCodexPet("fallback", tempDir);
      const firstFrame = loaded?.states.idle[0];
      expect(firstFrame?.data).toBeUndefined();
      expect(firstFrame?.rawRgbaData).toBeUndefined();
      expect(firstFrame).toMatchObject({ widthPx: 192, heightPx: 208 });

      const rendered = renderCodexPetFrame(
        loaded!,
        "idle",
        12,
        { fg: (_color, value) => value },
        {
          sizeCells: 10,
          imageId: 1,
          now: 0,
        },
      );
      expect(rendered[0]).toContain("[Image");
      expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(12);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("deletes stale Kitty placements before placing a pet frame", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const frame: PetFrame = {
      rawRgbaData: Buffer.from([0, 0, 0, 255]).toString("base64"),
      kittyImageId: 42,
      mimeType: "image/png",
      durationMs: 100,
      widthPx: 1,
      heightPx: 1,
    };
    const loaded = {
      pet: {
        slug: "kitty-cleanup",
        name: "Kitty Cleanup",
        dir: "/tmp",
        spritesheetPath: "spritesheet.webp",
        hasSpritesheet: true,
      },
      states: { idle: [frame] } as LoadedCodexPet["states"],
    } satisfies LoadedCodexPet;

    const firstRender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 7, now: 0 },
    ).join("");
    expect(firstRender).toContain(deleteCodexPetKittyPlacement(42));
    expect(firstRender).toContain("a=t");
    expect(firstRender).toContain("C=1");
    expect(firstRender).toContain("\x1b[1A");
    expect(firstRender).toContain("\x1b[1B");

    const secondRender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 7, now: 0 },
    ).join("");
    expect(secondRender).toContain(deleteCodexPetKittyPlacement(42));
    expect(secondRender).not.toContain("a=t");
  });

  test("completes pet names for wake and select subcommands", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "pi-better-openai-pet-complete-"));
    try {
      const petDir = join(tempDir, "pets", "metalgarurumon");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(
        join(petDir, "pet.json"),
        JSON.stringify({
          id: "metalgarurumon",
          displayName: "MetalGarurumon",
          description: "Cyber wolf",
        }),
      );
      writeFileSync(join(petDir, "spritesheet.webp"), "webp");

      expect(await openAIPetsArgumentCompletions("w", tempDir)).toEqual([
        { value: "wake", label: "wake", description: "Render a footer pet" },
      ]);
      expect(await openAIPetsArgumentCompletions("wake M", tempDir)).toEqual([
        {
          value: "wake MetalGarurumon",
          label: "MetalGarurumon",
          description: "metalgarurumon — Cyber wolf",
        },
      ]);
      expect(await openAIPetsArgumentCompletions("select metal", tempDir)).toEqual([
        {
          value: "select MetalGarurumon",
          label: "MetalGarurumon",
          description: "metalgarurumon — Cyber wolf",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("builds pet settings picker values for ready pets", () => {
    const pets = [
      {
        slug: "stacky-plus",
        name: "Stacky Plus",
        dir: "/tmp/stacky-plus",
        spritesheetPath: "spritesheet.webp",
        hasSpritesheet: true,
      },
      {
        slug: "broken",
        name: "Broken",
        dir: "/tmp/broken",
        spritesheetPath: "spritesheet.webp",
        hasSpritesheet: false,
      },
    ];
    const cfg = { pets: { slug: "" } } as Parameters<typeof _test.petConfigPickerValue>[0];

    expect(_test.readyPetPickerValues(pets)).toEqual([_test.PET_AUTO_VALUE, "stacky-plus"]);
    expect(_test.petConfigPickerValue(cfg)).toBe(_test.PET_AUTO_VALUE);
    expect(_test.petSlugFromPickerValue(_test.PET_AUTO_VALUE)).toBe("");
    expect(_test.petPickerDescription(cfg, pets)).toContain("Auto: Stacky Plus (stacky-plus)");

    cfg.pets.slug = "stacky-plus";
    expect(_test.petConfigPickerValue(cfg)).toBe("stacky-plus");
    expect(_test.petPickerDescription(cfg, pets)).toContain("Selected: Stacky Plus (stacky-plus)");
  });

  test("formats setup help", () => {
    const help = formatCodexPetsHelp("/tmp/codex");
    expect(help).toContain("$skill-installer hatch-pet");
    expect(help).toContain("/tmp/codex/pets/<pet-name>/");
    expect(help).toContain("/pets list");
  });
});
