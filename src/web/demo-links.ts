// The demo creator's three invite links, remembered in this browser (localStorage, best effort) so that one device
// can switch between the owner, A and B screens without losing the links (found on a real phone, 2026-11-07).
// Only links to this same origin's role screens are accepted back. In real use each person has only their own link.

export type RoleSeg = 'owner' | 'a' | 'b';
export interface DemoLinks {
  worldId: string;
  links: Record<RoleSeg, string>;
}

const KEY = 'flexslot-demo';

export function saveDemo(d: DemoLinks): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    // not remembered; the links are still shown on the page
  }
}

export function loadDemo(): DemoLinks | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as DemoLinks | null;
    if (!v || typeof v.worldId !== 'string' || !v.links) return null;
    const ok = (['owner', 'a', 'b'] as const).every((k) => typeof v.links[k] === 'string' && v.links[k].startsWith(`${window.location.origin}/w/${v.worldId}/${k}/`));
    return ok ? v : null;
  } catch {
    return null;
  }
}
