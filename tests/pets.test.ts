import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@mariozechner/pi-tui";
import sharp from "sharp";
import { _test } from "../index.ts";
import {
  animationFrameAt,
  codexHome,
  formatCodexPetsHelp,
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

  test("formats setup help", () => {
    const help = formatCodexPetsHelp("/tmp/codex");
    expect(help).toContain("$skill-installer hatch-pet");
    expect(help).toContain("/tmp/codex/pets/<pet-name>/");
    expect(help).toContain("/pets list");
  });
});
