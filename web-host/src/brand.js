// FiveWeb brand transform for the served launcher and game pages. Pure, in-memory,
// latin1 byte view. Changes, all in the served copy only:
//  1. The document <title> that starts with the $GrandV brand, and logo alt="$GrandV".
//  2. The original logo/favicon URL (/branding/grandv-logo.png?v=...) points at the fixed
//     FiveWeb icon route /__brand/fiveweb-icon.png.
//  3. The visible launcher heading "Launch GTA V." reads "FiveWeb Launcher".
//  4. A fixed style block hides the donate, tweet and trade controls and the donate dialog.
//     The DOM stays in place (donations.js still binds to it). Nothing is removed.
// Donation text, wallet names, the game name, engine identifiers, storage keys, build IDs
// and other asset paths are deliberately left alone. Input without the patterns comes back as-is.
export const BRAND_NAME = 'FiveWeb';
export const PERSONAL_NAME = BRAND_NAME; // legacy alias
export const BRAND_ICON_SRC = '/__brand/fiveweb-icon.png';
export const HIDDEN_IDS = ['donate-open', 'grandv-tweet', 'grandv-trade', 'donate-dialog'];
export const HIDE_STYLE = `<style id="fiveweb-brand-hide">${HIDDEN_IDS.map((id) => `#${id}`).join(',')}{display:none !important}</style>`;

const RULES = [
  { from: '<title>$GrandV', to: `<title>${BRAND_NAME}` },
  { from: 'alt="$GrandV"', to: `alt="${BRAND_NAME}"` },
  { from: '<h1>Launch GTA V.</h1>', to: `<h1>${BRAND_NAME} Launcher</h1>` },
];

const ICON_RE = /\/branding\/grandv-logo\.png\?v=[0-9]+/g;

export function applyPersonalBrand(original) {
  let text = original.toString('latin1');
  const source = text;
  for (const { from, to } of RULES) text = text.split(from).join(to);
  text = text.replace(ICON_RE, () => BRAND_ICON_SRC);
  if (HIDDEN_IDS.some((id) => text.includes(`id="${id}"`))) {
    const head = text.search(/<\/head\s*>/i);
    text = head >= 0 ? text.slice(0, head) + HIDE_STYLE + text.slice(head) : HIDE_STYLE + text;
  }
  return text === source ? original : Buffer.from(text, 'latin1');
}
