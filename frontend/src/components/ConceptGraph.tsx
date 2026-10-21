import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ConceptGraphEdge, ConceptGraphNode } from "../types";

interface Props {
  selectedTagId?: string;
  version: number;
  onSelectTag(tagId: string): void;
  report(e: unknown, prefix?: string): void;
}

interface PositionedNode extends ConceptGraphNode {
  x: number;
  y: number;
  r: number;
  comm: number; // 群落編號；-1 = 孤立或單點群落
}

const COMMUNITY_PALETTE = [
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#ef4444",
  "#84cc16",
  "#06b6d4",
  "#f97316",
];

// 顏色＝自動偵測的群落；收納位置節點與孤立節點維持灰色，才不會和概念群落混淆
function colorForNode(node: PositionedNode): string {
  if (node.axis === "location" || node.axis === "domain" || node.comm < 0) return "#64748b";
  return COMMUNITY_PALETTE[node.comm % COMMUNITY_PALETTE.length];
}

// 群落偵測：Louvain 的第一階段（只做節點搬移，最大化 modularity）。
// 以共現次數為權重、固定走訪順序，同樣的資料一定得到同樣的群落；回傳 -1 = 孤立或單點群落。
function detectCommunities(nodes: ConceptGraphNode[], edges: ConceptGraphEdge[]): Map<string, number> {
  const idx = new Map<string, number>(nodes.map((n, i) => [n.id, i]));
  const adj: Map<number, number>[] = nodes.map(() => new Map<number, number>());
  let m2 = 0;
  for (const e of edges) {
    const u = idx.get(e.source_id);
    const v = idx.get(e.target_id);
    if (u === undefined || v === undefined) continue;
    adj[u].set(v, (adj[u].get(v) ?? 0) + e.co_count);
    adj[v].set(u, (adj[v].get(u) ?? 0) + e.co_count);
    m2 += 2 * e.co_count;
  }
  if (m2 === 0) return new Map(nodes.map((n) => [n.id, -1]));

  const strength = adj.map((a) => {
    let s = 0;
    a.forEach((w) => {
      s += w;
    });
    return s;
  });
  const label = nodes.map((_, i) => i);
  const total = strength.slice();
  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      if (strength[i] === 0) continue;
      const toComm = new Map<number, number>();
      adj[i].forEach((w, j) => toComm.set(label[j], (toComm.get(label[j]) ?? 0) + w));
      const cur = label[i];
      total[cur] -= strength[i];
      let best = cur;
      let bestGain = (toComm.get(cur) ?? 0) - (total[cur] * strength[i]) / m2;
      toComm.forEach((w, c) => {
        const gain = w - (total[c] * strength[i]) / m2;
        if (gain > bestGain + 1e-12) {
          best = c;
          bestGain = gain;
        }
      });
      total[best] += strength[i];
      if (best !== cur) {
        label[i] = best;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const size = new Map<number, number>();
  label.forEach((c, i) => {
    if (strength[i] > 0) size.set(c, (size.get(c) ?? 0) + 1);
  });
  const rank = new Map<number, number>(
    [...size.entries()]
      .filter(([, s]) => s >= 2)
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([c], r) => [c, r]),
  );
  return new Map(nodes.map((n, i) => [n.id, strength[i] > 0 ? (rank.get(label[i]) ?? -1) : -1]));
}

