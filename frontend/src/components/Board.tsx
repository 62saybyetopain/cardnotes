// @depends-on ../lib/layout.ts (autoLayoutCards, placeCardsAvoidingCollisions, snapDimension, snapToGridValue, GRID_SIZE)
import "@xyflow/react/dist/style.css";
import {
  applyNodeChanges,
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  NodeResizer,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  useReactFlow,
  ViewportPortal,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnNodeDrag,
} from "@xyflow/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { api } from "../api";
import { isEditableTarget, isRemoveKey } from "../lib/keys";
import {
  autoLayoutCards,
  DEFAULT_CARD_H,
  DEFAULT_CARD_W,
  DEFAULT_LAYOUT_GAP,
  DEFAULT_TYPE_SIDE_MAP,
  GRID_SIZE,
  placeCardsAvoidingCollisions,
  snapDimension,
  snapToGridValue,
  type LayoutBox,
  type LayoutMode,
  type SplitMode,
} from "../lib/layout";
import { computeMagnetSnap, MAGNET_THRESHOLD_PX, quantizeFromStart, type MagnetGuide } from "../lib/magnet";
import {
  LINK_STATUS_LABELS,
  RELATION_COLORS,
  RELATION_LABELS,
  type BoardCard,
  type BoardGroup,
  type BoardLink,
  type LinkStatus,
  type RelationType,
} from "../types";
import { CardNode, type CardFlowNode } from "./CardNode";
import { FloatingEdge } from "./FloatingEdge";

export interface GroupNodeData extends Record<string, unknown> {
  groupId: string;
  label: string;
  color: string;
  onResizeEnd: (groupId: string, p: { x: number; y: number; width: number; height: number }) => void;
  onRename: (groupId: string, currentLabel: string) => void;
  onCycleColor: (groupId: string, currentColor: string) => void;
  onRemoveGroup: (groupId: string) => void;
}
export type GroupFlowNode = Node<GroupNodeData, "boardGroup">;
type AnyFlowNode = CardFlowNode | GroupFlowNode;
type PositionChange = Extract<NodeChange<AnyFlowNode>, { type: "position" }>;

const GROUP_COLORS = ["slate", "blue", "green", "amber", "purple"] as const;

function GroupNode({ data, selected }: NodeProps<GroupFlowNode>) {
  return (
    <div className={`group-node color-${data.color || "slate"}${selected ? " selected" : ""}`}>
      <NodeResizer
        minWidth={220}
        minHeight={140}
        isVisible={true}
        onResizeEnd={(_e, p) => data.onResizeEnd(data.groupId, p)}
      />
      <div className="group-header">
        <span
          className="group-title"
          onDoubleClick={(e) => (e.stopPropagation(), data.onRename(data.groupId, data.label))}
          title="雙擊修改分組名稱"
        >
          {data.label || "視覺分組（未命名）"}
        </span>
        <span className="group-actions nodrag">
          <button
            onClick={(e) => (e.stopPropagation(), data.onCycleColor(data.groupId, data.color))}
            title="切換分組框顏色"
            aria-label="切換分組框顏色"
          >
            🎨
          </button>
          <button
            onClick={(e) => (e.stopPropagation(), data.onRename(data.groupId, data.label))}
            title="重新命名分組"
            aria-label="重新命名分組"
          >
            ✎
          </button>
          <button
            onClick={(e) => (e.stopPropagation(), data.onRemoveGroup(data.groupId))}
            title="刪除此視覺分組框（不影響卡片）"
            aria-label="刪除分組框"
          >
            ✕
          </button>
        </span>
      </div>
    </div>
  );
}

const nodeTypes = { card: CardNode, boardGroup: GroupNode };
const edgeTypes = { floating: FloatingEdge };

