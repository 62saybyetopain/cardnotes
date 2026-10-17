// @depends-on ../types.ts (RelationType)
import type { RelationType } from "../types";

export const GRID_SIZE = 20;
export const MIN_CARD_GAP = 20;
export const DEFAULT_LAYOUT_GAP = 40;
export const DEFAULT_CARD_W = 280;
export const DEFAULT_CARD_H = 140;

export type LayoutMode = "grid" | "radial" | "right" | "split";
export type SplitMode = "direction" | "type";

export const DEFAULT_TYPE_SIDE_MAP: Record<RelationType, "left" | "right"> = {
  refute: "left",
  support: "right",
  influence: "right",
  instance_of: "right",
  applied_to: "right",
  extend: "right",
};

export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LayoutLink {
  source_id: string;
  target_id: string;
  relation_type: RelationType;
}

export interface AutoLayoutOptions {
  mode: LayoutMode;
  gap?: number;
  clusterThreshold?: number;
  centerCardId?: string | null;
  splitMode?: SplitMode;
  typeSideMap?: Partial<Record<RelationType, "left" | "right">>;
  snapToGrid?: boolean;
  gridSize?: number;
}

const RELATION_ORDER: readonly RelationType[] = [
  "refute",
  "support",
  "influence",
  "instance_of",
  "applied_to",
  "extend",
];

export function snapToGridValue(val: number, gridSize = GRID_SIZE): number {
  if (gridSize <= 0) return Math.round(val);
  const snapped = Math.round(val / gridSize) * gridSize;
  return Object.is(snapped, -0) ? 0 : snapped;
}

export function snapDimension(val: number, minVal = GRID_SIZE, gridSize = GRID_SIZE): number {
  if (gridSize <= 0) return Math.max(minVal, Math.round(val));
  return Math.max(minVal, Math.round(val / gridSize) * gridSize);
}

/**
 * 平手判準：位置較靠左上角者優先（先比 Y，再比 X，最後比 ID 確保絕對確定性）
 */
export function compareTopLeft(
  a: { id: string; x: number; y: number },
  b: { id: string; x: number; y: number },
): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.x !== b.x) return a.x - b.x;
  return a.id.localeCompare(b.id);
}

/**
 * 檢查兩個矩形是否重疊或邊到邊間距小於 minGap
 */
export function boxesConflict(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  minGap = MIN_CARD_GAP,
): boolean {
  const g = minGap - 0.01; // 容許浮點誤差：間距剛好等於 minGap 不算衝突（磁吸會吸到剛好的間距）
  return (
    a.x < b.x + b.w + g &&
    a.x + a.w + g > b.x &&
    a.y < b.y + b.h + g &&
    a.y + a.h + g > b.y
  );
}

/**
 * 從目標吸附點 (baseX, baseY) 往外一圈一圈尋找最近且不與 obstacles 衝突的格點空位。
 * 若原位已無衝突，直接回傳原位（已在空位的卡片不會被動）。
 */
export function findNearestFreePosition(
  card: { w: number; h: number },
  baseX: number,
  baseY: number,
  obstacles: readonly { x: number; y: number; w: number; h: number }[],
  gridSize = GRID_SIZE,
  minGap = MIN_CARD_GAP,
): { x: number; y: number } {
  const isFree = (cx: number, cy: number) => {
    const candidate = { x: cx, y: cy, w: card.w, h: card.h };
    for (const obs of obstacles) {
      if (boxesConflict(candidate, obs, minGap)) return false;
    }
    return true;
  };

  // 原位已無衝突就維持原位（不取整），否則磁吸對齊出來的位置會被格線拉回去
  if (isFree(baseX, baseY)) {
    return { x: baseX, y: baseY };
  }

  const startX = snapToGridValue(baseX, gridSize);
  const startY = snapToGridValue(baseY, gridSize);

  if (isFree(startX, startY)) {
    return { x: startX, y: startY };
  }

  const step = Math.max(1, gridSize);
  for (let ring = 1; ring <= 150; ring++) {
    let best: { x: number; y: number; distSq: number } | null = null;
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const cx = startX + dx * step;
        const cy = startY + dy * step;
        if (!isFree(cx, cy)) continue;
        const distSq = (cx - startX) * (cx - startX) + (cy - startY) * (cy - startY);
        if (
          !best ||
          distSq < best.distSq ||
          (distSq === best.distSq && (cy < best.y || (cy === best.y && cx < best.x)))
        ) {
          best = { x: cx, y: cy, distSq };
        }
      }
    }
    if (best) {
      return { x: best.x, y: best.y };
    }
  }

  return { x: startX, y: startY };
}

