# FlexSlot — Third-party notices and generated assets

This file lists material in this repository that FlexSlot's own source licence does not cover by itself. The source licence for the project has not been chosen yet; it will be added before the repository is made public.

## Fonts (bundled into the screens)

The screens bundle these fonts from npm packages published by Fontsource. They are served from the app's own origin; no font is loaded from a third-party server.

| Font | npm package (exact version) | Licence | Used for |
| --- | --- | --- | --- |
| Shippori Mincho | `@fontsource/shippori-mincho` 5.3.0 | SIL Open Font License 1.1 | Headings |
| Zen Kaku Gothic New | `@fontsource/zen-kaku-gothic-new` 5.3.1 | SIL Open Font License 1.1 | Body text |
| Inter | `@fontsource/inter` 5.3.0 | SIL Open Font License 1.1 | Figures |
| Cormorant Garamond | `@fontsource/cormorant-garamond` 5.3.0 | SIL Open Font License 1.1 | Small Latin captions |

The licence text of each font is included in its package (`node_modules/@fontsource/<name>/LICENSE`) and is copied into the built files the fonts belong to. The fonts are not sold on their own.

## AI-generated images

The salon photographs and the paper texture in `src/web/images/` (`salon-cover`, `salon-station`, `card-backdrop`, `service-still`, `done-backdrop`, `paper-texture`) are AI-generated. They depict a fictional salon, not a photographed real business, and contain no people, text or logos.

- Created on 7 November 2026 with OpenAI's built-in image generation tool, used through Codex. The tool did not expose the model name or version, so none is claimed.
- After generation, the images were only resized, trimmed slightly at the edges to the target ratio, and converted to WebP.
- The screens state that the photos are AI-generated and not a real business.
- Generation records (prompts, sizes, SHA-256) are kept with the creator's working files; `IMAGES.md` summarises them.

## Icons and drawings

The 18 icons in `src/web/images/ui-icons.svg`, the logo, the seals, the progress line and the profit bar are drawn in code for this project and are not generated images.

## Services

PayPal (Sandbox only) and Google Cloud Vertex AI (Gemini) are used through their public APIs under the creator's own developer accounts. Their names are used to describe the integration; no endorsement by PayPal or Google is implied.
