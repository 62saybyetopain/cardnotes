// @depends-on ./layout.ts (LayoutBox)
// @depends-on ../components/Board.tsx (GROUP_PAD_TOP 需 ≥ .group-header 高度；Board.createGroup 內的 24／44 邊距需與此處一致)
import type { LayoutBox } from "./layout";

export interface GroupRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
type Rect = { x: number; y: number; w: number; h: number };
type Point = { x: number; y: number };
type Dir = "left" | "right" | "up" | "down";

export const GROUP_PAD = 24; // 左右下邊距
export const GROUP_PAD_TOP = 44; // 上邊距（含標題列）
export const GROUP_MIN_W = 220; // 與 NodeResizer minWidth 一致
export const GROUP_MIN_H = 140; // 與 NodeResizer minHeight 一致
export const GROUP_PUSH_GAP = 20; // 推開後與被推框的間距

export interface FitResult {
  groups: Map<string, Rect>; // 尺寸／位置有變動的分組框（含被推開的）
  cards: Map<string, Point>; // 被推開的分組框帶動的卡片
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// 中心點落在矩形內，與 Board 拖曳分組框時的成員判定相同
export function centerInRect(box: Rect, r: Rect): boolean {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

// members：分組框 id → 成員卡片 id（由呼叫端決定，此函式不自行判定成員）
export function fitGroups(groups: GroupRect[], cards: LayoutBox[], members: Map<string, string[]>): FitResult {
  const rects = new Map<string, Rect>(groups.map((g) => [g.id, { x: g.x, y: g.y, w: g.w, h: g.h }]));
  const cardRects = new Map<string, Rect>(cards.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h }]));
  const changedGroups = new Set<string>();
  const movedCards = new Set<string>();

  // 分組框長大後碰到「新」重疊的框：沿成長方向推開，連同其成員卡片，並連鎖處理
  const push = (srcId: string, oldRect: Rect, dirs: Dir[]) => {
    const queue = [{ srcId, oldRect, dirs }];
    for (let guard = 0; queue.length > 0 && guard < 500; guard++) {
      const cur = queue.shift();
      if (!cur) break;
      const src = rects.get(cur.srcId);
      if (!src) continue;
      for (const g of groups) {
        if (g.id === cur.srcId) continue;
        const h = rects.get(g.id);
        if (!h || !overlaps(src, h) || overlaps(cur.oldRect, h)) continue;

        const cands: Array<{ dx: number; dy: number; d: Dir }> = [];
        if (cur.dirs.includes("right")) cands.push({ dx: src.x + src.w + GROUP_PUSH_GAP - h.x, dy: 0, d: "right" });
        if (cur.dirs.includes("left")) cands.push({ dx: -(h.x + h.w - (src.x - GROUP_PUSH_GAP)), dy: 0, d: "left" });
        if (cur.dirs.includes("down")) cands.push({ dx: 0, dy: src.y + src.h + GROUP_PUSH_GAP - h.y, d: "down" });
        if (cur.dirs.includes("up")) cands.push({ dx: 0, dy: -(h.y + h.h - (src.y - GROUP_PUSH_GAP)), d: "up" });
        if (cands.length === 0) continue;
        const best = cands.reduce((a, b) => (Math.abs(a.dx) + Math.abs(a.dy) <= Math.abs(b.dx) + Math.abs(b.dy) ? a : b));

        const hBefore = { ...h };
        cardRects.forEach((cr, id) => {
          // 中心在被推框內、且不屬於正在長大的框 → 跟著被推框一起位移
          if (centerInRect(cr, hBefore) && !centerInRect(cr, src)) {
            cr.x += best.dx;
            cr.y += best.dy;
            movedCards.add(id);
          }
        });
        h.x += best.dx;
        h.y += best.dy;
        changedGroups.add(g.id);
        queue.push({ srcId: g.id, oldRect: hBefore, dirs: [best.d] });
      }
    }
  };

  for (const [gid, ids] of Array.from(members.entries())) {
    const old = rects.get(gid);
    if (!old) continue;
    const mem = ids.map((id) => cardRects.get(id)).filter((r): r is Rect => !!r);
    if (mem.length === 0) continue;

    const minX = Math.min(...mem.map((r) => r.x));
    const minY = Math.min(...mem.map((r) => r.y));
    const maxX = Math.max(...mem.map((r) => r.x + r.w));
    const maxY = Math.max(...mem.map((r) => r.y + r.h));
    const next: Rect = {
      x: Math.round(minX - GROUP_PAD),
      y: Math.round(minY - GROUP_PAD_TOP),
      w: Math.round(Math.max(GROUP_MIN_W, maxX - minX + GROUP_PAD * 2)),
      h: Math.round(Math.max(GROUP_MIN_H, maxY - minY + GROUP_PAD_TOP + GROUP_PAD)),
    };
    if (next.x === old.x && next.y === old.y && next.w === old.w && next.h === old.h) continue;

    const oldCopy = { ...old };
    rects.set(gid, next);
    changedGroups.add(gid);

    const dirs: Dir[] = [];
    if (next.x < oldCopy.x) dirs.push("left");
    if (next.x + next.w > oldCopy.x + oldCopy.w) dirs.push("right");
    if (next.y < oldCopy.y) dirs.push("up");
    if (next.y + next.h > oldCopy.y + oldCopy.h) dirs.push("down");
    if (dirs.length > 0) push(gid, oldCopy, dirs);
  }

  const outGroups = new Map<string, Rect>();
  changedGroups.forEach((id) => {
    const r = rects.get(id);
    if (r) outGroups.set(id, { ...r });
  });
  const outCards = new Map<string, Point>();
  movedCards.forEach((id) => {
    const r = cardRects.get(id);
    if (r) outCards.set(id, { x: r.x, y: r.y });
  });
  return { groups: outGroups, cards: outCards };
}