/**
 * 處理單張或多張同時放開／新增的卡片：
 * 1. 已在白板上的未移動卡片（fixedObstacles）絕不移動。
 * 2. 移動中的卡片依 compareTopLeft 排序後逐一吸附並尋空位，後面的避開前面已放好的。
 * 3. 相同輸入永遠得到相同結果，且重複套用不再移動（冪等）。
 */
export function placeCardsAvoidingCollisions(
  movingCards: readonly LayoutBox[],
  fixedObstacles: readonly LayoutBox[],
  gridSize = GRID_SIZE,
  minGap = MIN_CARD_GAP,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  const placed: { x: number; y: number; w: number; h: number }[] = fixedObstacles.map((o) => ({
    x: o.x,
    y: o.y,
    w: o.w,
    h: o.h,
  }));

  const sortedMoving = [...movingCards].sort(compareTopLeft);
  for (const card of sortedMoving) {
    const pos = findNearestFreePosition(
      { w: card.w, h: card.h },
      card.x,
      card.y,
      placed,
      gridSize,
      minGap,
    );
    result.set(card.id, pos);
    placed.push({ x: pos.x, y: pos.y, w: card.w, h: card.h });
  }
  return result;
}

interface AdjEdge {
  neighborId: string;
  direction: "incoming" | "outgoing";
  relation_type: RelationType;
}

interface TreeNode {
  id: string;
  box: LayoutBox;
  degree: number;
  depth: number;
  side: "left" | "right" | "center";
  edgeFromParent?: AdjEdge;
  children: TreeNode[];
  subtreeH: number;
  subtreeWeight: number;
}

interface ClusterLayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
  anchorCard: LayoutBox;
}

