// Assets of the screens. Icons: 18 original SVG icons (code-drawn, not generated; decorative, labels stay in the
// HTML). Photos: the slots of mockup v4 (IMAGES.md, last section). Until Codex's images for it arrive, every slot shows
// the earlier photo of the fictional salon (salon-detail.webp: OpenAI's built-in image tool, exact model and version
// not reported), framed differently per slot. Replace each entry when its image arrives.
import icons from './images/ui-icons.svg';
import interim from './images/salon-detail.webp';

export const ART = { icons };

export type PhotoSlot = 'cover' | 'station' | 'backdrop' | 'service' | 'done';

/** cover: top page (16:10); station: the salon card (3:2); backdrop: A/B request card (3:2); service: B's ticket (1:1);
 * done: completion card (3:2). `pos` frames the interim photo for each slot. */
export const PHOTOS: Record<PhotoSlot, { src: string; pos: string }> = {
  cover: { src: interim, pos: '50% 50%' },
  station: { src: interim, pos: '50% 45%' },
  backdrop: { src: interim, pos: '30% 50%' },
  service: { src: interim, pos: '62% 55%' },
  done: { src: interim, pos: '70% 50%' },
};
