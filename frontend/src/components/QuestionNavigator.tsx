// @depends-on ../api.ts (boardQuestionPage／createBoardQuestion)
// @depends-on api.boardQuestionPage(母問題 id).children：「同層問題」＝母問題那一頁的 children，順序與在母問題頁看到的一致
// @depends-on types.ts::BoardSummary.question.parent_board_id：樹狀圖由 boards 組出（Board.tsx 轉場找共同祖先也讀同一欄位）；boards 必須已排除封存／已刪除的白板
// @depends-on 後端 boards.py::get_question_page（self／children／path／archived 的欄位）
// @depends-on Board.tsx（掛在 .board 容器內，Controls 的右邊；open／onClose 由 Board 管理）
// @depends-on QuestionRelationEdge：有方向類型的箭頭＝board_a 指向 board_b（與 relKindLabel／relMarks 同一套語義）；樹上連線讀 TreeBranch 按鈕的 data-bid 量位置，並由 layoutRelLines 以格子 A* 繞開所有白板節點（只畫目前選取的來源）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { BoardQuestionNode, BoardSummary, QuestionPage, QuestionPageSelf, QuestionRelation, QuestionRelationEdge, QuestionRelationType, QuestionStatus } from "../types";
import { QUESTION_DIRECTED_RELATIONS, QUESTION_RELATION_LABELS, QUESTION_RELATION_TYPES } from "../types";

interface Props {
  open: boolean;
  onClose(): void;
  boardId: string | null;
  boards: BoardSummary[]; // 用來判斷歷史裡的白板還在不在
  onSelectBoard(id: string): void;
  onBoardsChanged(): void;
  report(e: unknown, prefix?: string): void;
}

const GRID_THRESHOLD = 8; // 子問題超過這個數量，自動改成網格＋搜尋
const NEW_NODE_GAP = 40; // 新問題放在母畫布上最右邊子問題的右側，間隔多少
const HISTORY_MAX = 100;
const STATUS_LABEL: Record<QuestionStatus, string> = { open: "研究中", splitting: "拆分中", concluded: "已有結論" };

// 有方向的類型只顯示類型名稱加箭頭：outgoing＝本題 → 對方，incoming＝對方 → 本題
const relKindLabel = (r: QuestionRelation) => {
  const label = QUESTION_RELATION_LABELS[r.relation_type];
  return !QUESTION_DIRECTED_RELATIONS.has(r.relation_type) ? label : r.direction === "outgoing" ? `${label} →` : `← ${label}`;
};

// 動畫與 hover 樣式放在元件內，避免要同步修改全域 CSS；尊重「減少動態效果」設定
const CSS = `
@keyframes qnav-rise{from{transform:translateY(14px);opacity:0}to{transform:none;opacity:1}}
@keyframes qnav-down{from{transform:translateX(26px);opacity:0}to{transform:none;opacity:1}}
@keyframes qnav-up{from{transform:translateX(-26px);opacity:0}to{transform:none;opacity:1}}
@keyframes qnav-side{from{opacity:0}to{opacity:1}}
.qnav{animation:qnav-rise .18s ease-out}
.qnav-page.down{animation:qnav-down .2s ease-out}
.qnav-page.up{animation:qnav-up .2s ease-out}
.qnav-page.side{animation:qnav-side .15s ease-out}
.qnav-card{cursor:pointer;transition:border-color .12s,transform .12s}
.qnav-card:hover,.qnav-card:focus-visible{border-color:var(--accent,#60a5fa)!important;transform:translateY(-1px);outline:none}
.qnav-btn{background:transparent;border:1px solid var(--line,#475569);color:var(--text);border-radius:6px;padding:2px 8px;cursor:pointer;font-size:12px;line-height:20px}
.qnav-btn:disabled{opacity:.4;cursor:default}
.qnav-btn[aria-expanded="true"],.qnav-btn[aria-pressed="true"]{border-color:var(--accent,#60a5fa);background:var(--row-hover,rgba(59,130,246,.15))}
.qnav-grp{display:inline-flex;flex-shrink:0}
.qnav-grp .qnav-btn{border-radius:0;margin-left:-1px;white-space:nowrap}
.qnav-grp .qnav-btn:first-child{border-radius:6px 0 0 6px;margin-left:0}
.qnav-grp .qnav-btn:last-child{border-radius:0 6px 6px 0}
.qnav-sep{width:1px;align-self:stretch;background:var(--line,#475569);margin:2px 4px;flex-shrink:0}
.qnav-crumb{background:transparent;border:0;color:var(--text);opacity:.75;cursor:pointer;padding:0 2px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.qnav-crumb:hover{opacity:1;text-decoration:underline}
.qnav-sib{background:transparent;border:1px solid var(--line,#475569);color:var(--text);border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;cursor:pointer;flex-shrink:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qnav-sib:hover,.qnav-sib:focus-visible{border-color:var(--accent,#60a5fa);outline:none}
.qnav-sib.on{border:1.5px solid var(--accent,#60a5fa);background:var(--row-hover,rgba(59,130,246,.15));font-weight:600;cursor:default}
.qnav-rel{display:inline-flex;align-items:center;flex-shrink:0;border:1px solid var(--line,#475569);border-radius:999px;font-size:12px;line-height:18px;max-width:320px;overflow:hidden}
.qnav-rel.arch{opacity:.6}
.qnav-rel-kind{padding:2px 4px 2px 10px;opacity:.75;white-space:nowrap}
.qnav-rel-go{background:transparent;border:0;color:var(--text);padding:2px 6px;cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.qnav-rel-go:hover:not(:disabled),.qnav-rel-go:focus-visible{text-decoration:underline;outline:none}
.qnav-rel-go:disabled{cursor:default}
.qnav-rel-x{background:transparent;border:0;border-left:1px solid var(--line,#475569);color:var(--text);opacity:.6;padding:2px 7px;cursor:pointer;font-size:11px}
.qnav-rel-x:hover:not(:disabled){opacity:1}
.qnav-rel-x:disabled{cursor:default;opacity:.3}
.qt-row{display:flex;align-items:center}
.qt-kids{display:flex;flex-direction:column;position:relative;margin-left:22px}
.qt-kids::before{content:"";position:absolute;left:-22px;top:50%;width:22px;border-top:1px solid var(--line,#475569)}
.qt-kid{position:relative;padding:3px 0 3px 22px}
.qt-kid::before{content:"";position:absolute;left:0;top:50%;width:22px;border-top:1px solid var(--line,#475569)}
.qt-kid::after{content:"";position:absolute;left:0;top:0;bottom:0;border-left:1px solid var(--line,#475569)}
.qt-kid:first-child::after{top:50%}
.qt-kid:last-child::after{bottom:50%}
.qt-kid:only-child::after{display:none}
.qt-chip{background:var(--panel,#1e293b);border:1px solid var(--line,#475569);color:var(--text);border-radius:8px;padding:4px 10px;font-size:12px;line-height:18px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;flex-shrink:0}
.qt-chip:hover,.qt-chip:focus-visible{border-color:var(--accent,#60a5fa);outline:none}
.qt-chip.anc{border-color:var(--accent,#60a5fa)}
.qt-chip.cur{border:2px solid var(--accent,#60a5fa);background:var(--row-hover,rgba(59,130,246,.15));font-weight:600;padding:3px 9px}
.qt-chip.src{outline:2px solid var(--accent,#60a5fa);outline-offset:1px;background:var(--row-hover,rgba(59,130,246,.15))}
.qt-chip.tgt{outline:2px dashed var(--accent,#60a5fa);outline-offset:1px}
.qt-chip{display:flex;align-items:center;gap:4px;position:relative;z-index:2}
.qt-chip.rel{background:var(--row-hover,rgba(59,130,246,.15))}
.qt-drag{display:flex;flex-shrink:0}
.qt-drag.dragging{opacity:.4}
.qt-chip.drop{background:var(--row-hover,rgba(59,130,246,.15));border-style:dashed;border-width:2px;padding:3px 9px}
.qt-name{overflow:hidden;text-overflow:ellipsis;min-width:0}
.qrp{width:290px;flex-shrink:0;border-left:1px solid var(--line,#475569);padding-left:10px;display:flex;flex-direction:column;gap:8px;overflow:auto;font-size:12px}
.qrp-h{font-size:11px;margin:6px 0 2px}
.qrp-chip{display:inline-flex;align-items:center;gap:4px;border:1px dashed var(--accent,#60a5fa);border-radius:999px;padding:1px 4px 1px 10px;margin:0 4px 4px 0}
.qrp-chip button,.qrp-rel button{background:transparent;border:0;color:var(--text);cursor:pointer;opacity:.7}
.qrp-cand{display:flex;flex-direction:column;align-items:flex-start;width:100%;text-align:left;background:transparent;border:1px solid transparent;border-radius:6px;color:var(--text);padding:3px 6px;cursor:pointer}
.qrp-cand:hover,.qrp-cand:focus-visible{border-color:var(--accent,#60a5fa);outline:none}
.qrp-cand.on{border-color:var(--accent,#60a5fa);background:var(--row-hover,rgba(59,130,246,.15))}
.qrp-cand-sub{font-size:11px}
.qrp-rel{display:flex;align-items:center;gap:6px}
@media (prefers-reduced-motion:reduce){.qnav,.qnav-page,.qnav-card{animation:none!important;transition:none!important}}
`;

