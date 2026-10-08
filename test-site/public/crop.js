// Card-photo cropping: turn any upload into the card's photo shape, framed on the face.

export const CARD_PHOTO_RATIO = 1.6; // width / height of the photo spot on a card

// W×H image → { x, y, w, h } crop at `ratio`. faces: [{ x, y, w, h }] if the browser
// found any; otherwise guess (people in photos put their head in the top third).
export function cardCrop(W, H, { ratio = CARD_PHOTO_RATIO, faces = [] } = {}) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  if (faces.length) {
    const x1 = Math.min(...faces.map((f) => f.x)), y1 = Math.min(...faces.map((f) => f.y));
    const x2 = Math.max(...faces.map((f) => f.x + f.w)), y2 = Math.max(...faces.map((f) => f.y + f.h));
    const fw = x2 - x1, fh = y2 - y1;
    // head and shoulders: about 2.8 face-heights tall, wide enough for every face
    let h = Math.max(fh * 2.8, (fw * 1.5) / ratio);
    let w = h * ratio;
    if (w > W) { w = W; h = w / ratio; }
    if (h > H) { h = H; w = h * ratio; }
    const cx = (x1 + x2) / 2;
    const top = y1 - (h - fh) * 0.3; // a little headroom, more room below for shoulders
    return { x: Math.round(clamp(cx - w / 2, 0, W - w)), y: Math.round(clamp(top, 0, H - h)), w: Math.round(w), h: Math.round(h) };
  }
  if (W / H > ratio) {
    const w = H * ratio;
    return { x: Math.round((W - w) / 2), y: 0, w: Math.round(w), h: H };
  }
  // tall photo: keep the full width; start a little below the top so the head sits high
  const h = W / ratio;
  return { x: 0, y: Math.round((H - h) * 0.12), w: W, h: Math.round(h) };
}