function layoutGrid(
  cards: readonly LayoutBox[],
  gap: number,
  snapToGrid: boolean,
  gridSize: number,
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (cards.length === 0) return result;

  const minX = Math.min(...cards.map((c) => c.x));
  const minY = Math.min(...cards.map((c) => c.y));
  const startX = snapToGrid ? snapToGridValue(minX, gridSize) : Math.round(minX);
  const startY = snapToGrid ? snapToGridValue(minY, gridSize) : Math.round(minY);
  const effectiveGap = snapToGrid ? Math.max(gridSize, snapToGridValue(gap, gridSize)) : gap;

  const avgH = cards.reduce((s, c) => s + c.h, 0) / cards.length;
  const rowTolerance = Math.max(20, avgH * 0.45);
  const byY = [...cards].sort(compareTopLeft);
  const readingRows: LayoutBox[][] = [];
  for (const c of byY) {
    const lastRow = readingRows[readingRows.length - 1];
    if (!lastRow || Math.abs(c.y - lastRow[0].y) > rowTolerance) {
      readingRows.push([c]);
    } else {
      lastRow.push(c);
    }
  }
  const ordered: LayoutBox[] = [];
  for (const r of readingRows) {
    r.sort((a, b) => (a.x !== b.x ? a.x - b.x : a.id.localeCompare(b.id)));
    ordered.push(...r);
  }

  const cols = Math.max(1, Math.round(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / cols);
  const colWidths = new Array<number>(cols).fill(0);
  const rowHeights = new Array<number>(rows).fill(0);

  ordered.forEach((c, idx) => {
    const r = Math.floor(idx / cols);
    const col = idx % cols;
    const w = snapToGrid ? Math.ceil(c.w / gridSize) * gridSize : c.w;
    const h = snapToGrid ? Math.ceil(c.h / gridSize) * gridSize : c.h;
    if (w > colWidths[col]) colWidths[col] = w;
    if (h > rowHeights[r]) rowHeights[r] = h;
  });

  const colX = new Array<number>(cols).fill(startX);
  for (let col = 1; col < cols; col++) {
    colX[col] = colX[col - 1] + colWidths[col - 1] + effectiveGap;
  }

  const rowY = new Array<number>(rows).fill(startY);
  for (let r = 1; r < rows; r++) {
    rowY[r] = rowY[r - 1] + rowHeights[r - 1] + effectiveGap;
  }

  ordered.forEach((c, idx) => {
    const r = Math.floor(idx / cols);
    const col = idx % cols;
    result.set(c.id, { x: colX[col], y: rowY[r] });
  });

  return result;
}

function buildClusterTrees(
  cards: readonly LayoutBox[],
  links: readonly LayoutLink[],
  options: {
    mode: LayoutMode;
    clusterThreshold: number;
    centerCardId?: string | null;
    splitMode: SplitMode;
    typeSideMap: Record<RelationType, "left" | "right">;
  },
): TreeNode[] {
  const cardMap = new Map<string, LayoutBox>();
  for (const c of cards) cardMap.set(c.id, c);

  // 只計算圈選範圍內的連線
  const adj = new Map<string, Map<string, AdjEdge>>();
  for (const c of cards) adj.set(c.id, new Map());

  for (const l of links) {
    if (!cardMap.has(l.source_id) || !cardMap.has(l.target_id) || l.source_id === l.target_id) {
      continue;
    }
    const srcMap = adj.get(l.source_id)!;
    const dstMap = adj.get(l.target_id)!;
    if (!srcMap.has(l.target_id) || l.relation_type === "refute") {
      srcMap.set(l.target_id, {
        neighborId: l.target_id,
        direction: "outgoing",
        relation_type: l.relation_type,
      });
    }
    if (!dstMap.has(l.source_id) || l.relation_type === "refute") {
      dstMap.set(l.source_id, {
        neighborId: l.source_id,
        direction: "incoming",
        relation_type: l.relation_type,
      });
    }
  }

  const degreeOf = (id: string) => adj.get(id)?.size ?? 0;
  const compareCenterPriority = (idA: string, idB: string): number => {
    const degDiff = degreeOf(idB) - degreeOf(idA);
    if (degDiff !== 0) return degDiff;
    return compareTopLeft(cardMap.get(idA)!, cardMap.get(idB)!);
  };

  const visitedComp = new Set<string>();
  const components: string[][] = [];
  const allIdsSorted = cards.map((c) => c.id).sort((a, b) => compareTopLeft(cardMap.get(a)!, cardMap.get(b)!));

  for (const startId of allIdsSorted) {
    if (visitedComp.has(startId)) continue;
    const comp: string[] = [];
    const q = [startId];
    visitedComp.add(startId);
    while (q.length > 0) {
      const cur = q.shift()!;
      comp.push(cur);
      const neighbors = Array.from(adj.get(cur)?.keys() ?? []).sort(compareCenterPriority);
      for (const nb of neighbors) {
        if (!visitedComp.has(nb)) {
          visitedComp.add(nb);
          q.push(nb);
        }
      }
    }
    components.push(comp);
  }

  if (options.centerCardId && cardMap.has(options.centerCardId)) {
    components.sort((a, b) => {
      const aHas = a.includes(options.centerCardId!) ? 0 : 1;
      const bHas = b.includes(options.centerCardId!) ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return compareTopLeft(cardMap.get(a[0])!, cardMap.get(b[0])!);
    });
  }

  const resolveFirstLayerSide = (edgeFromCenter: AdjEdge): "left" | "right" => {
    if (options.splitMode === "direction") {
      return edgeFromCenter.direction === "incoming" ? "left" : "right";
    }
    return options.typeSideMap[edgeFromCenter.relation_type] ?? "right";
  };

  const sortChildren = (children: TreeNode[], isSplitMode: boolean) => {
    children.sort((a, b) => {
      if (isSplitMode && a.edgeFromParent && b.edgeFromParent) {
        const typeIdxA = RELATION_ORDER.indexOf(a.edgeFromParent.relation_type);
        const typeIdxB = RELATION_ORDER.indexOf(b.edgeFromParent.relation_type);
        if (typeIdxA !== typeIdxB) return typeIdxA - typeIdxB;
      }
      if (b.degree !== a.degree) return b.degree - a.degree;
      return compareTopLeft(a.box, b.box);
    });
  };

  const trees: TreeNode[] = [];
  const threshold = Math.max(2, options.clusterThreshold);

  for (const comp of components) {
    const unassigned = new Set<string>(comp);
    const deferredHubs: string[] = [];

    while (unassigned.size > 0) {
      let rootId: string | undefined;
      if (options.centerCardId && unassigned.has(options.centerCardId)) {
        rootId = options.centerCardId;
      }
      if (!rootId) {
        while (deferredHubs.length > 0 && !unassigned.has(deferredHubs[0])) {
          deferredHubs.shift();
        }
        if (deferredHubs.length > 0) rootId = deferredHubs.shift()!;
      }
      if (!rootId) {
        rootId = Array.from(unassigned).sort(compareCenterPriority)[0];
      }

      unassigned.delete(rootId);
      const rootNode: TreeNode = {
        id: rootId,
        box: cardMap.get(rootId)!,
        degree: degreeOf(rootId),
        depth: 0,
        side: "center",
        children: [],
        subtreeH: 0,
        subtreeWeight: 1,
      };

      const queue: TreeNode[] = [rootNode];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        const edges = Array.from(adj.get(parent.id)?.values() ?? []).sort((ea, eb) =>
          compareCenterPriority(ea.neighborId, eb.neighborId),
        );

        for (const edge of edges) {
          const nbId = edge.neighborId;
          if (!unassigned.has(nbId)) continue;

          const nbDegree = degreeOf(nbId);
          const hasOwnUnassignedBranch = Array.from(adj.get(nbId)?.keys() ?? []).some(
            (k) => k !== parent.id && unassigned.has(k),
          );
          // 當子節點連線數 >= X 且帶有未分配分支時，切分為獨立群落 C2（白板仍保留 C1-C2 連線）
          if (nbDegree >= threshold && nbId !== options.centerCardId && hasOwnUnassignedBranch) {
            if (!deferredHubs.includes(nbId)) deferredHubs.push(nbId);
            continue;
          }

          unassigned.delete(nbId);
          const childSide: "left" | "right" =
            options.mode === "split"
              ? parent.depth === 0
                ? resolveFirstLayerSide(edge)
                : (parent.side as "left" | "right")
              : "right";

          const childNode: TreeNode = {
            id: nbId,
            box: cardMap.get(nbId)!,
            degree: nbDegree,
            depth: parent.depth + 1,
            side: childSide,
            edgeFromParent: edge,
            children: [],
            subtreeH: 0,
            subtreeWeight: 1,
          };
          parent.children.push(childNode);
          queue.push(childNode);
        }

        sortChildren(parent.children, options.mode === "split");
      }

      trees.push(rootNode);
    }
  }

  return trees;
}