const statusLabel = (n: QuestionPageSelf) => (n.status ? STATUS_LABEL[n.status] : "");

function counts(n: QuestionPageSelf): string {
  const parts = [`${n.card_count} 張卡片`, `${n.literature_count} 篇文獻`];
  if (n.note_count > 0) parts.push(`${n.note_count} 則靈感`);
  parts.push(`${n.child_count} 個子問題`);
  return parts.join(" · ");
}

function NodeCard({ node, current, fresh, onEnter }: { node: QuestionPageSelf; current?: boolean; fresh?: boolean; onEnter?: () => void }) {
  const base: React.CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 10px",
    borderRadius: 8,
    border: current ? "2px solid var(--accent, #60a5fa)" : "1px solid var(--line, #475569)",
    background: current ? "var(--row-hover, rgba(59,130,246,0.15))" : "transparent",
    minHeight: 74,
    boxSizing: "border-box",
    textAlign: "left",
    color: "var(--text)",
  };
  const body = (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }} className="muted">
        <span>{current ? (node.kind ? `目前・${statusLabel(node)}` : "目前・母白板") : statusLabel(node)}</span>
        {fresh && <span style={{ color: "var(--accent, #60a5fa)" }}>新</span>}
      </div>
      <div
        style={{
          fontSize: 14,
          fontWeight: 600,
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          wordBreak: "break-word",
        }}
      >
        {node.name}
      </div>
      <div className="muted" style={{ fontSize: 11 }}>
        {counts(node)}
      </div>
    </>
  );
  if (current) {
    return (
      <div style={base} aria-current="page" data-qid={node.board_id} title={node.reason || undefined}>
        {body}
      </div>
    );
  }
  return (
    <div
      className="qnav-card"
      role="button"
      tabIndex={0}
      style={base}
      data-qid={node.board_id}
      title={node.reason ? `${node.reason}（點擊進入）` : "點擊進入這個問題"}
      onClick={onEnter}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onEnter?.();
        }
      }}
    >
      {body}
    </div>
  );
}

type TreeNode = { id: string; name: string; kids: TreeNode[] };
// 樹狀圖拖曳移動：把節點拖到另一個節點上＝移動這個問題（連同子孫）到對方底下
type TreeDnd = {
  dragId: string | null;
  overId: string | null;
  canDrag(id: string): boolean;
  canDrop(id: string): boolean;
  start(id: string): void;
  over(id: string | null): void;
  end(): void;
  drop(id: string): void;
};
const findNode = (n: TreeNode, id: string): TreeNode | null =>
  n.id === id ? n : n.kids.reduce<TreeNode | null>((f, k) => f ?? findNode(k, id), null);
const collectIds = (n: TreeNode): string[] => [n.id, ...n.kids.flatMap(collectIds)];
// 關聯面板的候選：path＝祖先路徑文字；kin＝與來源的上下層身分（沒有就是空字串）
type Cand = { id: string; name: string; path: string; kin: string };
// 樹狀圖的關聯連線：同一對白板只畫一條線（start／end＝箭頭在起點／終點）；每一筆關聯各有一個標籤
// failed＝找不到不遮擋白板的路徑而沒畫的線數（會在畫面上提示，不默默少）。標籤一律畫出：優先貼在線上，放不下就離線找空白處（from＝連回線上的點，沒有就不畫連接線）
type Box = { l: number; r: number; t: number; b: number };
type Pt = [number, number];
type RelPath = { id: string; d: string; start: boolean; end: boolean };
type RelTag = { id: string; x: number; y: number; w: number; text: string; from?: Pt };
type RelLines = { paths: RelPath[]; tags: RelTag[]; failed: number };
const NO_LINES: RelLines = { paths: [], tags: [], failed: 0 };
// 標籤離線的候選位移：不動，再由近到遠八個方向
const LABEL_SHIFTS: Pt[] = [[0, 0], ...[14, 24, 36, 52, 72].flatMap((r): Pt[] => [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [r, -r], [-r, r], [-r, -r]])];

// 連線繞路：格子大小、與白板節點保持的最小距離（格子取整後實際 ≥ 此值）、轉彎成本、已被別條線走過的格子成本
const ROUTE_CELL = 8;
const ROUTE_PAD = 6;
const ROUTE_TURN = 6;
const ROUTE_REUSE = 3;
const ROUTE_DX = [1, 0, -1, 0]; // 方向 0＝右、1＝下、2＝左、3＝上
const ROUTE_DY = [0, 1, 0, -1];
type Grid = { cols: number; rows: number; blocked: Uint8Array; used: Uint8Array; dist: Float64Array; prev: Int32Array; closed: Uint8Array };
type Port = { cell: number; dir: number; pt: Pt };

class MinHeap {
  private f: number[] = [];
  private s: number[] = [];
  get size() {
    return this.s.length;
  }
  push(f: number, s: number) {
    let i = this.s.length;
    this.f.push(f);
    this.s.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.f[p] <= f) break;
      this.f[i] = this.f[p];
      this.s[i] = this.s[p];
      i = p;
    }
    this.f[i] = f;
    this.s[i] = s;
  }
  pop(): number {
    const top = this.s[0];
    const lf = this.f.pop() as number;
    const ls = this.s.pop() as number;
    const n = this.s.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.f[c + 1] < this.f[c]) c++;
        if (this.f[c] >= lf) break;
        this.f[i] = this.f[c];
        this.s[i] = this.s[c];
        i = c;
      }
      this.f[i] = lf;
      this.s[i] = ls;
    }
    return top;
  }
}

