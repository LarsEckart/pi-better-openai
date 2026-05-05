# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, and image generation through `openai-codex` auth.

## Install

Install from GitHub:

```bash
pi install git:github.com/mattleong/pi-better-openai
```

Or install from npm:

```bash
pi install npm:pi-better-openai
```

## Features

- Fast mode for supported OpenAI models, toggled with `/fast` or in `/openai-settings`.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive settings picker via `/openai-settings`.
- Footer customization for model, thinking, fast mode, usage, and token/cost context.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Animated Codex custom pets rendered in the Better OpenAI footer.
- Commands:
  - `/fast` toggles fast mode.
  - `/openai-image <prompt>` generates an image directly.
  - `/pets [help|list|wake [slug]|tuck|select <slug>]` renders or manages custom pets from `${CODEX_HOME:-~/.codex}/pets`.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-settings` opens settings, diagnostics, and config details.

## Codex pets

Codex pets are an OpenAI Codex app feature, so the floating overlay and pet picker are still controlled by Codex (`Settings → Appearance → Pets` or `/pet`). This extension can also render compatible custom pet spritesheets directly in pi's Better OpenAI footer.

```bash
/pets wake          # render the selected pet, or the first ready pet
/pets wake <slug>   # render a specific ready pet
/pets select <slug> # select a ready pet without changing visibility
/pets tuck          # hide it
/pets list          # list local custom pets and readiness diagnostics
```

You can also enable **Footer pet** in `/openai-settings`, cycle installed pets with the **Pet** row, preview the selected pet in the footer, and tune placement (`inline-right` by default), idle, thinking/streaming, tool-execution, and any failed-tool animation states, plus random idle emotes and size.

To create a custom pet for the Codex app:

```bash
$skill-installer hatch-pet
```

Then reload Codex skills (`Cmd/Ctrl+K → Force Reload Skills`) and ask:

```text
$hatch-pet create a new pet inspired by pi-better-openai
```

Custom pets should end up in `${CODEX_HOME:-~/.codex}/pets/<pet-name>/` with `pet.json` and `spritesheet.webp`. Refresh custom pets in Codex settings and toggle the overlay with `/pet`.

## Screenshots

<!-- Add screenshots here. -->

<img width="983" height="851" alt="Screenshot 2026-04-29 at 11 53 23 PM" src="https://github.com/user-attachments/assets/07a2fb87-ef48-4396-8b12-124825c8d360" />
<img width="1327" height="102" alt="Screenshot 2026-04-29 at 11 34 49 PM" src="https://github.com/user-attachments/assets/22042782-c94e-491d-b5af-095f7f0810f9" />
