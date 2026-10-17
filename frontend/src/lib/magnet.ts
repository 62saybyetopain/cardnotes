// @depends-on ./layout.ts (LayoutBox, compareTopLeft)
import { compareTopLeft, type LayoutBox } from "./layout";

// 磁吸固定間距。必須 >= layout.ts 的 MIN_CARD_GAP，否則放開時會被當成太近而推開。
// 刻意與自動排版的間距（layoutGap）分開。
export const MAGNET_GAP = 20;
// 吸附門檻（螢幕像素）；呼叫端要除以 zoom 換成畫布單位
export const MAGNET_THRESHOLD_PX = 8;

export interface MagnetGuide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface MagnetResult {
  x: number;
  y: number;
  guides: MagnetGuide[];
}

interface AxisHit {
  delta: number;
  coord: number;
  other: LayoutBox;
}

/**
 * 拖曳中的卡片 moving 對其他卡片 others 做磁吸：
 * 1. 左／中／右線、上／中／下線對齊（同類型對同類型）。
 * 2. 兩張卡片並排或上下排列時，邊到邊吸到固定間距 gap。
 * 每個軸各取距離最近的一個；相同輸入永遠得到相同結果。
 */
export function computeMagnetSnap(
  moving: LayoutBox,
  others: readonly LayoutBox[],
  threshold: number,
  gap = MAGNET_GAP,
): MagnetResult {
  const mL = moving.x;
  const mR = moving.x + moving.w;
  const mCx = moving.x + moving.w / 2;
  const mT = moving.y;
  const mB = moving.y + moving.h;
  const mCy = moving.y + moving.h / 2;

  const xHits: AxisHit[] = [];
  const yHits: AxisHit[] = [];
  const addHit = (hits: AxisHit[], mine: number, target: number, coord: number, other: LayoutBox) => {
    const delta = target - mine;
    if (Math.abs(delta) <= threshold) hits.push({ delta, coord, other });
  };

  for (const o of [...others].sort(compareTopLeft)) {
    const oL = o.x;
    const oR = o.x + o.w;
    const oCx = o.x + o.w / 2;
    const oT = o.y;
    const oB = o.y + o.h;
    const oCy = o.y + o.h / 2;

    addHit(xHits, mL, oL, oL, o);
    addHit(xHits, mCx, oCx, oCx, o);
    addHit(xHits, mR, oR, oR, o);
    if (mT < oB && mB > oT) {
      // 垂直範圍重疊＝左右並排，才考慮水平間距
      addHit(xHits, mL, oR + gap, oR + gap / 2, o);
      addHit(xHits, mR, oL - gap, oL - gap / 2, o);
    }

    addHit(yHits, mT, oT, oT, o);
    addHit(yHits, mCy, oCy, oCy, o);
    addHit(yHits, mB, oB, oB, o);
    if (mL < oR && mR > oL) {
      // 水平範圍重疊＝上下排列，才考慮垂直間距
      addHit(yHits, mT, oB + gap, oB + gap / 2, o);
      addHit(yHits, mB, oT - gap, oT - gap / 2, o);
    }
  }

  const nearest = (hits: AxisHit[]) =>
    hits.reduce<AxisHit | null>((best, h) => (!best || Math.abs(h.delta) < Math.abs(best.delta) ? h : best), null);
  const bx = nearest(xHits);
  const by = nearest(yHits);

  const x = moving.x + (bx?.delta ?? 0);
  const y = moving.y + (by?.delta ?? 0);

  const guides: MagnetGuide[] = [];
  if (bx) {
    guides.push({
      x1: bx.coord,
      y1: Math.min(y, bx.other.y),
      x2: bx.coord,
      y2: Math.max(y + moving.h, bx.other.y + bx.other.h),
    });
  }
  if (by) {
    guides.push({
      x1: Math.min(x, by.other.x),
      y1: by.coord,
      x2: Math.max(x + moving.w, by.other.x + by.other.w),
      y2: by.coord,
    });
  }
  return { x, y, guides };
}

/** Shift 拖曳：以拖曳起點為基準，位移取 step 的整數倍 */
export function quantizeFromStart(start: number, current: number, step = MAGNET_GAP): number {
  return start + Math.round((current - start) / step) * step;
}