// A*：狀態＝（格子，行進方向），轉彎要付成本，所以路線偏向少轉彎的直角線；回傳由起點到終點的格子序列，找不到回傳 null
function findRoute(g: Grid, starts: Port[], goals: Port[]): number[] | null {
  const { cols, rows, blocked, used, dist, prev, closed } = g;
  dist.fill(Infinity);
  prev.fill(-1);
  closed.fill(0);
  const goalStates = new Set(goals.map((p) => p.cell * 4 + p.dir));
  const goalXY = goals.map((p) => [p.cell % cols, Math.floor(p.cell / cols)]);
  const h = (cell: number) => {
    const cx = cell % cols;
    const cy = Math.floor(cell / cols);
    return goalXY.reduce((m, [gx, gy]) => Math.min(m, Math.abs(cx - gx) + Math.abs(cy - gy)), Infinity);
  };
  const heap = new MinHeap();
  for (const p of starts) {
    const st = p.cell * 4 + p.dir;
    dist[st] = 0;
    heap.push(h(p.cell), st);
  }
  while (heap.size > 0) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    if (goalStates.has(st)) {
      const cells: number[] = [];
      for (let cur = st; cur !== -1; cur = prev[cur]) cells.push(cur >> 2);
      return cells.reverse();
    }
    const cell = st >> 2;
    const dir = st & 3;
    const cx = cell % cols;
    const cy = Math.floor(cell / cols);
    for (let d = 0; d < 4; d++) {
      if (d === (dir + 2) % 4) continue; // 不掉頭
      const nx = cx + ROUTE_DX[d];
      const ny = cy + ROUTE_DY[d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nc = ny * cols + nx;
      if (blocked[nc]) continue;
      const ns = nc * 4 + d;
      const nd = dist[st] + 1 + (d !== dir ? ROUTE_TURN : 0) + (used[nc] ? ROUTE_REUSE : 0);
      if (nd < dist[ns]) {
        dist[ns] = nd;
        prev[ns] = st;
        heap.push(nd + h(nc), ns);
      }
    }
  }
  return null;
}

const polyAt = (pts: Pt[], s: number): Pt => {
  let rem = s;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (rem <= len) {
      const u = len === 0 ? 0 : rem / len;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    }
    rem -= len;
  }
  return pts[pts.length - 1];
};

// 轉角圓角：只往轉彎內側切，不會靠近外側的白板
const roundedPath = (pts: Pt[]): string => {
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1];
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    const a = Math.hypot(x - px, y - py);
    const b = Math.hypot(nx - x, ny - y);
    const r = Math.min(6, a / 2, b / 2);
    d += ` L${x + ((px - x) / a) * r},${y + ((py - y) / a) * r} Q${x},${y} ${x + ((nx - x) / b) * r},${y + ((ny - y) / b) * r}`;
  }
  const e = pts[pts.length - 1];
  return `${d} L${e[0]},${e[1]}`;
};

