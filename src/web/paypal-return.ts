// Texts of the pages PayPal sends the buyer back to (/paypal/return, /paypal/cancel). These pages know nothing
// about the payment: they never claim that something was or was not charged (IA1-02) and change nothing on the
// server. The FlexSlot screen shows the state FlexSlot confirmed with PayPal itself.

export interface ReturnText {
  title: string;
  body: string;
}

export function paypalReturnText(cancelled: boolean, lang: 'en' | 'ja' = 'en'): ReturnText {
  if (lang === 'ja') {
    return cancelled
      ? {
          title: 'PayPalの画面を離れました',
          body: 'FlexSlotの画面に戻って、お支払いの状況をご確認ください。状況はFlexSlotがPayPalに直接確認します。このページでは決済結果を確定できません。',
        }
      : {
          title: 'PayPalから戻りました',
          body: 'FlexSlotの画面に戻ってください。FlexSlotがPayPalに承認を直接確認し、お支払いの状況をその画面に表示します。このタブは閉じてかまいません。',
        };
  }
  return cancelled
    ? {
        title: 'You left PayPal checkout',
        body: 'Return to your FlexSlot screen to check the payment status. FlexSlot checks it with PayPal itself; this page does not know it.',
      }
    : {
        title: 'Back from PayPal',
        body: 'Return to your FlexSlot screen. FlexSlot now checks your approval with PayPal itself and shows the payment status there; you can close this tab.',
      };
}
