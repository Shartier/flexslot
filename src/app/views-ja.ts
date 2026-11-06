// Japanese texts of the screens' server-side wording (views.ts). Written as natural Japanese for a salon booking
// service, not as a word-for-word translation of the English. The English texts stay the default (the hackathon
// judges read English); a screen asks for Japanese with ?lang=ja. Codes and amounts are unchanged; only words,
// dates and the display of amounts differ.

export type Lang = 'en' | 'ja';

export const parseLang = (v: string | null | undefined): Lang => (v === 'ja' ? 'ja' : 'en');

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'];

/** "2026-11-09" -> "11月9日(月)". */
export function jaDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}月${d}日(${WEEKDAYS_JA[wd]})`;
}

/** "2026-11-09 14:00" -> "11月9日(月) 14:00". */
export const jaDateTime = (local: string): string => `${jaDate(local.slice(0, 10))} ${local.slice(11)}`;

/** Names of the sample world's shop, stylist, services and customers (seeded in English). */
const NAMES_JA: Record<string, string> = {
  'Flex Salon': 'フレックスサロン',
  Mika: 'ミカ',
  Cut: 'カット',
  'Cut + Color': 'カット＋カラー',
  'Customer A': 'お客さまA',
  'Customer B': 'お客さまB',
};
export const nameJa = (name: string): string => NAMES_JA[name] ?? name;

export const CASE_LABELS_JA: Record<string, string> = {
  DRAFT: '条件の確認待ち',
  NEEDS_CLARIFICATION: '条件の確認待ち',
  AWAITING_APPROVAL: '承認待ち',
  A_ACCEPTED: '承認待ち',
  READY: 'お支払いの準備中',
  PAYMENT_STARTED: 'お支払いの準備中',
  AUTHORIZING: 'お支払いの準備中',
  AUTHORIZED: 'お支払いの準備中',
  CAPTURING: 'お支払いを確定中',
  PAYMENT_PENDING: 'お支払いを確定中',
  PAYMENT_UNKNOWN: 'お支払いの結果を確認中',
  RECONCILING: 'お支払いの結果を確認中',
  CAPTURED: '予約を確定中',
  BOOKING_COMMIT_PENDING: '予約を確定中',
  BOOKING_COMMITTED: '予約変更済み・補償の返金待ち',
  REFUND_PENDING: '予約変更済み・補償の返金待ち',
  REFUND_FAILED: '予約変更済み・補償の返金に対応が必要',
  COMPLETED: '振替が完了しました',
  REJECTED: '不成立（辞退）',
  EXPIRED: '不成立（期限切れ）',
  VOID_PENDING: '不成立・仮売上を取り消し中',
  B_REFUND_PENDING: '振替できず・新しいお客さまへ返金中',
  B_REFUND_FAILED: '振替できず・返金に対応が必要',
  COMPENSATED: '振替できず・返金済み',
};
export const RELEASED_LABEL_JA = '不成立・仮売上を取り消しました';

export const REASON_TEXT_JA: Record<string, string> = {
  NO_BOOKING_IN_REQUESTED_WINDOW: 'ご希望の時間に既存の予約はありません（通常の予約で取れる可能性があります）。',
  A_BOOKING_NOT_CONFIRMED: '既存の予約が確定していません。',
  A_BOOKING_ALREADY_STARTED: '既存の予約はすでに始まっています。',
  A_PAYMENT_NOT_VERIFIED: '予約済みのお客さまのお支払いが、まだ確認できていません。',
  A_NO_FLEX_PREFERENCE: '予約済みのお客さまが、まだ移動できる日時を登録していません。',
  B_STYLIST_MISMATCH: 'ご希望の担当者が異なります。',
  B_SERVICE_LONGER_THAN_REQUEST_WINDOW: 'ご希望の施術が、ご希望の時間内に収まりません。',
  B_SERVICE_LONGER_THAN_ORIGIN_SLOT: 'ご希望の施術は、既存の予約の時間より長くかかります。',
  B_WINDOW_OUTSIDE_ORIGIN_SLOT: 'ご希望の時間が、既存の予約の時間に収まりません。',
  B_SLOT_OUTSIDE_BUSINESS_HOURS: 'ご希望の時間は営業時間外です。',
  B_SLOT_CONFLICT: 'ご希望の時間は、ほかの予約や確保中の枠と重なっています。',
  A_SERVICE_LONGER_THAN_WINDOW: '予約済みのお客さまの施術が、移動できる時間内に収まりません。',
  DESTINATION_IN_PAST: '移動先の時間がすでに過ぎています。',
  DESTINATION_OUTSIDE_BUSINESS_HOURS: '移動先の時間が営業時間外です。',
  DESTINATION_OVERLAPS_ORIGIN: '移動先の時間が、元の予約と重なっています。',
  DESTINATION_CONFLICT: '移動先の時間が、ほかの予約や確保中の枠と重なっています。',
  CASE_IN_PROGRESS: '別の振替がすでに進んでいます。',
  A_ALREADY_COMPENSATED: 'この予約は、すでに一度補償を受けています。',
  PAYEE_NOT_SET: 'お店のPayPalアカウントが設定されていません。',
};
export const REASON_DEFAULT_JA = 'ご希望の時間は、今はご案内できません。';

export const SOURCE_TEXT_JA: Record<string, string> = {
  AI_VERTEX: 'AI（Gemini on Vertex AI）',
  AI_MOCK: 'AI（模擬ルール）',
  MANUAL: '手入力',
};

export const EVENTS_JA: Record<string, string> = {
  CASE_PROPOSED: '振替の提案ができました',
  OWNER_APPROVED: 'お店が承認しました',
  A_APPROVED: '予約済みのお客さまが移動に同意しました',
  B_APPROVED: '新しいお客さまが承諾しました',
  OWNER_REJECTED: 'お店が見送りました',
  A_REJECTED: '予約済みのお客さまが辞退しました',
  B_REJECTED: '新しいお客さまが辞退しました',
  OFFER_EXPIRED: '提案の期限が切れました',
  PAYMENT_STARTED: 'お支払いを始めました',
  PAYMENT_EXPIRED: 'お支払いの期限が切れました（請求はありません）',
  PRE_CAPTURE_CHECK_FAILED: '請求の前の最終確認で問題が見つかったため、お支払いを取り消します',
  BOOKING_COMMITTED: '予約を変更しました',
};

/** Money steps (moneyStep in views.ts), same keys as the English table there. */
export const STEP_JA = {
  notStarted: '未開始',
  paid: '支払い済み',
  released: '仮売上を取り消し済み',
  refunded: '返金済み',
  expiredNotCharged: '支払い期限切れ（請求なし）',
  cancelled: '取り消し',
  attention: 'お店の対応が必要',
  preparingOrder: 'PayPalの注文を準備中',
  authorizing: '仮売上の手続き中',
  waitingBuyer: 'PayPalでの承認待ち',
  capturing: '請求を確定中',
  authorized: '仮売上済み（まだ請求されていません）',
  capturedChecking: '請求済み・内容を確認中',
  pending: 'PayPalで保留中・再確認します',
  checking: 'PayPalに結果を確認中',
  releasing: '仮売上を取り消し中',
  refunding: '返金の手続き中',
};

export const BOOKINGS_CHANGED_JA = '変更済み：予約済みのお客さまの予約を移動し、新しい予約を確定しました';
export const BOOKINGS_UNCHANGED_JA = '変更なし';

export const PROFIT_JA = {
  bPriceMinor: '新しいお客さまの料金（増える売上）',
  aCompensationMinor: '予約済みのお客さまへの固定の補償',
  bServiceCostMinor: '新しいお客さまの施術にかかる追加費用（仮定）',
  paymentFeesMinor: '支払い・返金の追加手数料（仮定。PayPalの料率ではありません）',
  opportunityLossMinor: (pct: number, profit: string) => `移動先の枠で失う見込みの利益（仮定：${pct}% × ${profit}）`,
  otherIncrementalCostMinor: 'その他の追加費用（仮定）',
  note: '架空の仮定による試算です。予約済みのお客さまの元のお支払いはすでに売上に入っているため、二重には数えていません。振替が見合うかどうかは、お店が判断します。',
};

export const OWNER_PAYMENT_JA = { paid: '支払い済み', paidSwap: '支払い済み（振替）', verified: '・確認済み', notPaid: '未払い' };

export const A_PAYMENT_JA = { paid: '支払い済み', confirming: 'お支払いを確定中', waitingBuyer: 'PayPalでの承認待ち', unpaid: '未払い' };

export const REFUND_NOTE_JA = '補償は、この予約をお支払いいただいたPayPalアカウントに、そのお支払いの一部返金としてお返しします。';

export const ACTOR_JA: Record<string, string> = { OWNER: 'お店', A: 'お客さまA', B: 'お客さまB', system: 'システム', executor: '自動処理' };