function computeSubtreeMetrics(node: TreeNode, gap: number): void {
  if (node.children.length === 0) {
    node.subtreeH = node.box.h;
    node.subtreeWeight = Math.max(1, Math.hypot(node.box.w, node.box.h));
    return;
  }
  let childrenTotalH = 0;
  let totalWeight = 0;
  for (const child of node.children) {
    computeSubtreeMetrics(child, gap);
    childrenTotalH += child.subtreeH;
    totalWeight += child.subtreeWeight;
  }
  childrenTotalH += (node.children.length - 1) * gap;
  node.subtreeH = Math.max(node.box.h, childrenTotalH);
  node.subtreeWeight = Math.max(Math.hypot(node.box.w, node.box.h), totalWeight);
}

function normalizeClusterPositions(
  rawPositions: Map<string, { x: number; y: number }>,
  boxMap: Map<string, LayoutBox>,
  anchorCard: LayoutBox,
): ClusterLayoutResult {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const [id, pos] of rawPositions.entries()) {
    const b = boxMap.get(id)!;
    if (pos.x < minX) minX = pos.x;
    if (pos.y < minY) minY = pos.y;
    if (pos.x + b.w > maxX) maxX = pos.x + b.w;
    if (pos.y + b.h > maxY) maxY = pos.y + b.h;
  }

  const norm = new Map<string, { x: number; y: number }>();
  for (const [id, pos] of rawPositions.entries()) {
    norm.set(id, { x: pos.x - minX, y: pos.y - minY });
  }

  return {
    positions: norm,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    anchorCard,
  };
}

