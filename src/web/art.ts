// Assets of the screens. Icons: 18 original SVG icons (code-drawn, not generated; decorative, labels stay in the
// HTML). Photos and the paper texture: Codex's set for mockup v4 with the terracotta accent (IMAGES.md, last section;
// outputs/codex-prep/images-v4), a fictional salon made with OpenAI's built-in image tool on 7 November 2026 (the tool
// reported no model name or version). SHA-256 checked against Codex's manifest when copied. No people, text or logos
// are in the images; seals, amounts and states are drawn by the app. The paper texture is used in styles.css.
import icons from './images/ui-icons.svg';
import cover from './images/salon-cover.webp';
import station from './images/salon-station.webp';
import backdrop from './images/card-backdrop.webp';
import service from './images/service-still.webp';
import done from './images/done-backdrop.webp';

export const ART = { icons };

export type PhotoSlot = 'cover' | 'station' | 'backdrop' | 'service' | 'done';

/** cover: top page (16:10, calm lower left for the headline); station: the salon card (3:2); backdrop: A/B request
 * card (3:2, calm left two thirds); service: B's ticket (1:1); done: completion card (3:2, calm top right for the seal). */
export const PHOTOS: Record<PhotoSlot, { src: string; pos: string }> = {
  cover: { src: cover, pos: '50% 50%' },
  station: { src: station, pos: '50% 45%' },
  backdrop: { src: backdrop, pos: '50% 50%' },
  service: { src: service, pos: '50% 50%' },
  done: { src: done, pos: '50% 50%' },
};