function computeForceLayout(
  nodes: ConceptGraphNode[],
  edges: ConceptGraphEdge[],
  degree: Map<string, number>,
): PositionedNode[] {
  const n = nodes.length;
  if (n === 0) return [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const comm = detectCommunities(nodes, edges);

  // 初始位置：同群落先擠在同一處，各群落沿螺旋散開、孤立節點在外圈，力導向只需微調，不必從混雜狀態硬拆
  const groups = new Map<number, string[]>();
  for (const node of nodes) {
    const c = comm.get(node.id) ?? -1;
    const g = groups.get(c);
    if (g) g.push(node.id);
    else groups.set(c, [node.id]);
  }
  const slot = new Map<string, number>();
  const center = new Map<number, { x: number; y: number }>();
  [...groups.keys()]
    .sort((a, b) => (a < 0 ? 1e9 : a) - (b < 0 ? 1e9 : b))
    .forEach((c, gi) => {
      (groups.get(c) ?? []).forEach((id, s) => slot.set(id, s));
      const dist = c < 0 ? 300 : 260 * Math.sqrt(gi + 0.5);
      center.set(c, { x: Math.cos(gi * goldenAngle) * dist, y: Math.sin(gi * goldenAngle) * dist });
    });

  const pos: PositionedNode[] = nodes.map((node) => {
    const c = comm.get(node.id) ?? -1;
    // 半徑跟連線數走（含被鄰居上限隱藏的），樞紐一眼可見；標籤放節點下方，所以小點也讀得到
    const r = 8 + Math.min(28, Math.sqrt(degree.get(node.id) ?? 0) * 7);
    const ctr = center.get(c) ?? { x: 0, y: 0 };
    const s = slot.get(node.id) ?? 0;
    const spread = 60 * Math.sqrt((s + 0.5) / (groups.get(c)?.length ?? 1)) * (c < 0 ? 3 : 1);
    return { ...node, comm: c, r, x: ctr.x + Math.cos(s * goldenAngle) * spread, y: ctr.y + Math.sin(s * goldenAngle) * spread };
  });

  const idxById = new Map<string, number>();
  pos.forEach((p, idx) => idxById.set(p.id, idx));

  const validEdges = edges
    .map((e) => ({
      u: idxById.get(e.source_id),
      v: idxById.get(e.target_id),
      weight: e.co_count,
    }))
    .filter((e): e is { u: number; v: number; weight: number } => e.u !== undefined && e.v !== undefined);

  const iterations = 120;
  // 斥力係數與彈簧分母：舊值（k=110 → 斥力 12100）在 30 個以上的群落會把群落撐到半徑 600+，群落間分不開
  const repulsion = 400;
  const spring = 6;
  for (let iter = 0; iter < iterations; iter++) {
    const temp = (1 - iter / iterations) * 18;
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);

    // 節點斥力（防止重疊）；跨群落斥力較強、空隙較大
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[i].x - pos[j].x;
        let dy = pos[i].y - pos[j].y;
        let distSq = dx * dx + dy * dy;
        if (distSq < 1) {
          dx = (i - j) * 0.5;
          dy = 0.5;
          distSq = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(distSq);
        const same = pos[i].comm >= 0 && pos[i].comm === pos[j].comm;
        // 斥力 1/d 無距離上限，孤立節點沒有引力牽制會被推出畫布；同群落 260、跨群落 420 以外不再互斥
        if (dist > (same ? 260 : 420)) continue;
        const minDist = pos[i].r + pos[j].r + (same ? 28 : 60);
        const repulse = (repulsion / dist) * (dist < minDist ? 2.4 : 1.0) * (same ? 1 : 1.8);
        const ux = (dx / dist) * repulse;
        const uy = (dy / dist) * repulse;
        fx[i] += ux;
        fy[i] += uy;
        fx[j] -= ux;
        fy[j] -= uy;
      }
    }

    // 共現引力：群落內拉得緊、群落間拉得鬆（相關的群落仍會相鄰）
    for (const e of validEdges) {
      const dx = pos[e.v].x - pos[e.u].x;
      const dy = pos[e.v].y - pos[e.u].y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const same = pos[e.u].comm >= 0 && pos[e.u].comm === pos[e.v].comm;
      const ideal = same ? 110 : 260;
      const attract = ((dist - ideal) / spring) * (1 + Math.min(3, e.weight * 0.35)) * (same ? 1 : 0.4);
      const ux = (dx / dist) * attract;
      const uy = (dy / dist) * attract;
      fx[e.u] += ux;
      fy[e.u] += uy;
      fx[e.v] -= ux;
      fy[e.v] -= uy;
    }

    // 群落向心：同群落節點拉向自己的重心，群落之間才會留出空隙
    const cen = new Map<number, { x: number; y: number; n: number }>();
    for (const p of pos) {
      if (p.comm < 0) continue;
      const a = cen.get(p.comm);
      if (a) {
        a.x += p.x;
        a.y += p.y;
        a.n += 1;
      } else {
        cen.set(p.comm, { x: p.x, y: p.y, n: 1 });
      }
    }

    // 向心微引力（防止孤立概念飄遠）
    for (let i = 0; i < n; i++) {
      const cc = cen.get(pos[i].comm);
      if (cc) {
        fx[i] += (cc.x / cc.n - pos[i].x) * 0.1;
        fy[i] += (cc.y / cc.n - pos[i].y) * 0.1;
      }
      fx[i] -= pos[i].x * 0.03;
      fy[i] -= pos[i].y * 0.03;
      const mag = Math.hypot(fx[i], fy[i]);
      if (mag > 0) {
        const step = Math.min(temp, mag);
        pos[i].x += (fx[i] / mag) * step;
        pos[i].y += (fy[i] / mag) * step;
      }
    }
  }

  return pos;
}