function layoutClusterRight(root: TreeNode, gap: number): ClusterLayoutResult {
  computeSubtreeMetrics(root, gap);
  const boxMap = new Map<string, LayoutBox>();
  const depthMaxW = new Map<number, number>();

  const collectDepthWidths = (n: TreeNode) => {
    boxMap.set(n.id, n.box);
    const curMax = depthMaxW.get(n.depth) ?? 0;
    if (n.box.w > curMax) depthMaxW.set(n.depth, n.box.w);
    for (const c of n.children) collectDepthWidths(c);
  };
  collectDepthWidths(root);

  const maxDepth = Math.max(...Array.from(depthMaxW.keys()), 0);
  const colX = new Map<number, number>();
  colX.set(0, 0);
  for (let d = 1; d <= maxDepth; d++) {
    colX.set(d, colX.get(d - 1)! + (depthMaxW.get(d - 1) ?? DEFAULT_CARD_W) + gap);
  }

  const rawPos = new Map<string, { x: number; y: number }>();
  const assignPos = (n: TreeNode, topY: number) => {
    rawPos.set(n.id, { x: colX.get(n.depth) ?? 0, y: topY + (n.subtreeH - n.box.h) / 2 });
    if (n.children.length === 0) return;
    const childrenSpan =
      n.children.reduce((s, c) => s + c.subtreeH, 0) + (n.children.length - 1) * gap;
    let childTop = topY + (n.subtreeH - childrenSpan) / 2;
    for (const c of n.children) {
      assignPos(c, childTop);
      childTop += c.subtreeH + gap;
    }
  };

  assignPos(root, 0);
  return normalizeClusterPositions(rawPos, boxMap, root.box);
}

function layoutClusterSplit(root: TreeNode, gap: number): ClusterLayoutResult {
  const boxMap = new Map<string, LayoutBox>();
  const collectBoxes = (n: TreeNode) => {
    boxMap.set(n.id, n.box);
    for (const c of n.children) collectBoxes(c);
  };
  collectBoxes(root);

  const leftChildren = root.children.filter((c) => c.side === "left");
  const rightChildren = root.children.filter((c) => c.side === "right");

  for (const c of leftChildren) computeSubtreeMetrics(c, gap);
  for (const c of rightChildren) computeSubtreeMetrics(c, gap);

  const leftDepthMaxW = new Map<number, number>();
  const rightDepthMaxW = new Map<number, number>();
  const scanSideWidths = (n: TreeNode, map: Map<number, number>) => {
    const cur = map.get(n.depth) ?? 0;
    if (n.box.w > cur) map.set(n.depth, n.box.w);
    for (const c of n.children) scanSideWidths(c, map);
  };
  for (const c of leftChildren) scanSideWidths(c, leftDepthMaxW);
  for (const c of rightChildren) scanSideWidths(c, rightDepthMaxW);

  const rightColLeftX = new Map<number, number>();
  let curRightX = root.box.w + gap;
  const maxRightDepth = Math.max(...Array.from(rightDepthMaxW.keys()), 0);
  for (let d = 1; d <= maxRightDepth; d++) {
    rightColLeftX.set(d, curRightX);
    curRightX += (rightDepthMaxW.get(d) ?? DEFAULT_CARD_W) + gap;
  }

  const leftColRightX = new Map<number, number>();
  let curLeftRightEdge = -gap;
  const maxLeftDepth = Math.max(...Array.from(leftDepthMaxW.keys()), 0);
  for (let d = 1; d <= maxLeftDepth; d++) {
    leftColRightX.set(d, curLeftRightEdge);
    curLeftRightEdge -= (leftDepthMaxW.get(d) ?? DEFAULT_CARD_W) + gap;
  }

  const leftTotalH =
    leftChildren.length > 0
      ? leftChildren.reduce((s, c) => s + c.subtreeH, 0) + (leftChildren.length - 1) * gap
      : 0;
  const rightTotalH =
    rightChildren.length > 0
      ? rightChildren.reduce((s, c) => s + c.subtreeH, 0) + (rightChildren.length - 1) * gap
      : 0;

  const overallH = Math.max(root.box.h, leftTotalH, rightTotalH);
  const rawPos = new Map<string, { x: number; y: number }>();
  rawPos.set(root.id, { x: 0, y: (overallH - root.box.h) / 2 });

  const assignSideTree = (n: TreeNode, topY: number, side: "left" | "right") => {
    const x =
      side === "right"
        ? (rightColLeftX.get(n.depth) ?? root.box.w + gap)
        : (leftColRightX.get(n.depth) ?? -gap) - n.box.w;
    rawPos.set(n.id, { x, y: topY + (n.subtreeH - n.box.h) / 2 });
    if (n.children.length === 0) return;
    const span = n.children.reduce((s, c) => s + c.subtreeH, 0) + (n.children.length - 1) * gap;
    let childTop = topY + (n.subtreeH - span) / 2;
    for (const c of n.children) {
      assignSideTree(c, childTop, side);
      childTop += c.subtreeH + gap;
    }
  };

  let leftTop = (overallH - leftTotalH) / 2;
  for (const c of leftChildren) {
    assignSideTree(c, leftTop, "left");
    leftTop += c.subtreeH + gap;
  }

  let rightTop = (overallH - rightTotalH) / 2;
  for (const c of rightChildren) {
    assignSideTree(c, rightTop, "right");
    rightTop += c.subtreeH + gap;
  }

  return normalizeClusterPositions(rawPos, boxMap, root.box);
}

