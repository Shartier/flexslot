// Codex JAPANESE_UI_REVIEW (2026-11-07), applied at the user's request:
// - JA-01: the questions the program adds itself (the model returned no time or no service, and no question) were
//   English on the Japanese screen. They now follow the screen's language; the model's own questions stay as written.
// - The wording: no 仮売上 / 移動 / 本番 / bare ドル left in the Japanese texts, and amounts read "US$10.00".
// A fake Vertex (no network) and mock PayPal only.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GenerateContentLike } from '../src/ai/vertex.ts';
import { money } from '../src/app/views.ts';
import { aPaysMock, harness, loggedIn } from './app-helpers.ts';

/** A model that returns a structure with nothing filled in and no questions of its own. */
function silentVertex(reply: object): GenerateContentLike {
  return { generateContent: async () => ({ text: JSON.stringify(reply), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }) };
}

describe('JA-01: questions the program adds itself', () => {
  it("B: no time and no service from the model -> Japanese questions on the Japanese screen, English on the English one", async () => {
    const h = harness({ vertex: silentVertex({ service_id: null, stylist_id: null, required_windows: [], ambiguities: [] }) });
    const w = await loggedIn(h, { aiMode: 'VERTEX' });
    expect((await w.b.post('intake/draft', { text: '来週の午後に予約したいです。', useAi: true })).status).toBe(200);

    const ja = (await w.b.get('state?lang=ja')).json;
    expect(ja.draft.questions).toEqual([
      { field: 'required_windows', question: 'ご希望の日付と時間帯を教えてください。' },
      { field: 'service_id', question: 'ご希望の施術を選んでください。' },
    ]);
    const en = await w.b.state();
    expect(en.draft.questions).toEqual([
      { field: 'required_windows', question: 'Which date and time window works for you?' },
      { field: 'service_id', question: 'Which service would you like?' },
    ]);
  });

  it('A: the time question asks when the booking could be changed', async () => {
    const h = harness({ vertex: silentVertex({ allowed_windows: [], stylist_change_allowed: false, service_change_allowed: false, ambiguities: [] }) });
    const w = await loggedIn(h, { aiMode: 'VERTEX' });
    await aPaysMock(w.a);
    expect((await w.a.post('intake/draft', { text: '来週ならいつでも大丈夫です。', useAi: true })).status).toBe(200);
    expect((await w.a.get('state?lang=ja')).json.draft.questions).toEqual([{ field: 'allowed_windows', question: '予約を変更できる日付と時間帯を教えてください。' }]);
    expect((await w.a.state()).draft.questions).toEqual([{ field: 'allowed_windows', question: 'Which date and time window works for you?' }]);
  });

  it("the model's own questions are shown as it wrote them, in both languages", async () => {
    const own = { field: 'required_windows', question: '「午後」は何時から何時までですか？' };
    const h = harness({ vertex: silentVertex({ service_id: null, stylist_id: null, required_windows: [], ambiguities: [own] }) });
    const w = await loggedIn(h, { aiMode: 'VERTEX' });
    await w.b.post('intake/draft', { text: '来週の午後にカットを', useAi: true });
    const expected = [own, { field: 'service_id', question: 'ご希望の施術を選んでください。' }];
    expect((await w.b.get('state?lang=ja')).json.draft.questions).toEqual(expected);
    expect((await w.b.state()).draft.questions[0]).toEqual(own);
  });
});

describe('Japanese wording (Codex review)', () => {
  it('amounts: US$ in Japanese, unchanged in English, never converted', () => {
    expect(money(1000, 'USD', 'ja').text).toBe('US$10.00');
    expect(money(-250, 'USD', 'ja').text).toBe('-US$2.50');
    expect(money(1000, 'USD', 'en').text).toBe('USD 10.00');
  });

  it('the Japanese texts no longer use 仮売上, 移動, 本番 or a bare ドル', () => {
    const web = readFileSync('src/web/i18n.tsx', 'utf8');
    const jaWeb = web.slice(web.indexOf('const ja: Texts'));
    const server = readFileSync('src/app/views-ja.ts', 'utf8');
    const ret = readFileSync('src/web/paypal-return.ts', 'utf8');
    for (const src of [jaWeb, server, ret]) {
      expect(src).not.toMatch(/仮売上|移動|本番|わかりません/);
      expect(src).not.toMatch(/(?<!米)ドル/);
    }
    expect(jaWeb).toContain("agreeToMove: '予約変更に同意する'");
    expect(server).toContain("authorized: '支払い承認済み（請求は未確定）'");
  });
});