export function ConceptGraph(props: Props) {
  const { selectedTagId, version, onSelectTag, report } = props;
  const [rawNodes, setRawNodes] = useState<ConceptGraphNode[]>([]);
  const [edges, setEdges] = useState<ConceptGraphEdge[]>([]);
  const [hiddenEdges, setHiddenEdges] = useState<ConceptGraphEdge[]>([]);
  const [loading, setLoading] = useState(false);

  // 過濾控制項
  const [minCo, setMinCo] = useState(1);
  const [minJaccard, setMinJaccard] = useState(0);
  const [maxNeighbors, setMaxNeighbors] = useState(8);
  const [facetFilter, setFacetFilter] = useState<string>("all");
  const [includeLocations, setIncludeLocations] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  // 畫布視角與手動拖曳位置覆寫
  const [pan, setPan] = useState({ x: 0, y: 0, zoom: 1 });
  const [manualPos, setManualPos] = useState<Record<string, { x: number; y: number }>>({});
  const svgRef = useRef<SVGSVGElement>(null);
  const dragState = useRef<
    | { kind: "pan"; startX: number; startY: number; origX: number; origY: number }
    | { kind: "node"; id: string; startX: number; startY: number; origX: number; origY: number; moved: boolean }
    | null
  >(null);

  const loadGraph = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getConceptGraph({
        min_cooccurrence: minCo,
        min_jaccard: minJaccard,
        max_neighbors: maxNeighbors,
        include_locations: includeLocations,
      });
      setRawNodes(res.nodes);
      setEdges(res.edges);
      setHiddenEdges(res.hidden_edges ?? []);
    } catch (e) {
      report(e, "載入概念圖譜失敗");
    } finally {
      setLoading(false);
    }
  }, [includeLocations, maxNeighbors, minCo, minJaccard, report]);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph, version]);

  const facetCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let unassigned = 0;
    rawNodes.forEach((n) => {
      if (n.facet) counts.set(n.facet, (counts.get(n.facet) ?? 0) + 1);
      else if (n.axis !== "location" && n.axis !== "domain") unassigned += 1;
    });
    const list = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, "zh-Hant"));
    return { list, counts, unassigned };
  }, [rawNodes]);

  const filteredNodes = useMemo(() => {
    if (facetFilter === "all") return rawNodes;
    if (facetFilter === "__unassigned__") {
      return rawNodes.filter((n) => !n.facet && n.axis !== "location" && n.axis !== "domain");
    }
    return rawNodes.filter((n) => (n.facet ?? "") === facetFilter);
  }, [facetFilter, rawNodes]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);

  const filteredEdges = useMemo(
    () => edges.filter((e) => filteredNodeIds.has(e.source_id) && filteredNodeIds.has(e.target_id)),
    [edges, filteredNodeIds],
  );

  // 被鄰居上限擋下的連線：不參與排版（滑過節點時整張圖才不會重排），只用於連線數與滑過時補畫
  const filteredHidden = useMemo(
    () => hiddenEdges.filter((e) => filteredNodeIds.has(e.source_id) && filteredNodeIds.has(e.target_id)),
    [hiddenEdges, filteredNodeIds],
  );

  const degreeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of [...filteredEdges, ...filteredHidden]) {
      m.set(e.source_id, (m.get(e.source_id) ?? 0) + 1);
      m.set(e.target_id, (m.get(e.target_id) ?? 0) + 1);
    }
    return m;
  }, [filteredEdges, filteredHidden]);

  // 排版與群落偵測用完整關聯（含被上限隱藏的），群落才不會被「每點只畫 8 條」切碎；滑過節點不改資料，所以不會重排
  const baseLayout = useMemo(
    () => computeForceLayout(filteredNodes, [...filteredEdges, ...filteredHidden], degreeMap),
    [filteredNodes, filteredEdges, filteredHidden, degreeMap],
  );

  // 只用排版結果（不含手動拖曳）算視角，拖曳節點時畫面才不會跟著縮放；餘裕留給半徑與下方標籤
  const fit = useMemo(() => {
    if (baseLayout.length === 0) return { zoom: 1, cx: 0, cy: 0 };
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const n of baseLayout) {
      minX = Math.min(minX, n.x - n.r - 60);
      maxX = Math.max(maxX, n.x + n.r + 60);
      minY = Math.min(minY, n.y - n.r);
      maxY = Math.max(maxY, n.y + n.r + 36);
    }
    const zoom = Math.min(1.2, 880 / (maxX - minX), 620 / (maxY - minY));
    return { zoom, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }, [baseLayout]);

  const nodes = useMemo(
    () =>
      baseLayout.map((n) => {
        const override = manualPos[n.id];
        return override ? { ...n, x: override.x, y: override.y } : n;
      }),
    [baseLayout, manualPos],
  );

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const focusId = hoveredId ?? selectedTagId ?? null;
  // 滑過／選取的節點取消鄰居上限：補畫它被隱藏的連線，隱藏的鄰居也不再被淡化
  const revealedEdges = useMemo(
    () => (focusId ? filteredHidden.filter((e) => e.source_id === focusId || e.target_id === focusId) : []),
    [filteredHidden, focusId],
  );
  const drawnEdges = useMemo(() => [...filteredEdges, ...revealedEdges], [filteredEdges, revealedEdges]);
  const connectedIds = useMemo(() => {
    if (!focusId) return null;
    const s = new Set<string>([focusId]);
    for (const e of drawnEdges) {
      if (e.source_id === focusId) s.add(e.target_id);
      if (e.target_id === focusId) s.add(e.source_id);
    }
    return s;
  }, [drawnEdges, focusId]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.9;
    setPan((p) => ({
      ...p,
      zoom: Math.min(2.8, Math.max(0.25, Number((p.zoom * factor).toFixed(3)))),
    }));
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = dragState.current;
    if (!st) return;
    if (st.kind === "pan") {
      setPan((p) => ({
        ...p,
        x: st.origX + (e.clientX - st.startX),
        y: st.origY + (e.clientY - st.startY),
      }));
    } else if (st.kind === "node") {
      // 節點座標在排版空間，要同時除掉使用者縮放與自動縮放，節點才跟得上游標
      const dx = (e.clientX - st.startX) / (pan.zoom * fit.zoom);
      const dy = (e.clientY - st.startY) / (pan.zoom * fit.zoom);
      if (Math.hypot(dx, dy) > 3) st.moved = true;
      setManualPos((m) => ({
        ...m,
        [st.id]: { x: st.origX + dx, y: st.origY + dy },
      }));
    }
  };

  const onPointerUp = () => {
    const st = dragState.current;
    dragState.current = null;
    if (st && st.kind === "node" && !st.moved) {
      onSelectTag(st.id);
    }
  };

  return (
    <div className="concept-graph" role="region" aria-label="全域概念地圖">
      <div className="graph-controls">
        <label className="graph-ctrl-item" title="兩概念至少同時出現在幾張卡片才建立共現虛線">
          <span>共現門檻 ≥ {minCo} 張</span>
          <input
            type="range"
            min={1}
            max={10}
            step={1}
            value={minCo}
            onChange={(e) => setMinCo(Number(e.target.value))}
          />
        </label>
        <label className="graph-ctrl-item" title="Jaccard 關聯強度過濾（共現數 ÷ 聯集卡片數）">
          <span>最低強度 ≥ {Math.round(minJaccard * 100)}%</span>
          <input
            type="range"
            min={0}
            max={0.8}
            step={0.05}
            value={minJaccard}
            onChange={(e) => setMinJaccard(Number(e.target.value))}
          />
        </label>
        <label className="graph-ctrl-item" title="限制單一概念最多顯示幾條最強共現連線，避免樞紐標籤過度連線">
          <span>鄰居上限 {maxNeighbors}</span>
          <input
            type="range"
            min={2}
            max={20}
            step={1}
            value={maxNeighbors}
            onChange={(e) => setMaxNeighbors(Number(e.target.value))}
          />
        </label>
        <label className="graph-ctrl-item">
          <span>維度：</span>
          <select
            value={facetFilter}
            onChange={(e) => {
              setFacetFilter(e.target.value);
              setPan({ x: 0, y: 0, zoom: 1 });
            }}
            aria-label="篩選描述維度"
          >
            <option value="all">全部維度（{rawNodes.length}）</option>
            <option value="__unassigned__">
              未指定維度（待定：{facetCounts.unassigned}）
            </option>
            {facetCounts.list.map((f) => (
              <option key={f} value={f}>
                {f}（{facetCounts.counts.get(f) ?? 0}）
              </option>
            ))}
          </select>
        </label>
        <label className="graph-ctrl-item">
          <input
            type="checkbox"
            checked={includeLocations}
            onChange={(e) => setIncludeLocations(e.target.checked)}
          />
          <span>含收納位置</span>
        </label>
        <button
          onClick={() => {
            setManualPos({});
            setPan({ x: 0, y: 0, zoom: 1 });
          }}
          title="重設圖譜視角與節點排佈"
        >
          重置視角
        </button>
      </div>

      <svg
        ref={svgRef}
        className="graph-svg"
        viewBox="-480 -340 960 680"
        onWheel={onWheel}
        onPointerDown={(e) => {
          if (e.target === svgRef.current) {
            dragState.current = {
              kind: "pan",
              startX: e.clientX,
              startY: e.clientY,
              origX: pan.x,
              origY: pan.y,
            };
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${pan.zoom * fit.zoom}) translate(${-fit.cx}, ${-fit.cy})`}>
          {/* 卡片共現關係（虛線）：含滑過／選取節點被上限隱藏的連線 */}
          {drawnEdges.map((e) => {
            const u = nodeMap.get(e.source_id);
            const v = nodeMap.get(e.target_id);
            if (!u || !v) return null;
            const isHighlighted =
              focusId !== null && (e.source_id === focusId || e.target_id === focusId);
            const isDimmed = focusId !== null && !isHighlighted;
            const strokeW = Math.min(5, 1.4 + Math.log2(e.co_count + 1));
            const mx = (u.x + v.x) / 2;
            const my = (u.y + v.y) / 2;
            return (
              <g key={`${e.source_id}__${e.target_id}`} opacity={isDimmed ? 0.14 : 0.88}>
                <line
                  x1={u.x}
                  y1={u.y}
                  x2={v.x}
                  y2={v.y}
                  stroke={isHighlighted ? "var(--accent)" : "var(--muted)"}
                  strokeWidth={strokeW}
                  strokeDasharray="5 4"
                />
                {/* 補畫隱藏連線時只標註共現 ≥ 2 的強連線，避免數十張標籤互相蓋住 */}
                {(e.co_count >= 2 || (isHighlighted && revealedEdges.length === 0)) && (
                  <g transform={`translate(${mx}, ${my})`}>
                    <rect
                      x={-26}
                      y={-9}
                      width={52}
                      height={18}
                      rx={6}
                      fill="var(--panel)"
                      stroke="var(--line)"
                      strokeWidth={0.8}
                    />
                    <text
                      textAnchor="middle"
                      dy="3.5"
                      fontSize="10"
                      fill="var(--muted)"
                      fontWeight={isHighlighted ? 600 : 400}
                    >
                      共現 {e.co_count}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* 概念標籤節點 */}
          {nodes.map((node) => {
            const color = colorForNode(node);
            const isSelected = node.id === selectedTagId;
            const isDimmed = connectedIds !== null && !connectedIds.has(node.id);
            return (
              <g
                key={node.id}
                className="graph-node"
                transform={`translate(${node.x}, ${node.y})`}
                opacity={isDimmed ? 0.22 : 1}
                onPointerEnter={() => setHoveredId(node.id)}
                onPointerLeave={() => setHoveredId((cur) => (cur === node.id ? null : cur))}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  dragState.current = {
                    kind: "node",
                    id: node.id,
                    startX: e.clientX,
                    startY: e.clientY,
                    origX: node.x,
                    origY: node.y,
                    moved: false,
                  };
                }}
              >

                {isSelected && (
                  <circle
                    r={node.r + (node.is_bridge ? 8 : 6)}
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth={2.5}
                    strokeDasharray="4 2"
                  />
                )}
                {node.is_bridge && (
                  <circle
                    r={node.r + 4}
                    fill="none"
                    stroke="#f59e0b"
                    strokeWidth={2}
                  />
                )}
                <circle
                  r={node.r}
                  fill={color}
                  fillOpacity={0.6}
                  stroke={color}
                  strokeWidth={isSelected ? 3 : 2}
                />
                <text
                  textAnchor="middle"
                  y={node.r + 14}
                  fontSize="12"
                  fontWeight={600}
                  fill="var(--text)"
                  style={{
                    pointerEvents: "none",
                    userSelect: "none",
                    paintOrder: "stroke",
                    stroke: "var(--bg)",
                    strokeWidth: 3,
                    strokeLinejoin: "round",
                  }}
                >
                  {node.is_bridge ? `🌉 ${node.name}` : node.name}
                </text>
                {node.facet && (
                  <text
                    textAnchor="middle"
                    y={node.r + 26}
                    fontSize="9.5"
                    fill="var(--muted)"
                    style={{
                      pointerEvents: "none",
                      userSelect: "none",
                      paintOrder: "stroke",
                      stroke: "var(--bg)",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                    }}
                  >
                    {node.facet}
                  </text>
                )}
                <title>
                  {[
                    `${node.name}（${node.card_count} 張卡片、${degreeMap.get(node.id) ?? 0} 條連線）`,
                    node.is_bridge ? "角色：跨領域橋樑詞（已被關係句型引用）" : "",
                    node.facet
                      ? `維度：${node.facet}`
                      : node.axis === "location" || node.axis === "domain"
                        ? "類型：收納位置"
                        : "維度：未指定（待定）",
                    node.definition ? `定義：${node.definition}` : "",
                    node.aliases?.length ? `別名：${node.aliases.join("、")}` : "",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                </title>
              </g>
            );
          })}
        </g>
      </svg>

      {!loading && nodes.length === 0 && (
        <div className="board-hint">
          目前尚無概念標籤。請在左側「概念標籤（描述維度）」或卡片編輯器中新增概念標籤。
        </div>
      )}
      <div className="graph-legend">
        <span>點擊概念節點：於右側展開相關卡片</span>
        <span>·</span>
        <span>顏色：自動偵測的群落（灰色＝孤立）；大小：連線數；🌉 金色外環：橋樑詞</span>
        <span>·</span>
        <span>虛線：卡片共現關係（探索候選，不自動升格為正式語意連結）</span>
      </div>
    </div>
  );
}