// 來源與相關白板之間的連線與標籤。rects＝樹容器內每個白板 chip 的矩形（含來源與對方）；
// 線只在「所有 chip 外擴 ROUTE_PAD 之外」的格子上走，只從 chip 左右兩側出入；標籤也不與任何 chip 或其他標籤重疊
function layoutRelLines(
  rects: ReadonlyMap<string, Box>,
  source: string,
  byOther: ReadonlyMap<string, QuestionRelationEdge[]>,
): RelLines {
  const s = rects.get(source);
  if (!s) return NO_LINES;
  let maxR = 0;
  let maxB = 0;
  rects.forEach((r) => {
    maxR = Math.max(maxR, r.r);
    maxB = Math.max(maxB, r.b);
  });
  const cols = Math.ceil((maxR + 80) / ROUTE_CELL); // 右側留白 80、下方留白 20，與樹容器的 padding 對應
  const rows = Math.ceil((maxB + 20) / ROUTE_CELL);
  const g: Grid = {
    cols,
    rows,
    blocked: new Uint8Array(cols * rows),
    used: new Uint8Array(cols * rows),
    dist: new Float64Array(cols * rows * 4),
    prev: new Int32Array(cols * rows * 4),
    closed: new Uint8Array(cols * rows * 4),
  };
  rects.forEach((r) => {
    const i0 = Math.max(0, Math.floor((r.l - ROUTE_PAD) / ROUTE_CELL));
    const i1 = Math.min(cols - 1, Math.floor((r.r + ROUTE_PAD) / ROUTE_CELL));
    const j0 = Math.max(0, Math.floor((r.t - ROUTE_PAD) / ROUTE_CELL));
    const j1 = Math.min(rows - 1, Math.floor((r.b + ROUTE_PAD) / ROUTE_CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) g.blocked[j * cols + i] = 1;
  });

  // 出入口：chip 左右兩側、中線上下各 8px 共三個高度；asGoal 時方向是「朝 chip 走進去」
  const portsOf = (r: Box, asGoal: boolean): Port[] => {
    const out: Port[] = [];
    for (const side of [0, 2]) {
      const x = side === 0 ? r.r + ROUTE_PAD + ROUTE_CELL : r.l - ROUTE_PAD - ROUTE_CELL;
      const i = Math.floor(x / ROUTE_CELL);
      if (i < 0 || i >= cols) continue;
      for (const dy of [0, -8, 8]) {
        const j = Math.floor(((r.t + r.b) / 2 + dy) / ROUTE_CELL);
        const cy = j * ROUTE_CELL + ROUTE_CELL / 2;
        if (j < 0 || j >= rows || cy < r.t + 2 || cy > r.b - 2) continue;
        const cell = j * cols + i;
        if (g.blocked[cell]) continue;
        out.push({ cell, dir: asGoal ? (side + 2) % 4 : side, pt: [side === 0 ? r.r : r.l, cy] });
      }
    }
    return out;
  };

  const hit = (a: Box, b: Box) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
  const obstacles = Array.from(rects.values()).map((b) => ({ l: b.l - 2, r: b.r + 2, t: b.t - 2, b: b.b + 2 }));
  const taken: Box[] = [];
  const paths: RelPath[] = [];
  const tags: RelTag[] = [];
  let failed = 0;
  const starts = portsOf(s, false);
  for (const [other, list] of byOther) {
    const t = rects.get(other);
    if (!t) continue; // 對方不在這棵樹上（已封存或屬於其他主題），畫面下方會提示筆數
    const goals = portsOf(t, true);
    const cells = starts.length > 0 && goals.length > 0 ? findRoute(g, starts, goals) : null;
    const sp = cells ? starts.find((p) => p.cell === cells[0]) : undefined;
    const tp = cells ? goals.find((p) => p.cell === cells[cells.length - 1]) : undefined;
    if (!cells || !sp || !tp) {
      failed++;
      console.warn("[qnav-tree] 找不到不遮擋白板的關聯線路徑，已略過", { source, other });
      continue;
    }
    cells.forEach((c) => (g.used[c] = 1));
    const raw: Pt[] = [
      sp.pt,
      ...cells.map((c): Pt => [(c % cols) * ROUTE_CELL + ROUTE_CELL / 2, Math.floor(c / cols) * ROUTE_CELL + ROUTE_CELL / 2]),
      tp.pt,
    ];
    const pts = raw.filter(
      (p, i) =>
        i === 0 ||
        i === raw.length - 1 ||
        !((raw[i - 1][0] === p[0] && p[0] === raw[i + 1][0]) || (raw[i - 1][1] === p[1] && p[1] === raw[i + 1][1])),
    );
    // 路徑由來源畫向對方：board_a 是來源＝箭頭在終點；board_b 是來源＝箭頭在起點（指向來源）
    const directed = list.filter((r) => QUESTION_DIRECTED_RELATIONS.has(r.relation_type));
    paths.push({
      id: other,
      d: roundedPath(pts),
      end: directed.some((r) => r.board_a === source),
      start: directed.some((r) => r.board_b === source),
    });

    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    // 路徑上每 ROUTE_CELL 一個取樣點；標籤候選位置＝取樣點加上一個位移
    const samples: { along: number; p: Pt }[] = [];
    for (let k = 0; k <= total; k += ROUTE_CELL) samples.push({ along: k, p: polyAt(pts, k) });
    const mid = polyAt(pts, total / 2);
    // 兩點之間的線段沒有穿過任何白板（每 4px 取一點檢查）
    const clear = (a: Pt, b: Pt) => {
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
      for (let i = 0; i <= n; i++) {
        const x = a[0] + ((b[0] - a[0]) * i) / n;
        const y = a[1] + ((b[1] - a[1]) * i) / n;
        if (obstacles.some((o) => x > o.l && x < o.r && y > o.t && y < o.b)) return false;
      }
      return true;
    };
    for (const r of list) {
      const label = QUESTION_RELATION_LABELS[r.relation_type];
      const text = !QUESTION_DIRECTED_RELATIONS.has(r.relation_type) ? label : r.board_a === source ? `${label} →` : `← ${label}`;
      const w = text.length * 11 + 14;
      const boxOf = ([x, y]: Pt): Box => ({ l: x - w / 2, r: x + w / 2, t: y - 8, b: y + 8 });
      // 在樹容器範圍內，不與任何白板、也不與已放好的標籤重疊
      const free = (b: Box) =>
        b.l >= 0 && b.t >= 0 && b.r <= maxR + 80 && b.b <= maxB + 20 && ![...obstacles, ...taken].some((o) => hit(b, o));
      // 優先貼在線上（離中點近者優先）；線上放不下就離線找最近的空白處，並要求連接線不穿過白板
      let best: { c: Pt; from?: Pt; score: number } | null = null;
      for (const { along, p } of samples) {
        const base = Math.abs(along - total / 2) * 0.25;
        for (const [dx, dy] of LABEL_SHIFTS) {
          const score = Math.hypot(dx, dy) + base;
          if (best && score >= best.score) continue;
          const c: Pt = [p[0] + dx, p[1] + dy];
          if (!free(boxOf(c))) continue;
          if (dx === 0 && dy === 0) best = { c, score };
          else if (clear(p, c)) best = { c, from: p, score };
        }
      }
      // 最後防線：附近都放不下，放到樹右側的留白欄（x 在所有白板之外），由上往下找最靠近線中點高度的空位
      if (!best) {
        const x = maxR + 8 + w / 2;
        for (let y = 8; y <= maxB + 12; y += 18) {
          const score = Math.abs(y - mid[1]);
          if ((!best || score < best.score) && free(boxOf([x, y]))) best = { c: [x, y], score };
        }
        if (best) console.warn("[qnav-tree] 關聯標籤附近放不下，已放到樹右側留白欄", { source, other, text });
      }
      // 連 fallback 都滿了（不應發生）：仍然畫在線的中點，寧可重疊也不隱藏
      if (!best) {
        console.warn("[qnav-tree] 找不到任何不重疊的標籤位置，標籤畫在線的中點", { source, other, text });
        best = { c: mid, score: 0 };
      }
      taken.push(boxOf(best.c));
      tags.push({ id: r.id, x: best.c[0], y: best.c[1], w, text, from: best.from });
    }
  }
  return { paths, tags, failed };
}

// 由 boards 的 parent_board_id 組出以 rootId 為根的子樹；母白板鏈若出現環就略過並大聲警告
function buildTree(boards: BoardSummary[], rootId: string, fallbackName: string): TreeNode {
  const byParent = new Map<string, BoardSummary[]>();
  for (const b of boards) {
    const p = b.question?.parent_board_id;
    if (p) byParent.set(p, [...(byParent.get(p) ?? []), b]);
  }
  const seen = new Set<string>();
  const walk = (id: string, name: string): TreeNode => {
    seen.add(id);
    const kids = (byParent.get(id) ?? [])
      .filter((b) => {
        if (!seen.has(b.id)) return true;
        console.warn("[qnav-tree] 母白板鏈出現環，已略過", b.id);
        return false;
      })
      .map((b) => walk(b.id, b.name));
    return { id, name, kids };
  };
  return walk(rootId, boards.find((b) => b.id === rootId)?.name ?? fallbackName);
}

function TreeBranch({
  node,
  currentId,
  ancestors,
  sel,
  relWith,
  dnd,
  onSelect,
  onEnter,
}: {
  node: TreeNode;
  currentId: string;
  ancestors: Set<string>;
  sel: ReadonlyMap<string, "src" | "tgt">;
  relWith: ReadonlyMap<string, string[]>; // 白板 → 它與目前來源之間的關聯文字
  onSelect(id: string, additive: boolean): void;
  onEnter(id: string): void;
  dnd: TreeDnd;
}) {
  const role = sel.get(node.id);
  const withSrc = relWith.get(node.id);
  const cls =
    (node.id === currentId ? " cur" : ancestors.has(node.id) ? " anc" : "") + (role ? ` ${role}` : "") + (withSrc ? " rel" : "") + (dnd.overId === node.id ? " drop" : "");
  return (
    <div className="qt-row">
      <span
        className={`qt-drag${dnd.dragId === node.id ? " dragging" : ""}`}
        draggable={dnd.canDrag(node.id)}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", node.id); // Firefox 沒有資料就不會開始拖曳
          dnd.start(node.id);
        }}
        onDragEnd={dnd.end}
        onDragOver={(e) => {
          if (!dnd.canDrop(node.id)) return; // 不 preventDefault＝不是合法的放開目標
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          dnd.over(node.id);
        }}
        onDragLeave={() => dnd.over(null)}
        onDrop={(e) => {
          e.preventDefault();
          dnd.drop(node.id);
        }}
      >
      <button
        type="button"
        className={`qt-chip${cls}`}
        data-tid={node.id === currentId ? "current" : undefined}
        data-bid={node.id}
        aria-current={node.id === currentId ? "page" : undefined}
        aria-pressed={!!role}
        title={`${node.name}（單擊選取，雙擊或 Enter 進入）${withSrc ? `\n與來源：${withSrc.join("、")}` : ""}`}
        onClick={(e) => onSelect(node.id, e.ctrlKey || e.metaKey)}
        onDoubleClick={() => onEnter(node.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault(); // 擋掉按鈕的預設 click，Enter 只做「進入」
            onEnter(node.id);
          }
        }}
      >
        <span className="qt-name">{node.name}</span>
      </button>
      </span>
      {node.kids.length > 0 && (
        <div className="qt-kids">
          {node.kids.map((k) => (
            <div key={k.id} className="qt-kid">
              <TreeBranch
                node={k}
                currentId={currentId}
                ancestors={ancestors}
                sel={sel}
                relWith={relWith}
                onSelect={onSelect}
                onEnter={onEnter}
                dnd={dnd}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function QuestionNavigator({ open, onClose, boardId, boards, onSelectBoard, onBoardsChanged, report }: Props) {
  const reportRef = useRef(report);
  reportRef.current = report;
  const [page, setPage] = useState<QuestionPage | null>(null);
  const pageRef = useRef<QuestionPage | null>(null);
  const [dir, setDir] = useState<"down" | "up" | "side">("side");
  const [view, setView] = useState<"auto" | "row" | "grid">("auto");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<{ id: string; name: string } | null>(null);
  const [sibs, setSibs] = useState<BoardQuestionNode[]>([]); // 同層問題（含自己），來自母問題那一頁的 children
  const [rels, setRels] = useState<QuestionRelation[] | null>([]); // 人工關聯；null＝載入失敗（錯誤已報，畫面標示失敗而不是顯示「沒有關聯」）
  // ---- 樹狀圖的關聯面板：treeSel[0]＝來源，其餘＝目標（星狀：來源對每個目標建立同一種關聯）----
  const [relPanel, setRelPanel] = useState(false);
  const [treeSel, setTreeSel] = useState<string[]>([]);
  const [relKind, setRelKind] = useState<QuestionRelationType>("related"); // 黏性：選一次可連續建立多筆
  const [relSearch, setRelSearch] = useState("");
  const [showOther, setShowOther] = useState(false);
  const [relMsg, setRelMsg] = useState("");
  const [allRels, setAllRels] = useState<QuestionRelationEdge[] | null>([]); // null＝載入失敗（錯誤已報）
  const relSeq = useRef(0);
  const [treeOpen, setTreeOpen] = useState(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);

  // ---- 瀏覽歷史（開關面板、換視圖都不會清掉；只要 Board 還掛著就保留）----
  const hist = useRef<{ stack: string[]; idx: number }>({ stack: [], idx: -1 });
  const [, bump] = useState(0);
  useEffect(() => {
    if (!boardId) return;
    const h = hist.current;
    if (h.stack[h.idx] === boardId) return; // 由上一步／下一步造成的切換，位置已經先移好了
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(boardId);
    if (h.stack.length > HISTORY_MAX) h.stack.shift();
    h.idx = h.stack.length - 1;
    bump((n) => n + 1);
  }, [boardId]);
  const alive = useMemo(() => new Set(boards.map((b) => b.id)), [boards]);
  // 樹狀圖：根＝目前路徑的最上層問題（目前就在最上層時＝自己）
  const tree = useMemo(
    () => (page ? buildTree(boards, page.path[0]?.id ?? page.self.board_id, page.path[0]?.name ?? page.self.name) : null),
    [boards, page],
  );
  useEffect(() => {
    if (!treeOpen) return;
    treeRef.current?.querySelector('[data-tid="current"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [treeOpen, page]);
  const nameOf = (id: string) => boards.find((b) => b.id === id)?.name ?? "";
  const histTarget = (step: -1 | 1): number => {
    const h = hist.current;
    for (let i = h.idx + step; i >= 0 && i < h.stack.length; i += step) {
      if (alive.has(h.stack[i]) && h.stack[i] !== boardId) return i; // 已刪除或已封存的白板直接略過
    }
    return -1;
  };
  const goHistory = (step: -1 | 1) => {
    const i = histTarget(step);
    if (i < 0) return;
    hist.current.idx = i;
    bump((n) => n + 1);
    onSelectBoard(hist.current.stack[i]);
  };

  // ---- 載入這一頁 ----
  const refresh = useCallback(async () => {
    if (!boardId) {
      setPage(null);
      pageRef.current = null;
      return;
    }
    const my = ++seq.current;
    try {
      const p = await api.boardQuestionPage(boardId);
      if (my !== seq.current) return; // 較新的請求已經發出，丟掉舊結果
      // 同層＝母問題那一頁的 children；失敗要報錯，但這一頁照常顯示
      let sib: BoardQuestionNode[] = [];
      if (p.path.length > 0) {
        try {
          sib = (await api.boardQuestionPage(p.path[p.path.length - 1].id)).children;
        } catch (e) {
          reportRef.current(e, "載入同層問題失敗：");
        }
        if (my !== seq.current) return; // 第二次 await 之後也要再檢查
      }
      // 關聯：失敗要報錯，但這一頁照常顯示
      let rel: QuestionRelation[] | null = [];
      try {
        rel = (await api.listQuestionRelations(boardId)).relations;
      } catch (e) {
        rel = null;
        reportRef.current(e, "載入關聯問題失敗：");
      }
      if (my !== seq.current) return; // 第三次 await 之後也要再檢查
      const prev = pageRef.current;
      if (prev && prev.self.board_id !== p.self.board_id) {
        setDir(p.path.length > prev.path.length ? "down" : p.path.length < prev.path.length ? "up" : "side");
        setSearch("");
      }
      pageRef.current = p;
      setSibs(sib);
      setRels(rel);
      setPage(p);
    } catch (e) {
      if (my === seq.current) reportRef.current(e, "載入問題路徑失敗：");
    }
  }, [boardId]);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, boards]); // boards 變動（新增、改名、刪除、封存）就重抓；端點只回數量，很輕

  // 新增後讓新卡片出現在可見範圍
  useEffect(() => {
    if (!added || !bodyRef.current) return;
    const el = Array.from(bodyRef.current.querySelectorAll<HTMLElement>("[data-qid]")).find((e) => e.dataset.qid === added.id);
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [added, page]);

  const addQuestion = async () => {
    if (!page || busy) return;
    const name = window.prompt(`在「${page.self.name}」底下新增問題`)?.trim();
    if (!name) return;
    // 放在母畫布上最右邊的子問題右側；還沒有子問題就放左上角
    const last = page.children.reduce<BoardQuestionNode | null>((m, c) => (!m || c.x + c.w > m.x + m.w ? c : m), null);
    const x = last ? last.x + last.w + NEW_NODE_GAP : 80;
    const y = last ? last.y : 80;
    setBusy(true);
    try {
      const r = await api.createBoardQuestion(page.self.board_id, { name, x, y });
      setAdded({ id: r.id, name });
      onBoardsChanged();
      await refresh();
    } catch (e) {
      reportRef.current(e, "新增問題失敗：");
    } finally {
      setBusy(false);
    }
  };

  const loadAllRels = useCallback(async () => {
    const my = ++relSeq.current;
    try {
      const r = await api.listAllQuestionRelations();
      if (my === relSeq.current) setAllRels(r.relations);
    } catch (e) {
      if (my === relSeq.current) {
        setAllRels(null);
        reportRef.current(e, "載入全部關聯失敗：");
      }
    }
  }, []);
  useEffect(() => {
    if (open && treeOpen) void loadAllRels();
  }, [open, treeOpen, loadAllRels, boards]); // boards 變動（改名、刪除、封存）就重抓
  useEffect(() => {
    // 每次展開樹狀圖，不預設選取：平常不畫關聯線，單擊某個節點選為來源才畫它的線
    if (treeOpen && boardId) {
      setTreeSel([]);
      setRelMsg("");
      setRelSearch("");
    }
  }, [treeOpen, boardId]);

  const source = treeSel[0] ?? null;
  // 候選分三層（相對於來源）：同母白板的兄弟；同根的其他分支（樹距離由近到遠，上下層身分排最後）；其他主題。
  // 順序依 boards 清單（名稱排序），不是建立順序。已封存的白板不在 boards 裡，所以不會成為候選
  const cands = useMemo(() => {
    if (!source) return null;
    const nameById = new Map(boards.map((b) => [b.id, b.name]));
    const parentOf = (id: string) => boards.find((b) => b.id === id)?.question?.parent_board_id ?? null;
    const chainOf = (id: string) => {
      const out = [id];
      for (let p = parentOf(id); p && !out.includes(p); p = parentOf(p)) out.push(p);
      return out;
    };
    const srcChain = chainOf(source);
    const srcRoot = srcChain[srcChain.length - 1];
    const srcParent = parentOf(source);
    const sib: Cand[] = [];
    const branch: (Cand & { dist: number })[] = [];
    const other: Cand[] = [];
    for (const b of boards) {
      if (b.id === source) continue;
      const c = chainOf(b.id);
      const cand: Cand = {
        id: b.id,
        name: b.name,
        path: c.slice(1).reverse().map((id) => nameById.get(id) ?? "").join(" / "),
        kin: srcChain.includes(b.id) ? "上層" : c.includes(source) ? "下層" : "",
      };
      if (c[c.length - 1] !== srcRoot) other.push(cand);
      else if (srcParent !== null && parentOf(b.id) === srcParent) sib.push(cand);
      else {
        const i = c.findIndex((id) => srcChain.includes(id)); // 同根，必定找得到共同祖先
        branch.push({ ...cand, dist: i + srcChain.indexOf(c[i]) });
      }
    }
    branch.sort((x, y) => (x.kin ? 1 : 0) - (y.kin ? 1 : 0) || x.dist - y.dist || x.name.localeCompare(y.name));
    return { sib, branch, other };
  }, [boards, source]);

  // 樹狀圖標記：目前來源與各白板之間的關聯文字（兩端都還在 boards 裡才算），用於節點提示與底色
  const relMarks = useMemo(() => {
    const withSource = new Map<string, string[]>();
    for (const r of allRels ?? []) {
      if (!alive.has(r.board_a) || !alive.has(r.board_b)) continue;
      if (source !== r.board_a && source !== r.board_b) continue;
      const label = QUESTION_RELATION_LABELS[r.relation_type];
      const text = !QUESTION_DIRECTED_RELATIONS.has(r.relation_type) ? label : r.board_a === source ? `${label} →` : `← ${label}`;
      const other = r.board_a === source ? r.board_b : r.board_a;
      withSource.set(other, [...(withSource.get(other) ?? []), text]);
    }
    return { withSource };
  }, [allRels, alive, source]);

  // 樹狀圖的關聯連線：量出來源與相關節點在樹容器內的位置。連線層與節點在同一個容器，捲動時一起移動；
  // 節點大小與選取無關，所以只在樹、關聯、來源改變時重量
  const [lines, setLines] = useState<RelLines>(NO_LINES);
  useLayoutEffect(() => {
    const box = treeRef.current;
    if (!open || !treeOpen || !box || !source) {
      setLines((s) => (s === NO_LINES ? s : NO_LINES));
      return;
    }
    const base = box.getBoundingClientRect();
    const rects = new Map<string, { l: number; r: number; t: number; b: number }>();
    box.querySelectorAll<HTMLElement>("[data-bid]").forEach((el) => {
      const b = el.getBoundingClientRect();
      rects.set(el.dataset.bid ?? "", { l: b.left - base.left, r: b.right - base.left, t: b.top - base.top, b: b.bottom - base.top });
    });
    // 同一對白板可能有多種關聯：合成一條線，每一筆關聯各自一個標籤
    const byOther = new Map<string, QuestionRelationEdge[]>();
    for (const r of allRels ?? []) {
      if (r.board_a !== source && r.board_b !== source) continue;
      const other = r.board_a === source ? r.board_b : r.board_a;
      byOther.set(other, [...(byOther.get(other) ?? []), r]);
    }
    setLines(layoutRelLines(rects, source, byOther));
  }, [open, treeOpen, source, allRels, tree]);

  // 單擊＝選為來源（取代之前的選取）；Ctrl+單擊＝加入／移除目標，面板收起時不動作，避免誤建
  const pickTree = (id: string, additive: boolean) => {
    setRelMsg("");
    if (!additive) {
      setTreeSel([id]);
      return;
    }
    if (!relPanel) return;
    setTreeSel((s) => (s.length === 0 ? [id] : s[0] === id ? s : s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  const toggleTarget = (id: string) => {
    setRelMsg("");
    setTreeSel((s) => (s.length === 0 ? [id] : s[0] === id ? s : s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };
  // ---- 樹狀圖拖曳移動 ----
  // @depends-on api.moveBoardQuestion / boards.py::move_board_question（環、封存、已在目標底下的判定以後端為準；這裡的 canDrop 只負責不亮出明知會被拒絕的目標）
  // assumption: 目標只限目前這棵樹內的節點（E2）；跨主題移動留待下一版
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragBlock = useMemo(() => {
    const n = tree && dragId ? findNode(tree, dragId) : null;
    return n ? new Set(collectIds(n)) : null;
  }, [tree, dragId]);
  const moveQuestion = async (srcId: string, tgtId: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.moveBoardQuestion(srcId, tgtId);
      onBoardsChanged(); // boards 更新後樹、頁面與關聯會自己重抓
    } catch (e) {
      reportRef.current(e, "移動問題失敗：");
    } finally {
      setBusy(false);
    }
  };
  const dnd: TreeDnd = {
    dragId,
    overId,
    canDrag: (id) => !busy && !!tree && id !== tree.id, // 樹根是最上層一般白板，不是問題
    canDrop: (id) =>
      !!dragBlock && !dragBlock.has(id) && id !== boards.find((b) => b.id === dragId)?.question?.parent_board_id,
    start: setDragId,
    over: setOverId,
    end: () => {
      setDragId(null);
      setOverId(null);
    },
    drop: (id) => {
      const src = dragId;
      setDragId(null);
      setOverId(null);
      if (src) void moveQuestion(src, id);
    },
  };

  const enterTree = (id: string) => {
    setTreeOpen(false);
    if (id !== boardId) onSelectBoard(id);
  };

  const createRelations = async () => {
    if (busy || treeSel.length < 2) return;
    const [src, ...targets] = treeSel;
    setBusy(true);
    setRelMsg("");
    try {
      // 單一交易：任何一個目標被拒絕就一筆都不寫，選取保留，可以修正後重試
      const r = await api.createQuestionRelationsBatch({ source_board_id: src, target_board_ids: targets, relation_type: relKind });
      const fresh = r.results.filter((x) => !x.existed).length;
      const dup = r.results.length - fresh;
      setRelMsg(`已建立 ${fresh} 筆${dup > 0 ? `，${dup} 筆原本就有` : ""}`);
      setTreeSel([src]);
      await Promise.all([refresh(), loadAllRels()]);
    } catch (e) {
      reportRef.current(e, "建立關聯失敗：");
    } finally {
      setBusy(false);
    }
  };

  const removeRelation = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await api.deleteQuestionRelation(id);
    } catch (e) {
      reportRef.current(e, "刪除關聯失敗：");
    } finally {
      // 成功或失敗（可能已在別處被刪，NOT_FOUND）都重抓，讓畫面與資料庫一致
      await Promise.all([refresh(), loadAllRels()]);
      setBusy(false);
    }
  };

  if (!open) return null;

  const children = page?.children ?? [];
  const effective: "row" | "grid" = view === "auto" ? (children.length > GRID_THRESHOLD ? "grid" : "row") : view;
  const q = search.trim().toLowerCase();
  const shown = q ? children.filter((c) => c.name.toLowerCase().includes(q)) : children;
  const parentId = page && page.path.length > 0 ? page.path[page.path.length - 1].id : null;
  const rootId = page && page.path.length > 0 ? page.path[0].id : null; // path 由最上層排到母問題（麵包屑照陣列順序渲染）
  const back = histTarget(-1);
  const fwd = histTarget(1);

  // ---- 關聯面板（只在樹狀圖展開且面板開啟時渲染）----
  const tgtIds = treeSel.slice(1);
  const selMap = new Map<string, "src" | "tgt">(treeSel.map((id, i) => [id, i === 0 ? "src" : "tgt"]));
  const nm = (id: string) => nameOf(id) || "（已封存）";
  const directed = QUESTION_DIRECTED_RELATIONS.has(relKind);
  const kindLabel = QUESTION_RELATION_LABELS[relKind];
  const rq = relSearch.trim().toLowerCase();
  const matchQ = (c: Cand) => !rq || c.name.toLowerCase().includes(rq);
  const allCands = cands ? [...cands.sib, ...cands.branch, ...cands.other] : [];
  const candById = new Map(allCands.map((c) => [c.id, c]));
  // 最近看過：沿用導航器的瀏覽歷史（新到舊、去重），不需要後端
  const recent = Array.from(new Set([...hist.current.stack].reverse()))
    .filter((id) => id !== source)
    .map((id) => candById.get(id))
    .filter((c): c is Cand => !!c)
    .slice(0, 5);
  // 已有同類型關聯就打勾：有方向的類型只看「來源 → 候選」，對稱類型兩個方向都算
  const hasRel = (cid: string) =>
    !!allRels?.some(
      (r) =>
        r.relation_type === relKind &&
        ((r.board_a === source && r.board_b === cid) || (!directed && r.board_a === cid && r.board_b === source)),
    );
  const candRow = (c: Cand) => {
    const on = tgtIds.includes(c.id);
    return (
      <button key={c.id} type="button" className={`qrp-cand${on ? " on" : ""}`} aria-pressed={on} onClick={() => toggleTarget(c.id)} title={c.path ? `${c.path} / ${c.name}` : c.name}>
        <span>
          {on ? "✓ " : ""}
          {c.name}
          {c.kin ? ` ·${c.kin}` : ""}
        </span>
        {hasRel(c.id) && <span className="muted qrp-cand-sub">已有「{kindLabel}」關聯</span>}
        {c.path && <span className="muted qrp-cand-sub">{c.path}</span>}
      </button>
    );
  };
  const section = (title: string, list: Cand[]) => {
    const l = list.filter(matchQ);
    return l.length ? (
      <div key={title}>
        <div className="muted qrp-h">
          {title}（{l.length}）
        </div>
        {l.map(candRow)}
      </div>
    ) : null;
  };
  const srcRels = source && allRels ? allRels.filter((r) => r.board_a === source || r.board_b === source) : [];
  // 對方不在這棵樹上（已封存或屬於其他主題）的關聯：樹上畫不出連線，改用文字提示筆數，不能讓畫面看起來像沒有關聯
  const offTree = tree ? srcRels.filter((r) => !findNode(tree, r.board_a === source ? r.board_b : r.board_a)).length : 0;
  const relPanelEl =
    page && relPanel ? (
      <div className="qrp" role="complementary" aria-label="建立關聯">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }} role="group" aria-label="關聯類型">
          {QUESTION_RELATION_TYPES.map((k) => (
            <button key={k} type="button" className="qnav-btn" aria-pressed={relKind === k} onClick={() => setRelKind(k)}>
              {QUESTION_RELATION_LABELS[k]}
            </button>
          ))}
        </div>
        <div>
          {source ? (
            <>
              <strong>{nm(source)}</strong> {directed ? `${kindLabel} →` : `${kindLabel}（無方向）`}
            </>
          ) : (
            <span className="muted">先在樹上單擊選來源</span>
          )}
        </div>
        <div>
          {tgtIds.map((id) => (
            <span key={id} className="qrp-chip">
              {nm(id)}
              <button type="button" aria-label={`移除目標「${nm(id)}」`} onClick={() => toggleTarget(id)}>
                ✕
              </button>
            </span>
          ))}
          {tgtIds.length === 0 && <span className="muted">Ctrl+單擊樹上節點，或點下方候選，加入目標</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {directed && tgtIds.length === 1 && source && (
            <button type="button" className="qnav-btn" onClick={() => setTreeSel([tgtIds[0], source])} title="對調來源與目標">
              ⇄ 對調方向
            </button>
          )}
          <button type="button" className="qnav-btn" disabled={busy || tgtIds.length === 0} onClick={() => void createRelations()}>
            建立 {tgtIds.length} 筆
          </button>
        </div>
        {relMsg && (
          <div className="muted" role="status">
            {relMsg}
          </div>
        )}
        <div>
          <div className="muted qrp-h">這個來源已有的關聯</div>
          {allRels === null ? (
            <span className="muted">載入失敗</span>
          ) : srcRels.length === 0 ? (
            <span className="muted">沒有</span>
          ) : (
            srcRels.map((r) => {
              const other = r.board_a === source ? r.board_b : r.board_a;
              const label = QUESTION_RELATION_LABELS[r.relation_type];
              const text = !QUESTION_DIRECTED_RELATIONS.has(r.relation_type) ? label : r.board_a === source ? `${label} →` : `← ${label}`;
              return (
                <div key={r.id} className="qrp-rel">
                  <span className="muted">{text}</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nm(other)}</span>
                  <button type="button" disabled={busy} onClick={() => void removeRelation(r.id)} title="刪除這筆關聯" aria-label={`刪除與「${nm(other)}」的關聯`}>
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>
        <input type="search" value={relSearch} onChange={(e) => setRelSearch(e.target.value)} placeholder="搜尋白板名稱" aria-label="搜尋候選白板" style={{ fontSize: 12 }} />
        {cands && (
          <>
            {section("最近看過", recent)}
            {section("同母白板", cands.sib)}
            {section("同主題的其他分支", cands.branch)}
            {rq || showOther ? (
              section("其他主題", cands.other)
            ) : (
              cands.other.length > 0 && (
                <button type="button" className="qnav-btn" onClick={() => setShowOther(true)}>
                  ▸ 其他主題（{cands.other.length}）
                </button>
              )
            )}
          </>
        )}
      </div>
    ) : null;

  return (
    <div
      className="qnav"
      role="region"
      aria-label="問題路徑導航器"
      onKeyDown={(e) => {
        if (e.key === "Escape") (treeOpen ? setTreeOpen(false) : onClose());
      }}
      style={{
        position: "absolute",
        left: 56, // 讓出左下角的縮放／適應畫面控制項
        right: 10,
        bottom: 10,
        height: "32%",
        minHeight: 196,
        maxHeight: "60%",
        zIndex: 20,
        display: "flex",
        flexDirection: "column",
        background: "var(--panel, #1e293b)",
        border: "1px solid var(--line, #475569)",
        borderRadius: 10,
        boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
        color: "var(--text)",
      }}
    >
      <style>{CSS}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--line, #475569)" }}>
        <div className="qnav-grp" role="group" aria-label="瀏覽歷史">
          <button className="qnav-btn" disabled={back < 0} onClick={() => goHistory(-1)} title={back >= 0 ? `上一步（剛才看過的問題）：${nameOf(hist.current.stack[back])}` : "沒有上一步"} aria-label="上一步">
            ◀
          </button>
          <button className="qnav-btn" disabled={fwd < 0} onClick={() => goHistory(1)} title={fwd >= 0 ? `下一步（剛才看過的問題）：${nameOf(hist.current.stack[fwd])}` : "沒有下一步"} aria-label="下一步">
            ▶
          </button>
        </div>
        <span className="qnav-sep" aria-hidden />
        <div className="qnav-grp" role="group" aria-label="問題層級">
          <button className="qnav-btn" disabled={!parentId} onClick={() => parentId && onSelectBoard(parentId)} title="回到上一層（母問題）" aria-label="回到上一層">
            ↑ 上層
          </button>
          <button
            className="qnav-btn"
            disabled={!rootId || rootId === parentId}
            onClick={() => rootId && onSelectBoard(rootId)}
            title={rootId ? `回到最上層：${page?.path[0]?.name ?? ""}` : "已經在最上層"}
            aria-label="回到最上層"
          >
            ⤒ 最上層
          </button>
          <button
            className="qnav-btn"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((v) => !v)}
            title="展開整棵問題樹（可橫向、縱向捲動）"
            aria-label="展開問題樹狀圖"
          >
            {treeOpen ? "▴ 樹狀圖" : "▾ 樹狀圖"}
          </button>
        </div>
        <nav aria-label="問題路徑" style={{ display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0, overflow: "hidden", whiteSpace: "nowrap" }}>
          {page?.path.map((p) => (
            <span key={p.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
              <button className="qnav-crumb" onClick={() => onSelectBoard(p.id)} title={p.name}>
                {p.name}
              </button>
              <span className="muted">›</span>
            </span>
          ))}
          <strong style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{page?.self.name ?? ""}</strong>
        </nav>
        {treeOpen && (
          <button
            className="qnav-btn"
            aria-pressed={relPanel}
            onClick={() => setRelPanel((v) => !v)}
            title="開闔關聯面板：單擊選來源，Ctrl+單擊加目標，再按「建立」"
          >
            ⇄ 關聯面板
          </button>
        )}
        {effective === "grid" && !treeOpen && (
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜尋子問題"
            aria-label="搜尋子問題"
            style={{ width: 140, fontSize: 12 }}
          />
        )}
        <button className="qnav-btn" onClick={() => setView(effective === "row" ? "grid" : "row")} title="切換橫向卡片／網格" aria-label="切換顯示方式">
          {effective === "row" ? "▦ 網格" : "▭ 橫向"}
        </button>
        <button className="qnav-btn" disabled={!page || busy} onClick={() => void addQuestion()}>
          ＋ 新增問題
        </button>
        <button className="qnav-btn" onClick={onClose} title="收起（Esc）" aria-label="收起導航器">
          ✕
        </button>
      </div>
      {added && (
        <div className="muted" style={{ padding: "3px 12px", fontSize: 12, display: "flex", gap: 8, alignItems: "center" }} role="status">
          <span>已新增「{added.name}」</span>
          <button className="qnav-btn" onClick={() => { onSelectBoard(added.id); setAdded(null); }}>
            進入
          </button>
          <button className="qnav-btn" onClick={() => setAdded(null)} aria-label="關閉提示">
            ✕
          </button>
        </div>
      )}
      {!treeOpen && page && sibs.length > 1 && (
        <div
          role="navigation"
          aria-label="同層問題"
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderBottom: "1px solid var(--line, #475569)", overflowX: "auto", whiteSpace: "nowrap" }}
        >
          <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>
            同層
          </span>
          {sibs.map((s) =>
            s.board_id === page.self.board_id ? (
              <span key={s.board_id} className="qnav-sib on" aria-current="page" title={s.name}>
                {s.name}
              </span>
            ) : (
              <button key={s.board_id} className="qnav-sib" onClick={() => onSelectBoard(s.board_id)} title={`切換到：${s.name}`}>
                {s.name}
              </button>
            ),
          )}
        </div>
      )}
      {!treeOpen && page && (
        <div
          role="navigation"
          aria-label="相關問題"
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderBottom: "1px solid var(--line, #475569)", overflowX: "auto", whiteSpace: "nowrap" }}
        >
          <span className="muted" style={{ fontSize: 11, flexShrink: 0 }}>
            相關
          </span>
          {rels === null && (
            <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
              載入失敗
            </span>
          )}
          {rels !== null && rels.length === 0 && (
            <span className="muted" style={{ fontSize: 12, flexShrink: 0 }}>
              還沒有關聯（到樹狀圖建立）
            </span>
          )}
          {(rels ?? []).map((r) => (
            <span key={r.id} className={`qnav-rel${r.archived ? " arch" : ""}`}>
              <span className="qnav-rel-kind">{relKindLabel(r)}</span>
              <button
                className="qnav-rel-go"
                disabled={r.archived}
                onClick={() => onSelectBoard(r.other_board_id)}
                title={r.archived ? `${r.other_name}（已封存，只能查看紀錄）` : `切換到：${r.other_name}`}
              >
                {r.other_name}
                {r.archived ? "（已封存）" : ""}
              </button>
              <button className="qnav-rel-x" disabled={busy} onClick={() => void removeRelation(r.id)} title="刪除這筆關聯" aria-label={`刪除與「${r.other_name}」的關聯`}>
                ✕
              </button>
            </span>
          ))}
          {/* 關聯只在樹狀圖的關聯面板建立；這一列暫時只顯示與刪除，檢查點 4 會換成新的呈現 */}
        </div>
      )}
      <div ref={bodyRef} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 10 }}>
        {!boardId ? (
          <div className="muted">請先在左側選擇一塊白板</div>
        ) : !page ? (
          <div className="muted">載入中…</div>
        ) : treeOpen && tree ? (
          <div style={{ display: "flex", gap: 10, height: "100%", minHeight: 0 }}>
            <div
              style={{ flex: 1, minWidth: 0, overflow: "auto" }}
              onClick={(e) => {
                // 點在節點以外的空白處＝取消選取（連線與高亮一起消失）；Ctrl／Cmd+點擊是加目標用的，不處理
                if (e.ctrlKey || e.metaKey || (e.target as HTMLElement).closest("[data-bid]")) return;
                setTreeSel([]);
                setRelMsg("");
              }}
            >
              <div ref={treeRef} style={{ position: "relative", isolation: "isolate", width: "max-content", minWidth: "100%", padding: "24px 100px 24px 60px" }}>
                <TreeBranch
                  node={tree}
                  currentId={page.self.board_id}
                  ancestors={new Set(page.path.map((p) => p.id))}
                  sel={selMap}
                  relWith={relMarks.withSource}
                  onSelect={pickTree}
                  onEnter={enterTree}
                  dnd={dnd}
                />
                {lines.paths.length > 0 && (
                  <svg aria-hidden style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible", zIndex: 1 }}>
                    <defs>
                      <marker id="qt-arrow" viewBox="0 0 8 8" refX="8" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
                        <path d="M0,0 L8,4 L0,8 z" style={{ fill: "var(--accent, #60a5fa)" }} />
                      </marker>
                    </defs>
                    {lines.paths.map((l) => (
                      <path
                        key={l.id}
                        d={l.d}
                        fill="none"
                        strokeWidth={1.5}
                        strokeDasharray="5 3"
                        style={{ stroke: "var(--accent, #60a5fa)" }}
                        markerEnd={l.end ? "url(#qt-arrow)" : undefined}
                        markerStart={l.start ? "url(#qt-arrow)" : undefined}
                      />
                    ))}
                    {lines.tags.map((g) => (
                      <g key={g.id}>
                        {g.from && <line x1={g.from[0]} y1={g.from[1]} x2={g.x} y2={g.y} strokeWidth={1} strokeDasharray="2 2" style={{ stroke: "var(--accent, #60a5fa)" }} />}
                        <rect x={g.x - g.w / 2} y={g.y - 8} width={g.w} height={16} rx={8} strokeWidth={1} style={{ fill: "var(--panel, #1e293b)", stroke: "var(--accent, #60a5fa)" }} />
                        <text x={g.x} y={g.y + 4} textAnchor="middle" fontSize={11} style={{ fill: "var(--text)" }}>
                          {g.text}
                        </text>
                      </g>
                    ))}
                  </svg>
                )}
              </div>
              {(offTree > 0 || lines.failed > 0) && (
                <div className="muted" style={{ fontSize: 11, padding: "4px 60px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
                  {offTree > 0 && <span>另有 {offTree} 筆關聯的對象不在這棵樹上（已封存或屬於其他主題），畫不出連線</span>}
                  {lines.failed > 0 && <span>有 {lines.failed} 條關聯線找不到不遮擋白板的路徑，沒有畫出（可在關聯面板看到完整清單）</span>}

                </div>
              )}
            </div>
            {relPanelEl}
          </div>
        ) : (
          <div key={page.self.board_id} className={`qnav-page ${dir}`}>
            {page.archived && (
              <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                這個問題已封存，只能查看
              </div>
            )}
            {effective === "row" ? (
              <div style={{ display: "flex", alignItems: "stretch", gap: 10 }}>
                <div style={{ width: 250, flexShrink: 0 }}>
                  <NodeCard node={page.self} current />
                </div>
                <div className="muted" style={{ alignSelf: "center" }} aria-hidden>
                  →
                </div>
                {children.length === 0 ? (
                  <div className="muted" style={{ alignSelf: "center", fontSize: 13 }}>
                    還沒有子問題。按「＋ 新增問題」從這裡拆出下一個問題。
                  </div>
                ) : (
                  children.map((c) => (
                    <div key={c.board_id} style={{ width: 220, flexShrink: 0 }}>
                      <NodeCard node={c} fresh={added?.id === c.board_id} onEnter={() => onSelectBoard(c.board_id)} />
                    </div>
                  ))
                )}
              </div>
            ) : (
              <>
                <div style={{ marginBottom: 8, maxWidth: 420 }}>
                  <NodeCard node={page.self} current />
                </div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  子問題 {q ? `${shown.length} / ${children.length}` : children.length}
                </div>
                {shown.length === 0 ? (
                  <div className="muted" style={{ fontSize: 13 }}>
                    {children.length === 0 ? "還沒有子問題。按「＋ 新增問題」從這裡拆出下一個問題。" : "沒有符合的子問題"}
                  </div>
                ) : (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
                    {shown.map((c) => (
                      <NodeCard key={c.board_id} node={c} fresh={added?.id === c.board_id} onEnter={() => onSelectBoard(c.board_id)} />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}