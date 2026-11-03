// AI context for the SPEC 4 sample shop (fictional values), used by V9 and the tests.

import { SAMPLE, SAMPLE_NOW_MS } from '../sample.ts';
import { toLocal } from '../time.ts';
import type { StructureContext } from './structure.ts';

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export function sampleStructureContext(worldId = 'demo', nowMs = SAMPLE_NOW_MS): StructureContext {
  const tz = SAMPLE.shop.timeZone;
  const local = toLocal(nowMs, tz);
  return {
    timeZone: tz,
    today: `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`,
    businessOpen: hhmm(SAMPLE.shop.businessOpenMinute),
    businessClose: hhmm(SAMPLE.shop.businessCloseMinute),
    services: [
      { id: `${worldId}:service:cut`, name: SAMPLE.services.cut.name, durationMin: SAMPLE.services.cut.durationMin },
      { id: `${worldId}:service:cut-color`, name: SAMPLE.services.cutColor.name, durationMin: SAMPLE.services.cutColor.durationMin },
    ],
    stylists: [{ id: `${worldId}:stylist:mika`, name: SAMPLE.stylistName }],
  };
}
