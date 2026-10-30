// @depends-on ./layout.ts (LayoutBox)
// @depends-on ../components/Board.tsx (GROUP_PAD_TOP 需 ≥ .group-header 高度；Board.createGroup 直接引用此處的 GROUP_PAD／GROUP_PAD_TOP，不再各自寫死數字)
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

// 原因：框邊縮放帶（內 8px）＋卡片縮放帶（外 8px）會吃掉留白，24 只剩約 8px 可抓；40 留出約 24px
export const GROUP_PAD = 40; // 左右下邊距
export const GROUP_PAD_TOP = 44; // 上邊距（含標題列）
export const GROUP_MIN_W = 220; // 與 NodeResizer minWidth 一致
export const GROUP_MIN_H = 140; // 與 NodeResizer minHeight 一致
export const GROUP_PUSH_GAP = 20; // 推開後與被推框的間距

export interface FitResult {
  groups: Map<string, Rect>; // 尺寸／位置有變動的分組框（含被推開的）
  cards: Map<string, Point>; // 被推開的分組框帶動的卡片
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// 被拖動／縮放過的框：old＝改動前的矩形；owned＝屬於這個框的卡片 id。
// 推開別的框時，owned 內的卡片不會被當成別框的卡片帶走；別框在重疊區內的卡片才會跟著自己的框離開。
export interface MovedGroup {
  old: Rect;
  owned: ReadonlySet<string>;
}

// 框從 old 變成 next 時哪幾個邊向外伸出；推開別的框只往這些方向推（長大、拖動、縮放共用同一份規則）
function growthDirs(old: Rect, next: Rect): Dir[] {
  const dirs: Dir[] = [];
  if (next.x < old.x) dirs.push("left");
  if (next.x + next.w > old.x + old.w) dirs.push("right");
  if (next.y < old.y) dirs.push("up");
  if (next.y + next.h > old.y + old.h) dirs.push("down");
  return dirs;
}

// 中心點落在矩形內，與 Board 拖曳分組框時的成員判定相同
export function centerInRect(box: Rect, r: Rect): boolean {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
}

// 歸屬判定（拖曳中的亮框提示與放開時共用同一份）：中心點落在哪個框內；多框重疊取面積最小者
export function groupAtCenter(box: Rect, groups: readonly GroupRect[]): GroupRect | null {
  let best: GroupRect | null = null;
  for (const g of groups) {
    if (!centerInRect(box, g)) continue;
    if (!best || g.w * g.h < best.w * best.h) best = g;
  }
  return best;
}

// members：分組框 id → 成員卡片 id（由呼叫端決定，此函式不自行判定成員）
export function fitGroups(
  groups: GroupRect[],
  cards: LayoutBox[],
  members: Map<string, string[]>,
  moved?: ReadonlyMap<string, MovedGroup>, // 呼叫端已把新矩形放進 groups；這裡只負責把撞到的別框推開
): FitResult {
  const rects = new Map<string, Rect>(groups.map((g) => [g.id, { x: g.x, y: g.y, w: g.w, h: g.h }]));
  const cardRects = new Map<string, Rect>(cards.map((c) => [c.id, { x: c.x, y: c.y, w: c.w, h: c.h }]));
  const changedGroups = new Set<string>();
  const movedCards = new Set<string>();

  // 分組框長大後碰到「新」重疊的框：沿成長方向推開，連同其成員卡片，並連鎖處理
  const push = (srcId: string, oldRect: Rect, dirs: Dir[], owned?: ReadonlySet<string>) => {
    const queue: Array<{ srcId: string; oldRect: Rect; dirs: Dir[]; owned?: ReadonlySet<string> }> = [
      { srcId, oldRect, dirs, owned },
    ];
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
          // 中心在被推框內、且不屬於推它的框 → 跟著被推框一起位移。
          // 有 owned（拖動／縮放）就以它為準，重疊區內別框的卡片才不會被留下；長大則沿用「不在長大後的框內」
          if (centerInRect(cr, hBefore) && (cur.owned ? !cur.owned.has(id) : !centerInRect(cr, src))) {
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

    const dirs = growthDirs(oldCopy, next);
    if (dirs.length > 0) push(gid, oldCopy, dirs);
  }

  // 被拖動／縮放過的框：與長大同一套推開規則（只推「新碰到」的框）
  moved?.forEach((mg, gid) => {
    const cur = rects.get(gid);
    if (!cur) return;
    const dirs = growthDirs(mg.old, cur);
    if (dirs.length > 0) push(gid, mg.old, dirs, mg.owned);
  });

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