export interface BoardHandle {
  addCard(cardId: string): Promise<void>;
  updateCard(card: { id: string; title: string; body: string }): void;
  removeCard(cardId: string): void;
  removeLink(sourceId: string, targetId: string, relationType?: RelationType): void;
  addLink(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  createGroup(): Promise<void>;
}

interface Props {
  boardId: string | null;
  selectedCardId: string | null;
  active?: boolean;
  onSelectCard(id: string | null): void;
  onOpenCard?(id: string): void;
  onLinksChanged(): void;
  onCountChanged(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

interface Geometry {
  x: number;
  y: number;
  w: number | null;
  h: number | null;
}

interface SavedViewport {
  x: number;
  y: number;
  zoom: number;
}

const vpKey = (boardId: string) => `cardboard:viewport:${boardId}`;

function loadViewport(boardId: string): SavedViewport | null {
  try {
    const raw = localStorage.getItem(vpKey(boardId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (
      typeof v?.x === "number" &&
      Number.isFinite(v.x) &&
      typeof v?.y === "number" &&
      Number.isFinite(v.y) &&
      typeof v?.zoom === "number" &&
      Number.isFinite(v.zoom)
    ) {
      return { x: v.x, y: v.y, zoom: v.zoom };
    }
  } catch {
    /* localStorage 不可用或資料損毀時忽略 */
  }
  return null;
}

function saveViewport(boardId: string, vp: SavedViewport): void {
  try {
    localStorage.setItem(vpKey(boardId), JSON.stringify({ x: vp.x, y: vp.y, zoom: vp.zoom }));
  } catch {
    /* localStorage 無法寫入時忽略 */
  }
}

const SNAP_KEY = "cardboard:snap-to-grid";

function loadSnapToGrid(): boolean {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function saveSnapToGrid(enabled: boolean): void {
  try {
    localStorage.setItem(SNAP_KEY, enabled ? "true" : "false");
  } catch {
    /* localStorage 無法寫入時忽略 */
  }
}

function nodeBox(n: CardFlowNode): LayoutBox {
  return {
    id: n.id,
    x: n.position.x,
    y: n.position.y,
    w: n.measured?.width ?? n.width ?? DEFAULT_CARD_W,
    h: n.measured?.height ?? n.height ?? DEFAULT_CARD_H,
  };
}

function normalizeLink(l: Partial<BoardLink> & { source_id: string; target_id: string }): BoardLink {
  return {
    ...l,
    source_id: l.source_id,
    target_id: l.target_id,
    relation_type: l.relation_type ?? "extend",
    status: l.status ?? "confirmed",
    reason: l.reason ?? "",
  };
}

function BoardInner(props: Props & { innerRef: Ref<BoardHandle> }) {
  const { boardId, selectedCardId, active = true, onSelectCard, onOpenCard, onLinksChanged, onCountChanged, report, info, innerRef } = props;
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<AnyFlowNode[]>([]);
  const [links, setLinks] = useState<BoardLink[]>([]);
  const [editingLink, setEditingLink] = useState<BoardLink | null>(null);
  const [loading, setLoading] = useState(false);

  // ---- 自動對齊與心智圖／網格自動排版狀態 ----
  const [snapToGrid, setSnapToGrid] = useState<boolean>(() => loadSnapToGrid());
  const snapRef = useRef(snapToGrid);
  snapRef.current = snapToGrid;

  const [layoutMode, setLayoutMode] = useState<LayoutMode>("grid");
  const [layoutGap, setLayoutGap] = useState<number>(DEFAULT_LAYOUT_GAP);
  const [clusterThreshold, setClusterThreshold] = useState<number>(4);
  const [splitMode, setSplitMode] = useState<SplitMode>("type");
  const [typeSideMap, setTypeSideMap] = useState<Record<RelationType, "left" | "right">>(() => ({
    ...DEFAULT_TYPE_SIDE_MAP,
  }));
  const [showSplitConfig, setShowSplitConfig] = useState(false);

  // 中心卡片指定狀態（可由拖曳中心圖標或點選卡片指定）
  const [designatedCenterId, setDesignatedCenterId] = useState<string | null>(null);
  const [lastClickedCardId, setLastClickedCardId] = useState<string | null>(null);
  const [pickingCenterDrag, setPickingCenterDrag] = useState(false);

  // 自動排版單次復原快照
  const [undoSnapshot, setUndoSnapshot] = useState<{ card_id: string; x: number; y: number }[] | null>(null);

  const saved = useRef(new Map<string, Geometry>()); // 伺服器上確認過的位置，失敗時回復用
  const groupDragRef = useRef<{ groupId: string; startX: number; startY: number; memberIds: string[] } | null>(null);
  const viewportReady = useRef(false);
  const dragStartRef = useRef(new Map<string, { x: number; y: number }>()); // 拖曳開始時各節點位置，Shift 以起點為基準取整
  const shiftRef = useRef(false);
  const [magnetGuides, setMagnetGuides] = useState<MagnetGuide[]>([]);

  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      shiftRef.current = e.shiftKey;
    };
    const clear = () => {
      shiftRef.current = false;
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
      window.removeEventListener("blur", clear);
    };
  }, []);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const selectedRef = useRef(selectedCardId);
  selectedRef.current = selectedCardId;

  const toggleSnapToGrid = useCallback((checked: boolean) => {
    setSnapToGrid(checked);
    saveSnapToGrid(checked);
  }, []);

  // ---- 卡片縮放結束：開啟自動對齊時取整到格距；位置與尺寸一起寫回，失敗就回復 ----
  const resizeImpl = useRef<((id: string, p: { x: number; y: number; width: number; height: number }) => Promise<void>) | undefined>(undefined);
  resizeImpl.current = async (id, p) => {
    if (!boardId) return;
    const nextX = snapRef.current ? snapToGridValue(p.x, GRID_SIZE) : p.x;
    const nextY = snapRef.current ? snapToGridValue(p.y, GRID_SIZE) : p.y;
    const nextW = snapRef.current ? snapDimension(p.width, 180, GRID_SIZE) : p.width;
    const nextH = snapRef.current ? snapDimension(p.height, 80, GRID_SIZE) : p.height;
    try {
      await api.patchBoardCards(boardId, [{ card_id: id, x: nextX, y: nextY, w: nextW, h: nextH }]);
      saved.current.set(id, { x: nextX, y: nextY, w: nextW, h: nextH });
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id && n.type === "card"
            ? {
                ...n,
                position: { x: nextX, y: nextY },
                width: nextW,
                height: nextH,
                style: { width: nextW, height: nextH },
                data: { ...n.data, sized: true },
              }
            : n,
        ),
      );
    } catch (e) {
      const g = saved.current.get(id);
      if (g)
        setNodes((ns) =>
          ns.map((n) =>
            n.id === id && n.type === "card"
              ? {
                  ...n,
                  position: { x: g.x, y: g.y },
                  width: g.w ?? 280,
                  height: g.h ?? undefined,
                  style: { width: g.w ?? 280, height: g.h ?? undefined },
                }
              : n,
          ),
        );
      report(e, "儲存卡片大小失敗，已回復");
    }
  };
  const onResizeEnd = useCallback(
    (id: string, p: { x: number; y: number; width: number; height: number }) => void resizeImpl.current?.(id, p),
    [],
  );