function layoutClusterRadial(root: TreeNode, gap: number): ClusterLayoutResult {
  computeSubtreeMetrics(root, gap);
  const boxMap = new Map<string, LayoutBox>();
  const byDepth = new Map<number, TreeNode[]>();

  const collectByDepth = (n: TreeNode) => {
    boxMap.set(n.id, n.box);
    const list = byDepth.get(n.depth) ?? [];
    list.push(n);
    byDepth.set(n.depth, list);
    for (const c of n.children) collectByDepth(c);
  };
  collectByDepth(root);

  const maxDepth = Math.max(...Array.from(byDepth.keys()), 0);
  const rawPos = new Map<string, { x: number; y: number }>();
  rawPos.set(root.id, { x: -root.box.w / 2, y: -root.box.h / 2 });

  if (maxDepth === 0) {
    return normalizeClusterPositions(rawPos, boxMap, root.box);
  }

  const ringRadius = new Map<number, number>();
  ringRadius.set(0, 0);
  let prevOuterSpan = Math.hypot(root.box.w / 2, root.box.h / 2);

  for (let d = 1; d <= maxDepth; d++) {
    const ringNodes = byDepth.get(d) ?? [];
    const maxHalfDiag = Math.max(...ringNodes.map((n) => Math.hypot(n.box.w / 2, n.box.h / 2)), 80);
    const radialMinR = (ringRadius.get(d - 1) ?? 0) + prevOuterSpan + maxHalfDiag + gap;
    const totalArcNeed = ringNodes.reduce((sum, n) => sum + Math.hypot(n.box.w, n.box.h) + gap, 0);
    const circumMinR = ringNodes.length > 1 ? totalArcNeed / (2 * Math.PI) : 0;
    ringRadius.set(d, Math.max(radialMinR, circumMinR));
    prevOuterSpan = maxHalfDiag;
  }

  const placedBoxes: { id: string; x: number; y: number; w: number; h: number }[] = [
    { id: root.id, x: -root.box.w / 2, y: -root.box.h / 2, w: root.box.w, h: root.box.h },
  ];

  const assignRadialAngles = (
    children: TreeNode[],
    startAngle: number,
    endAngle: number,
    fullCircle: boolean,
  ) => {
    if (children.length === 0) return;
    const totalWeight = children.reduce((s, c) => s + c.subtreeWeight, 0);
    let cursorAngle = startAngle;
    const spanAngle = endAngle - startAngle;

    children.forEach((child, idx) => {
      const slice =
        fullCircle && children.length <= 8
          ? spanAngle / children.length
          : spanAngle * (child.subtreeWeight / Math.max(1, totalWeight));
      const theta =
        fullCircle && children.length <= 8 ? startAngle + idx * slice : cursorAngle + slice / 2;

      const r = ringRadius.get(child.depth) ?? 240;
      let cx = r * Math.cos(theta);
      let cy = r * Math.sin(theta);

      const ux = Math.cos(theta);
      const uy = Math.sin(theta);
      let safetySteps = 0;
      while (
        safetySteps < 40 &&
        placedBoxes.some((obs) =>
          boxesConflict(
            { x: cx - child.box.w / 2, y: cy - child.box.h / 2, w: child.box.w, h: child.box.h },
            obs,
            gap,
          ),
        )
      ) {
        cx += ux * 20;
        cy += uy * 20;
        safetySteps++;
      }

      const finalX = cx - child.box.w / 2;
      const finalY = cy - child.box.h / 2;
      rawPos.set(child.id, { x: finalX, y: finalY });
      placedBoxes.push({ id: child.id, x: finalX, y: finalY, w: child.box.w, h: child.box.h });

      if (child.children.length > 0) {
        const subStart = fullCircle && children.length <= 8 ? theta - slice / 2 : cursorAngle;
        const subEnd = fullCircle && children.length <= 8 ? theta + slice / 2 : cursorAngle + slice;
        assignRadialAngles(child.children, subStart, subEnd, false);
      }

      cursorAngle += slice;
    });
  };

  assignRadialAngles(root.children, -Math.PI / 2, (3 * Math.PI) / 2, true);
  return normalizeClusterPositions(rawPos, boxMap, root.box);
}

