// Assets of the screens. Icons: 18 original SVG icons (code-drawn, not generated; decorative, labels stay in the
// HTML). Photos: the image slots of design 1 "salon" (HTML mockup v3, IMAGES.md, last section) are filled with
// Codex's images once they arrive; until then the screens show a plain surface in the design's colours. The earlier
// photo (salon-detail.webp) is no longer shown: the owner found it weak on the phone check (2026-11-07).
import icons from './images/ui-icons.svg';

export const ART = { icons };

/** hero: top page (16:10); side: the salon card on the three screens (3:2); service: B's ticket (1:1). */
export const PHOTOS: Partial<Record<'hero' | 'side' | 'service', string>> = {};