  // ---- 分組框操作（縮放、改名、換色、刪除）----
  const groupResizeImpl = useRef<((gid: string, p: { x: number; y: number; width: number; height: number }) => Promise<void>) | undefined>(undefined);
  groupResizeImpl.current = async (gid, p) => {
    if (!boardId) return;
    const nodeId = `group:${gid}`;
    try {
      await api.patchBoardGroup(boardId, gid, { x: p.x, y: p.y, w: p.width, h: p.height });
      saved.current.set(nodeId, { x: p.x, y: p.y, w: p.width, h: p.height });
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? { ...n, position: { x: p.x, y: p.y }, width: p.width, height: p.height, style: { width: p.width, height: p.height, zIndex: -1 } }
            : n,
        ),
      );
    } catch (e) {
      const g = saved.current.get(nodeId);
      if (g)
        setNodes((ns) =>
          ns.map((n) =>
            n.id === nodeId
              ? { ...n, position: { x: g.x, y: g.y }, width: g.w ?? 360, height: g.h ?? 240, style: { width: g.w ?? 360, height: g.h ?? 240, zIndex: -1 } }
              : n,
          ),
        );
      report(e, "儲存分組框大小失敗，已回復");
    }
  };
  const onGroupResizeEnd = useCallback(
    (gid: string, p: { x: number; y: number; width: number; height: number }) => void groupResizeImpl.current?.(gid, p),
    [],
  );

  const renameGroupImpl = useRef<((gid: string, cur: string) => Promise<void>) | undefined>(undefined);
  renameGroupImpl.current = async (gid, cur) => {
    if (!boardId) return;
    const next = window.prompt("視覺分組名稱", cur);
    if (next === null) return;
    try {
      const updated = await api.patchBoardGroup(boardId, gid, { label: next.trim() });
      setNodes((ns) =>
        ns.map((n) => (n.id === `group:${gid}` && n.type === "boardGroup" ? { ...n, data: { ...n.data, label: updated.label } } : n)),
      );
    } catch (e) {
      report(e, "修改分組名稱失敗");
    }
  };
  const onGroupRename = useCallback((gid: string, cur: string) => void renameGroupImpl.current?.(gid, cur), []);

  const cycleGroupColorImpl = useRef<((gid: string, cur: string) => Promise<void>) | undefined>(undefined);
  cycleGroupColorImpl.current = async (gid, cur) => {
    if (!boardId) return;
    const idx = GROUP_COLORS.indexOf(cur as (typeof GROUP_COLORS)[number]);
    const nextColor = GROUP_COLORS[(idx + 1) % GROUP_COLORS.length];
    try {
      const updated = await api.patchBoardGroup(boardId, gid, { color: nextColor });
      setNodes((ns) =>
        ns.map((n) => (n.id === `group:${gid}` && n.type === "boardGroup" ? { ...n, data: { ...n.data, color: updated.color } } : n)),
      );
    } catch (e) {
      report(e, "切換分組顏色失敗");
    }
  };
  const onGroupCycleColor = useCallback((gid: string, cur: string) => void cycleGroupColorImpl.current?.(gid, cur), []);

  const removeGroupImpl = useRef<((gid: string) => Promise<void>) | undefined>(undefined);
  removeGroupImpl.current = async (gid) => {
    if (!boardId) return;
    try {
      await api.deleteBoardGroup(boardId, gid);
      const nodeId = `group:${gid}`;
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      saved.current.delete(nodeId);
    } catch (e) {
      report(e, "刪除分組框失敗");
    }
  };
  const onGroupRemove = useCallback((gid: string) => void removeGroupImpl.current?.(gid), []);

  const toNode = useCallback(
    (c: BoardCard): CardFlowNode => ({
      id: c.card_id,
      type: "card",
      position: { x: c.x, y: c.y },
      width: c.w ?? 280,
      height: c.h ?? undefined,
      style: { width: c.w ?? 280, height: c.h ?? undefined },
      data: { title: c.title, body: c.body, sized: c.h != null, onResizeEnd, onOpenCard },
    }),
    [onOpenCard, onResizeEnd],
  );

  const toGroupNode = useCallback(
    (g: BoardGroup): GroupFlowNode => ({
      id: `group:${g.id}`,
      type: "boardGroup",
      position: { x: g.x, y: g.y },
      width: g.w,
      height: g.h,
      zIndex: -1,
      style: { width: g.w, height: g.h, zIndex: -1 },
      data: {
        groupId: g.id,
        label: g.label,
        color: g.color || "slate",
        onResizeEnd: onGroupResizeEnd,
        onRename: onGroupRename,
        onCycleColor: onGroupCycleColor,
        onRemoveGroup: onGroupRemove,
      },
    }),
    [onGroupCycleColor, onGroupRemove, onGroupRename, onGroupResizeEnd],
  );

  // ---- 載入白板 ----
  useEffect(() => {
    setNodes([]);
    setLinks([]);
    setEditingLink(null);
    setUndoSnapshot(null);
    setDesignatedCenterId(null);
    setLastClickedCardId(null);
    saved.current.clear();
    viewportReady.current = false;
    if (!boardId) return;
    let alive = true;
    setLoading(true);
    api
      .getBoard(boardId)
      .then((b) => {
        if (!alive) return;
        const groups = b.groups ?? [];
        groups.forEach((g) => saved.current.set(`group:${g.id}`, { x: g.x, y: g.y, w: g.w, h: g.h }));
        b.cards.forEach((c) => saved.current.set(c.card_id, { x: c.x, y: c.y, w: c.w, h: c.h }));
        const groupNodes = groups.map((g) => toGroupNode(g));
        // 載入完成時，右側面板目前選的卡片如果在這塊白板上，也要同步成選取狀態
        const cardNodes = b.cards.map((c) => ({ ...toNode(c), selected: c.card_id === selectedRef.current }));
        setNodes([...groupNodes, ...cardNodes]);
        setLinks((b.links ?? []).map(normalizeLink));
        const vp = loadViewport(boardId);
        requestAnimationFrame(() => {
          if (!alive) return;
          if (vp && typeof rf.setViewport === "function") {
            void rf.setViewport(vp);
          } else if (b.cards.length) {
            void rf.fitView({ padding: 0.2, maxZoom: 1 });
          }
          viewportReady.current = true;
        });
      })
      .catch((e) => alive && report(e, "載入白板失敗"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  const onMoveEnd = useCallback(
    (_e: unknown, vp: SavedViewport) => {
      if (boardId && viewportReady.current) {
        saveViewport(boardId, vp);
      }
    },
    [boardId],
  );

  // 右側面板選了別張卡片，白板上同步選取（若白板目前正在多選且已包含該卡，則不洗掉多選）
  useEffect(() => {
    setNodes((ns) => {
      const selectedCards = ns.filter((n) => n.type === "card" && n.selected);
      if (selectedCards.length > 1 && selectedCardId && selectedCards.some((n) => n.id === selectedCardId)) {
        return ns;
      }
      return ns.some((n) => n.type === "card" && !!n.selected !== (n.id === selectedCardId))
        ? ns.map((n) => (n.type === "card" ? { ...n, selected: n.id === selectedCardId } : n))
        : ns;
    });
  }, [selectedCardId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyFlowNode>[]) => {
      const drags = changes.filter(
        (c): c is PositionChange => c.type === "position" && c.dragging === true && !!c.position,
      );
      let next = changes;
      let guides: MagnetGuide[] = [];
      if (drags.length > 0 && shiftRef.current) {
        // Shift：以拖曳起點為基準，位移取固定間距的整數倍
        next = changes.map((c) => {
          if (c.type !== "position" || !c.dragging || !c.position) return c;
          const start = dragStartRef.current.get(c.id);
          return start
            ? { ...c, position: { x: quantizeFromStart(start.x, c.position.x), y: quantizeFromStart(start.y, c.position.y) } }
            : c;
        });
      } else if (drags.length === 1 && snapRef.current) {
        // 單張卡片拖曳：磁吸對齊其他卡片的邊緣／中線，並吸到固定間距
        const d = drags[0];
        const moving = nodesRef.current.find((n): n is CardFlowNode => n.type === "card" && n.id === d.id);
        if (moving && d.position) {
          const others = nodesRef.current
            .filter((n): n is CardFlowNode => n.type === "card" && n.id !== d.id)
            .map(nodeBox);
          const r = computeMagnetSnap(
            { ...nodeBox(moving), x: d.position.x, y: d.position.y },
            others,
            MAGNET_THRESHOLD_PX / rf.getZoom(),
          );
          next = changes.map((c) => (c === d ? { ...c, position: { x: r.x, y: r.y } } : c));
          guides = r.guides;
        }
      }
      setMagnetGuides((cur) => (cur.length === 0 && guides.length === 0 ? cur : guides));
      setNodes((ns) => applyNodeChanges(next, ns));
    },
    [rf],
  );

  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: { id: string; type?: string }[] }) => {
      const cardSel = sel.filter((n) => !n.id.startsWith("group:"));
      if (cardSel.length === 1 && cardSel[0].id !== selectedRef.current) {
        onSelectCard(cardSel[0].id);
      }
      if (cardSel.length < 2) {
        setDesignatedCenterId(null);
        setShowSplitConfig(false);
      } else {
        setDesignatedCenterId((cur) => (cur && cardSel.some((c) => c.id === cur) ? cur : null));
      }
    },
    [onSelectCard],
  );

  // ---- 拖曳分組框時，框內卡片同步跟隨移動 ----
  const onNodeDragStart: OnNodeDrag<AnyFlowNode> = useCallback((_e, node, dragged) => {
    dragStartRef.current = new Map(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    if (node.type !== "boardGroup") {
      groupDragRef.current = null;
      return;
    }
    const g = saved.current.get(node.id);
    const gx = g?.x ?? node.position.x;
    const gy = g?.y ?? node.position.y;
    const gw = g?.w ?? node.width ?? 360;
    const gh = g?.h ?? node.height ?? 240;
    const members = nodesRef.current
      .filter((n): n is CardFlowNode => {
        if (n.type !== "card") return false;
        const box = nodeBox(n);
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
      })
      .map((n) => n.id);
    groupDragRef.current = { groupId: node.id, startX: gx, startY: gy, memberIds: members };
  }, []);

  const onNodeDrag: OnNodeDrag<AnyFlowNode> = useCallback((_e, node) => {
    const gd = groupDragRef.current;
    if (!gd || node.id !== gd.groupId || gd.memberIds.length === 0) return;
    const dx = node.position.x - gd.startX;
    const dy = node.position.y - gd.startY;
    const memberSet = new Set(gd.memberIds);
    setNodes((ns) =>
      ns.map((n) => {
        if (!memberSet.has(n.id)) return n;
        const orig = saved.current.get(n.id);
        if (!orig) return n;
        return { ...n, position: { x: orig.x + dx, y: orig.y + dy } };
      }),
    );
  }, []);

  // ---- 拖曳結束才寫入；開啟自動對齊時吸附格線並避開重疊卡片；失敗回復 ----
  const onNodeDragStop: OnNodeDrag<AnyFlowNode> = useCallback(
    async (_e, _node, dragged) => {
      if (!boardId) return;
      const gd = groupDragRef.current;
      groupDragRef.current = null;

      const groupNodes = dragged.filter((n): n is GroupFlowNode => n.type === "boardGroup");
      for (const gn of groupNodes) {
        const nextX = snapRef.current ? snapToGridValue(gn.position.x, GRID_SIZE) : gn.position.x;
        const nextY = snapRef.current ? snapToGridValue(gn.position.y, GRID_SIZE) : gn.position.y;
        const prev = saved.current.get(gn.id);
        if (prev && prev.x === nextX && prev.y === nextY) continue;
        try {
          await api.patchBoardGroup(boardId, gn.data.groupId, { x: nextX, y: nextY });
          saved.current.set(gn.id, {
            x: nextX,
            y: nextY,
            w: prev?.w ?? gn.width ?? 360,
            h: prev?.h ?? gn.height ?? 240,
          });
          if (nextX !== gn.position.x || nextY !== gn.position.y) {
            setNodes((ns) => ns.map((n) => (n.id === gn.id ? { ...n, position: { x: nextX, y: nextY } } : n)));
          }
        } catch (e) {
          if (prev) {
            setNodes((ns) => ns.map((n) => (n.id === gn.id ? { ...n, position: { x: prev.x, y: prev.y } } : n)));
          }
          report(e, "儲存分組框位置失敗，已回到原位");
        }
      }

      const movedCardIds = new Set<string>(
        dragged.filter((n) => n.type === "card").map((n) => n.id),
      );
      if (gd) gd.memberIds.forEach((id) => movedCardIds.add(id));
      if (movedCardIds.size === 0) return;

      const allCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card");
      const movingBoxes = allCards.filter((n) => movedCardIds.has(n.id)).map(nodeBox);
      const fixedBoxes = allCards.filter((n) => !movedCardIds.has(n.id)).map(nodeBox);

      const resolvedMap = snapRef.current
        ? placeCardsAvoidingCollisions(movingBoxes, fixedBoxes, GRID_SIZE)
        : new Map(movingBoxes.map((b) => [b.id, { x: b.x, y: b.y }]));

      // 更新視覺位置（若有被推開或吸附調整）
      setNodes((ns) =>
        ns.map((n) => {
          const pos = resolvedMap.get(n.id);
          return pos && (n.position.x !== pos.x || n.position.y !== pos.y)
            ? { ...n, position: { x: pos.x, y: pos.y } }
            : n;
        }),
      );

      const items = Array.from(resolvedMap.entries())
        .map(([card_id, pos]) => ({ card_id, x: pos.x, y: pos.y }))
        .filter((i) => {
          const g = saved.current.get(i.card_id);
          return !g || g.x !== i.x || g.y !== i.y;
        });

      if (!items.length) return;
      try {
        await api.patchBoardCards(boardId, items);
        items.forEach((i) => {
          const g = saved.current.get(i.card_id);
          saved.current.set(i.card_id, { x: i.x, y: i.y, w: g?.w ?? null, h: g?.h ?? null });
        });
      } catch (e) {
        const ids = new Set(items.map((i) => i.card_id));
        setNodes((ns) =>
          ns.map((n) => {
            const g = saved.current.get(n.id);
            return ids.has(n.id) && g ? { ...n, position: { x: g.x, y: g.y } } : n;
          }),
        );
        report(e, "儲存位置失敗，已回到原位");
      }
    },
    [boardId, report],
  );

  // ---- 拉線建立有向具名連結（成功後顯示線，並開啟關係設定視窗）----
  const onConnect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      if (c.source.startsWith("group:") || c.target.startsWith("group:")) return;
      try {
        const r = await api.putLink(c.source, c.target, {
          relation_type: "extend",
          status: "confirmed",
          reason: "",
        });
        const norm = normalizeLink(r);
        setLinks((ls) =>
          ls.some(
            (l) =>
              l.source_id === norm.source_id &&
              l.target_id === norm.target_id &&
              l.relation_type === norm.relation_type,
          )
            ? ls
            : [...ls, norm],
        );
        setEditingLink(norm);
        if (r.existed) info("已開啟既有連結設定");
        else onLinksChanged();
      } catch (e) {
        report(e, "建立連結失敗");
      }
    },
    [info, onLinksChanged, report],
  );

  const edges = useMemo<Edge[]>(
    () =>
      links.map((l) => {
        const color = RELATION_COLORS[l.relation_type] ?? "#2f6fed";
        const typeLabel = RELATION_LABELS[l.relation_type] ?? l.relation_type;
        const statusSuffix = l.status === "hypothesis" ? " (假說)" : "";
        return {
          id: `${l.source_id}__${l.target_id}__${l.relation_type}`,
          type: "floating",
          source: l.source_id,
          target: l.target_id,
          label: `${typeLabel}${statusSuffix}`,
          deletable: false,
          selectable: true,
          focusable: true,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color,
            width: 18,
            height: 18,
          },
          style: {
            stroke: color,
            strokeWidth: 2,
            strokeDasharray: l.status === "hypothesis" ? "6 4" : undefined,
          },
          labelStyle: {
            fill: "var(--text)",
            fontWeight: 600,
            fontSize: 11,
            cursor: "pointer",
          },
          labelBgStyle: {
            fill: "var(--panel)",
            fillOpacity: 0.92,
            stroke: color,
            strokeWidth: 1,
          },
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 6,
          data: { link: l },
        };
      }),
    [links],
  );

  // ---- Delete / Backspace：卡片只「從白板移除」（絕不刪卡片本體）；分組框則刪除分組框 ----
  const removeSelected = useCallback(async () => {
    if (!boardId) return;
    const selGroups = nodesRef.current.filter((n): n is GroupFlowNode => n.type === "boardGroup" && !!n.selected);
    const selCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card" && !!n.selected);
    if (!selGroups.length && !selCards.length) return;

    if (selGroups.length) {
      const gResults = await Promise.allSettled(
        selGroups.map((g) => api.deleteBoardGroup(boardId, g.data.groupId)),
      );
      const removedGroupNodes = new Set<string>();
      gResults.forEach((r, i) => {
        if (r.status === "fulfilled") removedGroupNodes.add(selGroups[i].id);
        else report(r.reason, "刪除分組框失敗");
      });
      if (removedGroupNodes.size) {
        setNodes((ns) => ns.filter((n) => !removedGroupNodes.has(n.id)));
        removedGroupNodes.forEach((id) => saved.current.delete(id));
      }
    }

    if (selCards.length) {
      const ids = selCards.map((n) => n.id);
      const results = await Promise.allSettled(ids.map((id) => api.removeFromBoard(boardId, id)));
      const removed = new Set<string>();
      results.forEach((r, i) => {
        if (r.status === "fulfilled") removed.add(ids[i]);
        else report(r.reason, "從白板移除失敗");
      });
      if (removed.size) {
        setNodes((ns) => ns.filter((n) => !removed.has(n.id)));
        setLinks((ls) => ls.filter((l) => !removed.has(l.source_id) && !removed.has(l.target_id)));
        removed.forEach((id) => saved.current.delete(id));
        onCountChanged();
      }
    }
  }, [boardId, onCountChanged, report]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isRemoveKey(e) || isEditableTarget(e.target)) return;
      if (!nodesRef.current.some((n) => n.selected)) return;
      e.preventDefault();
      void removeSelected();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, removeSelected]);

  // ---- 自動排版與單次復原 ----
  const selectedCards = useMemo(
    () => nodes.filter((n): n is CardFlowNode => n.type === "card" && !!n.selected),
    [nodes],
  );

  const runAutoLayout = useCallback(
    async (overrideOpts?: {
      mode?: LayoutMode;
      gap?: number;
      clusterThreshold?: number;
      centerCardId?: string | null;
      splitMode?: SplitMode;
      typeSideMap?: Record<RelationType, "left" | "right">;
    }) => {
      if (!boardId) return;
      const sel = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card" && !!n.selected);
      if (sel.length < 2) return;

      const prevSnapshot = sel.map((n) => {
        const g = saved.current.get(n.id);
        return { card_id: n.id, x: g?.x ?? n.position.x, y: g?.y ?? n.position.y };
      });

      const effectiveCenterId =
        overrideOpts && "centerCardId" in overrideOpts ? overrideOpts.centerCardId : designatedCenterId;

      const boxes = sel.map(nodeBox);
      const posMap = autoLayoutCards(boxes, links, {
        mode: overrideOpts?.mode ?? layoutMode,
        gap: overrideOpts?.gap ?? layoutGap,
        clusterThreshold: overrideOpts?.clusterThreshold ?? clusterThreshold,
        centerCardId: effectiveCenterId,
        splitMode: overrideOpts?.splitMode ?? splitMode,
        typeSideMap: overrideOpts?.typeSideMap ?? typeSideMap,
        snapToGrid: snapRef.current,
        gridSize: GRID_SIZE,
      });

      const patchItems = Array.from(posMap.entries()).map(([card_id, pos]) => ({
        card_id,
        x: pos.x,
        y: pos.y,
      }));

      if (patchItems.length === 0) return;

      // 先更新畫面預覽，若寫入失敗則立刻退回原座標
      setNodes((ns) =>
        ns.map((n) => {
          const next = posMap.get(n.id);
          return next && n.type === "card" ? { ...n, position: { x: next.x, y: next.y } } : n;
        }),
      );

      try {
        await api.patchBoardCards(boardId, patchItems);
        patchItems.forEach((item) => {
          const g = saved.current.get(item.card_id);
          saved.current.set(item.card_id, { x: item.x, y: item.y, w: g?.w ?? null, h: g?.h ?? null });
        });
        setUndoSnapshot(prevSnapshot);
      } catch (e) {
        const snapMap = new Map(prevSnapshot.map((p) => [p.card_id, p]));
        setNodes((ns) =>
          ns.map((n) => {
            const orig = snapMap.get(n.id);
            return orig && n.type === "card" ? { ...n, position: { x: orig.x, y: orig.y } } : n;
          }),
        );
        report(e, "自動排版儲存失敗，已回到原位");
      }
    },
    [boardId, clusterThreshold, designatedCenterId, layoutGap, layoutMode, links, report, splitMode, typeSideMap],
  );

  const undoAutoLayout = useCallback(async () => {
    if (!boardId || !undoSnapshot || undoSnapshot.length === 0) return;
    const toRestore = undoSnapshot;
    const snapMap = new Map(toRestore.map((p) => [p.card_id, p]));
    setNodes((ns) =>
      ns.map((n) => {
        const orig = snapMap.get(n.id);
        return orig && n.type === "card" ? { ...n, position: { x: orig.x, y: orig.y } } : n;
      }),
    );
    try {
      await api.patchBoardCards(boardId, toRestore);
      toRestore.forEach((item) => {
        const g = saved.current.get(item.card_id);
        saved.current.set(item.card_id, { x: item.x, y: item.y, w: g?.w ?? null, h: g?.h ?? null });
      });
      setUndoSnapshot(null);
    } catch (e) {
      report(e, "復原排版失敗");
    }
  }, [boardId, report, undoSnapshot]);

  // ---- 拖曳「🎯 中心圖標」到目標卡片放開以指定中心 ----
  const startCenterIconDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setPickingCenterDrag(true);

      const onUp = (ev: MouseEvent) => {
        window.removeEventListener("mouseup", onUp);
        setPickingCenterDrag(false);
        const flowPos = rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY });
        const sel = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card" && !!n.selected);
        const hit = sel.find((n) => {
          const b = nodeBox(n);
          return flowPos.x >= b.x && flowPos.x <= b.x + b.w && flowPos.y >= b.y && flowPos.y <= b.y + b.h;
        });
        if (hit) {
          setDesignatedCenterId(hit.id);
          info(`已指定「${hit.data.title || "（無標題）"}」為排列中心`);
          if (layoutMode !== "grid") {
            void runAutoLayout({ centerCardId: hit.id });
          }
        }
      };

      window.addEventListener("mouseup", onUp);
    },
    [info, layoutMode, rf, runAutoLayout],
  );

  // ---- 提供給 App 的操作 ----
  useImperativeHandle(
    innerRef,
    () => ({
      async addCard(cardId) {
        if (!boardId) {
          report(new Error("請先在左側建立或選擇一塊白板"));
          return;
        }
        if (nodesRef.current.some((n) => n.id === cardId)) {
          info("這張卡片已經在這塊白板上");
          onSelectCard(cardId);
          return;
        }
        try {
          const card = await api.getCard(cardId);
          const b = wrapRef.current?.getBoundingClientRect();
          const center = b
            ? rf.screenToFlowPosition({ x: b.left + b.width / 2, y: b.top + b.height / 2 })
            : { x: 0, y: 0 };
          const existingCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card");
          const off = (existingCards.length % 6) * 24;
          let initX = center.x - 140 + off;
          let initY = center.y - 60 + off;

          // 新加到白板的卡片也走自動對齊與防重疊推開規則，不會疊在別張上
          if (snapRef.current) {
            const placed = placeCardsAvoidingCollisions(
              [{ id: cardId, x: initX, y: initY, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H }],
              existingCards.map(nodeBox),
              GRID_SIZE,
            );
            const pos = placed.get(cardId);
            if (pos) {
              initX = pos.x;
              initY = pos.y;
            }
          }

          const added = await api.addToBoard(boardId, cardId, initX, initY);
          saved.current.set(cardId, { x: added.x, y: added.y, w: added.w, h: added.h });
          const node = toNode({ ...added, title: card.title, body: card.body, updated_at: card.updated_at });
          setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
          setLinks((ls) => {
            const onBoard = new Set(nodesRef.current.filter((n) => n.type === "card").map((n) => n.id));
            const extra = card.links
              .filter((l) => onBoard.has(l.id))
              .map((l) =>
                normalizeLink({
                  source_id: l.source_id ?? (l.direction === "incoming" ? l.id : cardId),
                  target_id: l.target_id ?? (l.direction === "incoming" ? cardId : l.id),
                  relation_type: l.relation_type ?? "extend",
                  status: l.status ?? "confirmed",
                  reason: l.reason ?? "",
                }),
              );
            return [
              ...ls,
              ...extra.filter(
                (p) =>
                  !ls.some(
                    (l) =>
                      l.source_id === p.source_id &&
                      l.target_id === p.target_id &&
                      l.relation_type === p.relation_type,
                  ),
              ),
            ];
          });
          onSelectCard(cardId);
          onCountChanged();
        } catch (e) {
          report(e, "加到白板失敗");
        }
      },
      updateCard(card) {
        setNodes((ns) =>
          ns.map((n) =>
            n.id === card.id && n.type === "card"
              ? { ...n, data: { ...n.data, title: card.title, body: card.body } }
              : n,
          ),
        );
      },
      removeCard(cardId) {
        setNodes((ns) => ns.filter((n) => n.id !== cardId));
        setLinks((ls) => ls.filter((l) => l.source_id !== cardId && l.target_id !== cardId));
        saved.current.delete(cardId);
      },
      removeLink(sourceId, targetId, relationType) {
        setLinks((ls) =>
          ls.filter((l) => {
            if (relationType) {
              return !(l.source_id === sourceId && l.target_id === targetId && l.relation_type === relationType);
            }
            return !(
              (l.source_id === sourceId && l.target_id === targetId) ||
              (l.source_id === targetId && l.target_id === sourceId)
            );
          }),
        );
      },
      addLink(sourceId, targetId, extra) {
        const onBoard = new Set(nodesRef.current.filter((n) => n.type === "card").map((n) => n.id));
        if (!onBoard.has(sourceId) || !onBoard.has(targetId)) return;
        const norm = normalizeLink({ source_id: sourceId, target_id: targetId, ...extra });
        setLinks((ls) => {
          const filtered = ls.filter(
            (l) =>
              !(
                l.source_id === norm.source_id &&
                l.target_id === norm.target_id &&
                l.relation_type === norm.relation_type
              ),
          );
          return [...filtered, norm];
        });
      },
      async createGroup() {
        if (!boardId) {
          report(new Error("請先在左側建立或選擇一塊白板"));
          return;
        }
        const selCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card" && !!n.selected);
        let x = 0;
        let y = 0;
        let w = 420;
        let h = 280;
        if (selCards.length > 0) {
          const minX = Math.min(...selCards.map((c) => c.position.x));
          const minY = Math.min(...selCards.map((c) => c.position.y));
          const maxX = Math.max(...selCards.map((c) => c.position.x + (c.width ?? 280)));
          const maxY = Math.max(...selCards.map((c) => c.position.y + (c.height ?? 160)));
          x = minX - 24;
          y = minY - 44;
          w = Math.max(260, maxX - minX + 48);
          h = Math.max(180, maxY - minY + 68);
        } else {
          const b = wrapRef.current?.getBoundingClientRect();
          const center = b
            ? rf.screenToFlowPosition({ x: b.left + b.width / 2, y: b.top + b.height / 2 })
            : { x: 200, y: 150 };
          x = Math.round(center.x - w / 2);
          y = Math.round(center.y - h / 2);
        }
        const label = window.prompt("輸入視覺分組框名稱（表達相關但未定義明確關係的群組）", "相關觀察群組");
        if (label === null) return;
        try {
          const g = await api.createBoardGroup(boardId, { label: label.trim() || "視覺分組", x, y, w, h, color: "slate" });
          saved.current.set(`group:${g.id}`, { x: g.x, y: g.y, w: g.w, h: g.h });
          const gNode = toGroupNode(g);
          setNodes((ns) => [gNode, ...ns]);
        } catch (e) {
          report(e, "建立分組框失敗");
        }
      },
    }),
    [boardId, info, onCountChanged, onSelectCard, report, rf, toGroupNode, toNode],
  );

  const cardCount = nodes.filter((n) => n.type === "card").length;
  const designatedCenterNode = designatedCenterId
    ? selectedCards.find((n) => n.id === designatedCenterId)
    : undefined;
  const lastClickedInSelection =
    lastClickedCardId && selectedCards.some((n) => n.id === lastClickedCardId)
      ? selectedCards.find((n) => n.id === lastClickedCardId)
      : undefined;

  return (
    <div className={`board${pickingCenterDrag ? " picking-center" : ""}`} ref={wrapRef}>
      {boardId && (
        <div className="board-snap-bar">
          <label className="snap-toggle" title="勾選時：拖曳卡片靠近其他卡片會磁吸對齊（顯示提示線）並吸到固定間距 20px；按住 Shift 拖曳則以 20px 為單位移動；放開時若重疊則自動移到最近空位">
            <input
              type="checkbox"
              checked={snapToGrid}
              onChange={(e) => toggleSnapToGrid(e.target.checked)}
            />
            自動對齊
          </label>
        </div>
      )}

      {boardId && (selectedCards.length >= 2 || undoSnapshot) && (
        <div className="board-multi-toolbar" role="toolbar" aria-label="多選批次與自動排列工具列">
          <span className="multi-count">已選 {selectedCards.length} 張</span>

          {selectedCards.length >= 2 && (
            <>
              <div className="layout-mode-group" role="group" aria-label="排列方式">
                <button
                  className={layoutMode === "grid" ? "on" : ""}
                  onClick={() => {
                    setLayoutMode("grid");
                    void runAutoLayout({ mode: "grid" });
                  }}
                  title="網格排列（保留閱讀順序）"
                >
                  網格
                </button>
                <button
                  className={layoutMode === "radial" ? "on" : ""}
                  onClick={() => {
                    setLayoutMode("radial");
                    void runAutoLayout({ mode: "radial" });
                  }}
                  title="放射狀排列（連線最多的在中心，依層級向外環繞）"
                >
                  放射
                </button>
                <button
                  className={layoutMode === "right" ? "on" : ""}
                  onClick={() => {
                    setLayoutMode("right");
                    void runAutoLayout({ mode: "right" });
                  }}
                  title="向右展開（中心在左，子節點全部放右邊逐欄展開）"
                >
                  向右展開
                </button>
                <button
                  className={layoutMode === "split" ? "on" : ""}
                  onClick={() => {
                    setLayoutMode("split");
                    void runAutoLayout({ mode: "split" });
                  }}
                  title="左右分邊（依方向或關係類型分置左右兩側）"
                >
                  左右分邊
                </button>
              </div>

              <label className="toolbar-ctrl" title="調整卡片邊到邊的固定間距">
                <span>間距 {layoutGap}px</span>
                <input
                  type="range"
                  min={20}
                  max={140}
                  step={10}
                  value={layoutGap}
                  onChange={(e) => {
                    const nextGap = Number(e.target.value);
                    setLayoutGap(nextGap);
                  }}
                  onMouseUp={() => void runAutoLayout({ gap: layoutGap })}
                  onKeyUp={() => void runAutoLayout({ gap: layoutGap })}
                  aria-label="排版間距"
                />
              </label>

              {layoutMode !== "grid" && (
                <>
                  <label
                    className="toolbar-ctrl"
                    title="當子卡片在圈選範圍內的連線數達到 X 張時，自成一個獨立群落（保留連接線）"
                  >
                    <span>獨立群落連線數 X：</span>
                    <input
                      type="number"
                      min={2}
                      max={20}
                      value={clusterThreshold}
                      onChange={(e) => {
                        const val = Math.max(2, Math.min(20, Number(e.target.value) || 2));
                        setClusterThreshold(val);
                      }}
                      style={{ width: 52 }}
                      aria-label="獨立群落連線數閾值"
                    />
                  </label>

                  <div className="center-picker-group">
                    <span
                      className={`center-drag-pill${pickingCenterDrag ? " dragging" : ""}`}
                      onMouseDown={startCenterIconDrag}
                      title="按住此圖標並拖曳到任一張已選卡片上放開，即可指定該卡片為中心"
                      role="button"
                      tabIndex={0}
                      aria-label="拖曳指定中心卡片"
                    >
                      🎯 {designatedCenterNode ? `中心：${designatedCenterNode.data.title || "（無標題）"}` : "拖曳指定中心"}
                    </span>
                    {!designatedCenterNode && lastClickedInSelection && (
                      <button
                        onClick={() => {
                          setDesignatedCenterId(lastClickedInSelection.id);
                          void runAutoLayout({ centerCardId: lastClickedInSelection.id });
                        }}
                        title={`以最後點選的「${lastClickedInSelection.data.title || "（無標題）"}」作為中心排列`}
                      >
                        以「{(lastClickedInSelection.data.title || "無標題").slice(0, 8)}」為中心
                      </button>
                    )}
                    {designatedCenterNode && (
                      <button
                        onClick={() => {
                          setDesignatedCenterId(null);
                          void runAutoLayout({ centerCardId: null });
                        }}
                        title="改回自動以連線數最多的卡片為中心"
                        aria-label="清除指定中心"
                      >
                        ✕ 自動中心
                      </button>
                    )}
                  </div>
                </>
              )}

              {layoutMode === "split" && (
                <div className="split-config-wrap">
                  <select
                    value={splitMode}
                    onChange={(e) => {
                      const next = e.target.value as SplitMode;
                      setSplitMode(next);
                      void runAutoLayout({ splitMode: next });
                    }}
                    aria-label="左右分邊依據"
                    title="選擇左右分邊的判斷依據"
                  >
                    <option value="type">依關係類型分邊</option>
                    <option value="direction">依方向（指向中心放左／指出放右）</option>
                  </select>
                  {splitMode === "type" && (
                    <button
                      onClick={() => setShowSplitConfig((v) => !v)}
                      className={showSplitConfig ? "on" : ""}
                      title="設定各關係類型要放左邊或右邊（預設：反駁放左、其餘放右）"
                    >
                      ⚙ 左右設定
                    </button>
                  )}
                  {splitMode === "type" && showSplitConfig && (
                    <div className="split-config-popover" role="dialog" aria-label="關係類型左右分邊設定">
                      <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                        指定各關係類型置於中心左側或右側：
                      </div>
                      {(Object.entries(RELATION_LABELS) as [RelationType, string][]).map(([rel, label]) => (
                        <div key={rel} className="split-config-row">
                          <span>{label}</span>
                          <div className="layout-mode-group">
                            <button
                              className={typeSideMap[rel] === "left" ? "on" : ""}
                              onClick={() => {
                                const nextMap = { ...typeSideMap, [rel]: "left" as const };
                                setTypeSideMap(nextMap);
                                void runAutoLayout({ typeSideMap: nextMap });
                              }}
                            >
                              放左
                            </button>
                            <button
                              className={typeSideMap[rel] === "right" ? "on" : ""}
                              onClick={() => {
                                const nextMap = { ...typeSideMap, [rel]: "right" as const };
                                setTypeSideMap(nextMap);
                                void runAutoLayout({ typeSideMap: nextMap });
                              }}
                            >
                              放右
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <button className="primary" onClick={() => void runAutoLayout()}>
                自動排版
              </button>
            </>
          )}

          {undoSnapshot && (
            <button onClick={() => void undoAutoLayout()} title="還原上一次自動排版前的位置">
              ↶ 復原排版
            </button>
          )}
        </div>
      )}
  
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(e, node) => {
          if (node.type === "card") {
            setLastClickedCardId(node.id);
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
              onOpenCard?.(node.id);
            }
          }
        }}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(_e, node) => {
          if (node.type === "card") onOpenCard?.(node.id);
        }}
        onEdgeClick={(_e, edge) => {
          const l = (edge.data as { link?: BoardLink } | undefined)?.link;
          if (l) setEditingLink(l);
        }}
        onConnect={onConnect}
        onSelectionChange={onSelectionChange}
        onMoveEnd={onMoveEnd}
        onPaneContextMenu={(e) => e.preventDefault()}
        isValidConnection={(c) => c.source !== c.target && !c.source?.startsWith("group:") && !c.target?.startsWith("group:")}
        connectionMode={ConnectionMode.Loose}
        selectionOnDrag={false}
        selectionMode={SelectionMode.Partial}
        selectionKeyCode="Space"
        multiSelectionKeyCode={["Shift", "Control", "Meta"]}
        panOnDrag={[0, 1]}
        panActivationKeyCode={null}
        snapToGrid={false} // 拖曳吸附改由 onNodesChange 的磁吸邏輯負責，不與格線吸附並用
        deleteKeyCode={null} // 停用內建刪除鍵，改由上面的處理（只從白板移除）
        minZoom={0.2}
        maxZoom={2}
      >
        <Background gap={GRID_SIZE} />
        <Controls />
        <ViewportPortal>
          {magnetGuides.map((g, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: Math.min(g.x1, g.x2),
                top: Math.min(g.y1, g.y2),
                width: Math.abs(g.x2 - g.x1) || 2,
                height: Math.abs(g.y2 - g.y1) || 2,
                background: "#f43f5e",
                pointerEvents: "none",
                zIndex: 1000,
              }}
            />
          ))}
        </ViewportPortal>
      </ReactFlow>
      {!boardId && <div className="board-hint">請先在左側建立或選擇一塊白板</div>}
      {boardId && !loading && cardCount === 0 && (
        <div className="board-hint">這塊白板還沒有卡片。按右上角的「新增卡片」圖標，或從「搜尋」把卡片加進來。</div>
      )}
      {editingLink && (
        <LinkEditorModal
          link={editingLink}
          nodes={nodes}
          onClose={() => setEditingLink(null)}
          onUpdated={(oldRel, updated) => {
            setLinks((ls) =>
              ls.map((l) =>
                l.source_id === updated.source_id &&
                l.target_id === updated.target_id &&
                l.relation_type === oldRel
                  ? normalizeLink(updated)
                  : l,
              ),
            );
            setEditingLink(null);
            onLinksChanged();
          }}
          onDeleted={(linkToDel) => {
            setLinks((ls) =>
              ls.filter(
                (l) =>
                  !(
                    l.source_id === linkToDel.source_id &&
                    l.target_id === linkToDel.target_id &&
                    l.relation_type === linkToDel.relation_type
                  ),
              ),
            );
            setEditingLink(null);
            onLinksChanged();
          }}
          report={report}
        />
      )}
    </div>
  );
}

function LinkEditorModal(props: {
  link: BoardLink;
  nodes: AnyFlowNode[];
  onClose(): void;
  onUpdated(oldRel: RelationType, updated: BoardLink): void;
  onDeleted(link: BoardLink): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { link, nodes, onClose, onUpdated, onDeleted, report } = props;
  const [relationType, setRelationType] = useState<RelationType>(link.relation_type);
  const [status, setStatus] = useState<LinkStatus>(link.status);
  const [reason, setReason] = useState<string>(link.reason ?? "");

  const titleOf = (id: string) => {
    const n = nodes.find((x): x is CardFlowNode => x.type === "card" && x.id === id);
    return n?.data.title || "（無標題）";
  };

  const save = async () => {
    try {
      const updated = await api.patchLink(link.source_id, link.target_id, {
        old_relation_type: link.relation_type,
        relation_type: relationType,
        status,
        reason,
      });
      onUpdated(link.relation_type, updated);
    } catch (e) {
      report(e, "更新連結關係失敗");
    }
  };

  const remove = async () => {
    try {
      await api.deleteLink(link.source_id, link.target_id, link.relation_type);
      onDeleted(link);
    } catch (e) {
      report(e, "刪除連結失敗");
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="設定卡片語意關係">
      <div className="modal-card" style={{ minWidth: 380 }}>
        <h4>設定語意關係</h4>
        <div className="link-direction-preview">
          <strong>{titleOf(link.source_id)}</strong>
          <span className="muted"> ──({RELATION_LABELS[relationType]})──▶ </span>
          <strong>{titleOf(link.target_id)}</strong>
        </div>
        <label className="field-row">
          <span className="muted">關係類型（A 對 B 的語意關係）：</span>
          <select value={relationType} onChange={(e) => setRelationType(e.target.value as RelationType)}>
            {(Object.entries(RELATION_LABELS) as [RelationType, string][]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span className="muted">可信度狀態（實線＝已確認，虛線＝待驗證假說）：</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as LinkStatus)}>
            {(Object.entries(LINK_STATUS_LABELS) as [LinkStatus, string][]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-row">
          <span className="muted">連接理由（一句話說明為什麼這兩張卡片有此關係）：</span>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="例如：橫膈膜離心控制不足時，斜角肌與上斜方肌會代償參與吸氣"
            autoFocus
          />
        </label>
        <div className="modal-actions" style={{ justifyContent: "space-between" }}>
          <button className="danger" style={{ marginTop: 0 }} onClick={() => void remove()}>
            刪除此連結
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={onClose}>取消</button>
            <button className="primary" onClick={() => void save()}>
              儲存關係
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export const Board = forwardRef<BoardHandle, Props>((props, ref) => (
  <ReactFlowProvider>
    <BoardInner {...props} innerRef={ref} />
  </ReactFlowProvider>
));
Board.displayName = "Board";