export function autoLayoutCards(
  cards: readonly LayoutBox[],
  links: readonly LayoutLink[],
  options: AutoLayoutOptions,
): Map<string, { x: number; y: number }> {
  const gridSize = options.gridSize ?? GRID_SIZE;
  const snap = options.snapToGrid ?? false;
  const rawGap = options.gap ?? DEFAULT_LAYOUT_GAP;
  const gap = snap ? Math.max(gridSize, snapToGridValue(rawGap, gridSize)) : rawGap;

  if (cards.length === 0) return new Map();
  if (options.mode === "grid") {
    return layoutGrid(cards, gap, snap, gridSize);
  }

  // 當開啟格線對齊時，先將參與計算的卡片包圍盒無條件進位到格線倍數，確保欄列對齊後不會因取整而壓縮邊距
  const effectiveCards: LayoutBox[] = snap
    ? cards.map((c) => ({
        ...c,
        w: Math.ceil(c.w / gridSize) * gridSize,
        h: Math.ceil(c.h / gridSize) * gridSize,
      }))
    : [...cards];

  const typeSideMap: Record<RelationType, "left" | "right"> = {
    ...DEFAULT_TYPE_SIDE_MAP,
    ...(options.typeSideMap ?? {}),
  };

  const trees = buildClusterTrees(effectiveCards, links, {
    mode: options.mode,
    clusterThreshold: options.clusterThreshold ?? 4,
    centerCardId: options.centerCardId,
    splitMode: options.splitMode ?? "type",
    typeSideMap,
  });

  const clusters: ClusterLayoutResult[] = trees.map((root) => {
    if (options.mode === "radial") return layoutClusterRadial(root, gap);
    if (options.mode === "right") return layoutClusterRight(root, gap);
    return layoutClusterSplit(root, gap);
  });

  clusters.sort((a, b) => {
    const aMulti = a.positions.size > 1 ? 0 : 1;
    const bMulti = b.positions.size > 1 ? 0 : 1;
    if (aMulti !== bMulti) return aMulti - bMulti;
    return compareTopLeft(a.anchorCard, b.anchorCard);
  });

  const minX = Math.min(...cards.map((c) => c.x));
  const minY = Math.min(...cards.map((c) => c.y));
  const origMaxX = Math.max(...cards.map((c) => c.x + c.w));
  const startX = snap ? snapToGridValue(minX, gridSize) : Math.round(minX);
  const startY = snap ? snapToGridValue(minY, gridSize) : Math.round(minY);
  const clusterGap = snap
    ? Math.max(gridSize * 2, snapToGridValue(gap * 1.5, gridSize))
    : Math.round(Math.max(60, gap * 1.5));

  const totalArea = clusters.reduce((s, c) => s + (c.width + clusterGap) * (c.height + clusterGap), 0);
  const maxClusterW = Math.max(...clusters.map((c) => c.width), DEFAULT_CARD_W);
  const shelfMaxWidth = Math.max(
    origMaxX - minX,
    maxClusterW,
    Math.round(Math.sqrt(totalArea) * 1.5),
    1200,
  );

  const finalPositions = new Map<string, { x: number; y: number }>();
  let cursorX = startX;
  let cursorY = startY;
  let shelfRowHeight = 0;

  for (const cluster of clusters) {
    if (cursorX > startX && cursorX + cluster.width > startX + shelfMaxWidth) {
      cursorX = startX;
      cursorY += shelfRowHeight + clusterGap;
      shelfRowHeight = 0;
    }

    const offsetX = snap ? snapToGridValue(cursorX, gridSize) : Math.round(cursorX);
    const offsetY = snap ? snapToGridValue(cursorY, gridSize) : Math.round(cursorY);

    for (const [id, relPos] of cluster.positions.entries()) {
      const rawX = offsetX + relPos.x;
      const rawY = offsetY + relPos.y;
      finalPositions.set(id, {
        x: snap ? snapToGridValue(rawX, gridSize) : Math.round(rawX),
        y: snap ? snapToGridValue(rawY, gridSize) : Math.round(rawY),
      });
    }

    cursorX = offsetX + cluster.width + clusterGap;
    if (cluster.height > shelfRowHeight) {
      shelfRowHeight = cluster.height;
    }
  }

  return finalPositions;
}