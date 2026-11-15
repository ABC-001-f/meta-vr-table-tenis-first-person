// One font for every canvas-drawn label (menus, HUD, scoreboards, name tags).
// Inter is self-hosted from /public/fonts so it works offline on the headset.
// Canvas text silently falls back to another font if the face isn't loaded
// yet, so loadFonts() must finish before the first panel is drawn.

export const FONT_FAMILY = "'Inter', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** CSS font shorthand for canvas: font(700, 42) -> "700 42px 'Inter', ..." */
export function font(weight: number, px: number): string {
  return `${weight} ${px}px ${FONT_FAMILY}`;
}

const WEIGHTS = [500, 600, 700, 800];

/** Register and load the Inter faces. Resolves (never rejects) after at most `timeoutMs`. */
export async function loadFonts(timeoutMs = 4000): Promise<void> {
  if (typeof FontFace === 'undefined' || !document.fonts) return;
  const base = import.meta.env.BASE_URL;
  const loads = WEIGHTS.map(async (w) => {
    try {
      const face = new FontFace('Inter', `url(${base}fonts/inter-${w}.woff2) format('woff2')`, { weight: String(w), display: 'block' });
      document.fonts.add(await face.load());
    } catch (e) {
      console.warn(`Inter ${w} failed to load, using fallback font`, e);
    }
  });
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, timeoutMs))]);
}
