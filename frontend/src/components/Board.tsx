// @depends-on ../lib/layout.ts (autoLayoutCards, placeCardsAvoidingCollisions, snapDimension, snapToGridValue, GRID_SIZE)
// @depends-on ../lib/groupFit.ts (fitGroups, groupAtCenter, MovedGroup, GROUP_PAD, GROUP_PAD_TOP：卡片歸屬一律用 groupAtCenter（中心點所在、面積最小的框，一張卡片只屬於一個框），拖曳帶動成員、貼合、亮框、放開歸屬四處必須一致)
// @depends-on ../styles.css (.react-flow__node-boardGroup.drop-target：拖曳卡片時「放開後會歸入」的亮框樣式，class 由 setDropTargets 掛在節點上)
// @depends-on ../App.tsx (toolsSlot：右上工具列的 .tools-slide 容器，null 時不渲染「定位／自動對齊」)
// @depends-on ../styles.css (.tools-slide button / .on：這兩顆按鈕的外觀由容器樣式決定，此處不寫 inline style)
// @depends-on ../App.tsx (selectedCardId 有兩條寫入路徑：onNodeClick→onOpenCard，與 onSelectionChange→onSelectCard；Board 以 nodes 的 selected 為準去重；onOpenCard 支援 options.smartPasteText)
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
import { createPortal } from "react-dom";
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
import { fitGroups, groupAtCenter, GROUP_PAD, GROUP_PAD_TOP, type GroupRect, type MovedGroup } from "../lib/groupFit";
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
import { isSymmetricRelation } from "../lib/relations";
import { CardNode, type CardFlowNode } from "./CardNode";
import { FloatingEdge } from "./FloatingEdge";
import { notifyCardTitleUpdated } from "./Markdown";

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

const CODE_EXT_MAP: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  sql: "sql",
  css: "css",
  html: "html",
  md: "markdown",
  sh: "bash",
  bash: "bash",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  rust: "rust",
  rs: "rust",
  go: "go",
};

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

function CrosshairIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="8" cy="8" r="3.5" />
      <line x1="8" y1="1.5" x2="8" y2="4" />
      <line x1="8" y1="12" x2="8" y2="14.5" />
      <line x1="1.5" y1="8" x2="4" y2="8" />
      <line x1="12" y1="8" x2="14.5" y2="8" />
    </svg>
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
  toolsSlot?: HTMLElement | null;
  onSelectCard(id: string | null): void;
  onOpenCard?(id: string, options?: { smartPasteText?: string }): void;
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
    relation_type: l.relation_type ?? "延伸",
    status: l.status ?? "confirmed",
    reason: l.reason ?? "",
  };
}

// 複製用：移除圖片／影片引用，代碼塊內的內容原樣保留
function stripImagesKeepCode(body: string): string {
  const FENCE = "`".repeat(3);
  const out: string[] = [];
  let fenceLen = 0;
  let prevBlank = false;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (fenceLen > 0) {
      out.push(line);
      if (t.length >= fenceLen && t.replace(/`/g, "") === "") fenceLen = 0;
      prevBlank = false;
      continue;
    }
    if (t.startsWith(FENCE)) {
      let n = 0;
      while (t[n] === "`") n++;
      fenceLen = n;
      out.push(line);
      prevBlank = false;
      continue;
    }
    const stripped = line.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
    if (stripped !== line && stripped.trim() === "") continue; // 整行只有圖片：整行丟掉
    const blank = stripped.trim() === "";
    if (blank && prevBlank) continue; // 避免移除圖片後留下連續空行
    prevBlank = blank;
    out.push(stripped);
  }
  return out.join("\n").trim();
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
  const [gridCols, setGridCols] = useState<number | null>(null);
  const [gridRows, setGridRows] = useState<number | null>(null);
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

  // 貼上內容並定位卡片狀態
  const [showLocateModal, setShowLocateModal] = useState(false);
  const [locateText, setLocateText] = useState("");

      const handleLocateCard = () => {
        const raw = locateText.trim();
        if (!raw) {
          report(new Error("請先貼上代碼段落或 AI 回覆內容"), "定位失敗");
          return;
        }
        const allCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card");
        if (allCards.length === 0) {
          report(new Error("目前白板內尚無任何卡片可供定位"), "定位失敗");
          return;
        }

        const normRaw = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const rawLines = normRaw
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l.length >= 6 && !/^[{}\]();,]+$/.test(l));

        // 1. 抽取可能的檔名/標題候選
        const titleRegex = /(?:```[a-zA-Z0-9_-]*:|^#+\s+|^[a-zA-Z0-9_./-]+\/)?([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/gm;
        const extractedNames = new Set<string>();
        let match: RegExpExecArray | null;
        while ((match = titleRegex.exec(raw)) !== null) {
          const fn = match[1].split("/").pop();
          if (fn) extractedNames.add(fn.trim().toLowerCase());
        }

        // 2. 抽取【尋找這段代碼】標記區塊（若有）
        const findMarker = "【尋找這段代碼】";
        const replaceMarker = "【替換為以下代碼】";
        const FENCE = "`".repeat(3);
        const langHeaderRe =
          /^(typescript|javascript|ts|tsx|js|jsx|python|py|sql|sqlite|json|html|css|scss|bash|sh|shell|yaml|yml|toml|markdown|md|diff|plaintext|text|c|cpp|csharp|java|go|rust|ruby|php|swift|kotlin)(\s+(copy(\s+code)?|複製(\s*代碼|\s*程式碼)?))?$/i;
        const fileInLineRe = /([a-zA-Z0-9_.-]+\.(?:tsx|ts|jsx|js|py|sql|css|html|json|md|yaml|yml|toml|rs|go))/i;
        const primaryNames = new Set<string>();
        const findSnippets: string[][] = [];
        const lines = normRaw.replace(/\u00A0/g, " ").split("\n");
        for (let i = 0; i < lines.length; i++) {
          const lineTrim = lines[i].trim();
          if (lineTrim.includes(findMarker) && !/^(const|let|var)\s+/.test(lineTrim)) {
            for (let k = i - 1; k >= Math.max(0, i - 12); k--) {
              if (lines[k].includes(replaceMarker)) break;
              const m = fileInLineRe.exec(lines[k]);
              if (m) {
                primaryNames.add(m[1].toLowerCase());
                break;
              }
            }
            const nextLines: string[] = [];
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j].includes(replaceMarker) || lines[j].includes(findMarker)) break;
              const t = lines[j].trim();
              if (!t || t.startsWith(FENCE)) continue;
              if (nextLines.length === 0 && langHeaderRe.test(t)) continue;
              nextLines.push(t);
            }
            if (nextLines.length > 0) {
              findSnippets.push(nextLines);
            }
          }
        }
        const matchesFullSnippet = (src: string, snipLines: string[]): boolean => {
          const normSrcLines = src.replace(/\u00A0/g, " ").split("\n");
          const nonEmptySrc = normSrcLines.map((l) => l.trim()).filter((l) => l.length > 0);
          if (snipLines.length === 0 || snipLines.length > nonEmptySrc.length) return false;
          for (let i = 0; i <= nonEmptySrc.length - snipLines.length; i++) {
            let ok = true;
            for (let j = 0; j < snipLines.length; j++) {
              if (nonEmptySrc[i + j] !== snipLines[j]) {
                ok = false;
                break;
              }
            }
            if (ok) return true;
          }
          return false;
        };

        // 3. 多層級計分比對白板所有卡片
        let bestCard: CardFlowNode | null = null;
        let maxScore = 0;

        for (const card of allCards) {
          let score = 0;
          const title = (card.data.title || "").trim();
          const titleLower = title.toLowerCase();
          const body = (card.data.body || "").replace(/\r\n/g, "\n");

          // 層級 A: 卡片內文全文直接精確包含貼上的內容（最高權重）
          if (body.includes(normRaw)) {
            score += 1000;
          }

          // 層級 B: 代碼實質特徵行命中統計（支援純代碼段落檢索）
          if (rawLines.length > 0) {
            let hitCount = 0;
            let continuousHit = 0;
            let maxContinuous = 0;
            for (const line of rawLines) {
              if (body.includes(line)) {
                hitCount++;
                continuousHit++;
                if (continuousHit > maxContinuous) maxContinuous = continuousHit;
              } else {
                continuousHit = 0;
              }
            }
            const hitRate = hitCount / rawLines.length;
            if (hitRate >= 0.4) {
              score += Math.round(hitRate * 400);
              score += maxContinuous * 25;
            }
          }

          // 層級 C: 標題或檔名吻合
          if (title && extractedNames.has(titleLower)) {
            score += 250;
          }
          if (title && normRaw.includes(title)) {
            score += 100;
          }

          // 層級 D: 命中【尋找這段代碼】區塊
          if (findSnippets.length > 0) {
            let matchedSnippets = 0;
            for (const snip of findSnippets) {
              if (matchesFullSnippet(body, snip)) {
                matchedSnippets++;
              }
            }
            if (matchedSnippets === 0) {
              score = 0;
            } else {
              score += matchedSnippets * 2000;
              if (title && primaryNames.has(titleLower)) {
                score += 500;
              }
            }
          }

          if (score > maxScore) {
            maxScore = score;
            bestCard = card;
          }
        }

        if (!bestCard || maxScore < 30) {
          report(
            new Error(
              findSnippets.length > 0
                ? "當前白板內沒有任何卡片完整包含所貼上的定位代碼段落，請確認目標卡片是否已放入此白板"
                : "在當前白板的卡片中找不到吻合的內容或代碼，請確認貼上的段落是否屬於此白板內的卡片",
            ),
            "找不到目標卡片",
          );
          return;
        }

        setShowLocateModal(false);
        setLocateText("");
        info(`已成功定位至卡片「${bestCard.data.title || "（無標題）"}」`);
        onOpenCard?.(bestCard.id, { smartPasteText: raw });
      };

  // 拖入同名檔案衝突佇列與對話框狀態
  interface DropConflictItem {
    file: File;
    content: string;
    lang: string;
    dropX: number;
    dropY: number;
    matchedCard: CardFlowNode;
    scopeLabel: string;
  }
  const [conflictQueue, setConflictQueue] = useState<DropConflictItem[]>([]);

  const saved = useRef(new Map<string, Geometry>()); // 伺服器上確認過的位置，失敗時回復用
  const groupDragRef = useRef<{ groupId: string; startX: number; startY: number; memberIds: string[] } | null>(null);
  const activeDragRef = useRef<{ id: string; type: string } | null>(null);
  const lastSnappedPosRef = useRef(new Map<string, { x: number; y: number }>());
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
  // 上一次已同步進 nodes 的 selectedCardId。App 已改選取、[selectedCardId] effect 尚未寫進 nodes 的空窗內，
  // React Flow 回報的選取是過期的，不能寫回 App（否則會把剛指定的卡片蓋回舊選取）
  const syncedSelectedRef = useRef(selectedCardId);

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

  // ---- 雙擊縮放把手：四角回預設大小（預設寬＋h=NULL 即自動高度）；底邊在「全文高度」與「自動高度」間切換 ----
  // 原因：雙擊由 CardNode 依 .react-flow__resize-control 的 handle／bottom 類別分流；這裡只負責判斷狀態與寫入。
  // assumption: api.patchBoardCards 接受 h: null 並把資料庫的 h 設為 NULL（api.ts／後端未提供，無法確認）
  // if broken: 型別錯誤（大聲），或重新載入後尺寸回到舊值（靜默，見驗證 J-1）
  const cardSizeImpl = useRef<((id: string, h: number | null, w?: number) => Promise<void>) | undefined>(undefined);
  cardSizeImpl.current = async (id, h, w) => {
    if (!boardId) return;
    const n = nodesRef.current.find((x): x is CardFlowNode => x.type === "card" && x.id === id);
    if (!n) return;
    const prev = saved.current.get(id);
    const x = prev?.x ?? n.position.x;
    const y = prev?.y ?? n.position.y;
    const nextW = w ?? prev?.w ?? n.width ?? DEFAULT_CARD_W;
    try {
      await api.patchBoardCards(boardId, [{ card_id: id, x, y, w: nextW, h }]);
      saved.current.set(id, { x, y, w: nextW, h });
      setNodes((ns) =>
        ns.map((m) =>
          m.id === id && m.type === "card"
            ? {
                ...m,
                width: nextW,
                height: h ?? undefined,
                style: { width: nextW, height: h ?? undefined },
                data: { ...m.data, sized: h != null },
              }
            : m,
        ),
      );
    } catch (e) {
      report(e, "儲存卡片大小失敗");
    }
  };
  const onResetCardSize = useCallback((id: string) => void cardSizeImpl.current?.(id, null, DEFAULT_CARD_W), []);
  const onFitCardHeight = useCallback((id: string, fullH: number) => {
    const n = nodesRef.current.find((x): x is CardFlowNode => x.type === "card" && x.id === id);
    if (!n) return;
    // 開啟自動對齊時向上取整到格距，才不會因取整切到內文最後幾 px
    const target = snapRef.current ? Math.ceil(fullH / GRID_SIZE) * GRID_SIZE : Math.ceil(fullH);
    const cur = n.measured?.height ?? n.height ?? 0;
    void cardSizeImpl.current?.(id, Math.abs(cur - target) <= 1 ? null : target);
  }, []);

  // ---- 分組框操作（縮放、改名、換色、刪除）----
  const groupResizeImpl = useRef<((gid: string, p: { x: number; y: number; width: number; height: number }) => Promise<void>) | undefined>(undefined);
  groupResizeImpl.current = async (gid, p) => {
    if (!boardId) return;
    const nodeId = `group:${gid}`;
    const prev = saved.current.get(nodeId);
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
      if (prev) {
        // 縮放後撞到別的框就整組推開；owned＝縮放前屬於這個框的卡片
        const oldRect = { x: prev.x, y: prev.y, w: prev.w ?? p.width, h: prev.h ?? p.height };
        const groupsBefore = savedGroupRects().map((g) => (g.id === nodeId ? { ...g, ...oldRect } : g));
        const owned = new Set(
          nodesRef.current
            .filter((n): n is CardFlowNode => n.type === "card" && groupAtCenter(nodeBox(n), groupsBefore)?.id === nodeId)
            .map((n) => n.id),
        );
        await refitGroupsImpl.current?.(new Map(), new Map(), false, undefined, new Map([[nodeId, { old: oldRect, owned }]]));
      }
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

  // ---- 分組框自動貼合框內卡片，長大碰到其他框時推開該框與其卡片 ----
  // before／after：被移動卡片的舊／新座標。其餘卡片與所有分組框一律取伺服器已確認的 saved，不依賴 React 何時 commit。
  // keepOldMembers=true（自動排版／復原）：舊座標在框內的卡片仍算成員，避免排版把卡片排出舊框範圍後被誤判為「已離開」。
  // 拖曳則為 false：拖出框外的卡片不再算成員，框才會縮小。
  const refitGroupsImpl = useRef<
    | ((
        before: Map<string, { x: number; y: number }>,
        after: Map<string, { x: number; y: number }>,
        keepOldMembers: boolean,
        forced?: Map<string, string>, // 卡片 id → 放開時意圖歸入的分組框節點 id（被推出框外也算成員）
        movedGroups?: Map<string, MovedGroup>, // 被拖動／縮放過的框（saved 已是新矩形）：把撞到的別框連同卡片整組推開
      ) => Promise<void>)
    | undefined
  >(undefined);
  refitGroupsImpl.current = async (before, after, keepOldMembers, forced, movedGroups) => {
    if (!boardId) return;
    try {
      const boxes: LayoutBox[] = nodesRef.current
        .filter((n): n is CardFlowNode => n.type === "card")
        .map((n) => {
          const b = nodeBox(n);
          const p = after.get(n.id) ?? saved.current.get(n.id);
          return p ? { ...b, x: p.x, y: p.y } : b;
        });
      const groups: GroupRect[] = nodesRef.current
        .filter((n): n is GroupFlowNode => n.type === "boardGroup")
        .map((n) => {
          const g = saved.current.get(n.id);
          return { id: n.id, x: g?.x ?? n.position.x, y: g?.y ?? n.position.y, w: g?.w ?? n.width ?? 360, h: g?.h ?? n.height ?? 240 };
        });
      if (groups.length === 0) return;

      // 只處理「有被移動的卡片進出過」的分組框
      const members = new Map<string, string[]>();
      for (const g of groups) {
        let affected = false;
        const ids: string[] = [];
        for (const b of boxes) {
          const old = before.get(b.id);
          const moved = !!old;
          // 原因：重疊的框各自用 centerInRect 判定，會同時認領同一張卡片，框就越長越大去「搶」別框的卡片；
          // 一張卡片同時只屬於一個框（中心點所在、面積最小者）
          const inNow = groupAtCenter(b, groups)?.id === g.id;
          const inOld = !!old && groupAtCenter({ ...b, x: old.x, y: old.y }, groups)?.id === g.id;
          // 原因：歸屬在避讓之前判定；被推到框外的卡片中心出框，不算意圖就會被丟出成員，框也不會長大
          const wantsIn = forced?.get(b.id) === g.id;
          if (moved && (inNow || inOld || wantsIn)) affected = true;
          if (inNow || wantsIn || (moved && keepOldMembers && inOld)) ids.push(b.id);
        }
        if (affected) members.set(g.id, ids);
      }
      if (members.size === 0 && !movedGroups?.size) return;

      const result = fitGroups(groups, boxes, members, movedGroups);
      if (result.groups.size === 0 && result.cards.size === 0) return;

      // 先更新畫面，儲存失敗再回復
      setNodes((ns) =>
        ns.map((n) => {
          if (n.type === "boardGroup") {
            const r = result.groups.get(n.id);
            return r
              ? { ...n, position: { x: r.x, y: r.y }, width: r.w, height: r.h, style: { width: r.w, height: r.h, zIndex: -1 } }
              : n;
          }
          const p = result.cards.get(n.id);
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        }),
      );

      const groupEntries = Array.from(result.groups.entries());
      const settled = await Promise.allSettled(
        groupEntries.map(([id, r]) =>
          api.patchBoardGroup(boardId, id.slice("group:".length), { x: r.x, y: r.y, w: r.w, h: r.h }),
        ),
      );
      let failed = false;
      for (let i = 0; i < settled.length; i++) {
        const [id, r] = groupEntries[i];
        const s = settled[i];
        if (s.status === "fulfilled") {
          saved.current.set(id, { x: r.x, y: r.y, w: r.w, h: r.h });
          continue;
        }
        failed = true;
        const g = saved.current.get(id);
        if (g) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id && n.type === "boardGroup"
                ? {
                    ...n,
                    position: { x: g.x, y: g.y },
                    width: g.w ?? 360,
                    height: g.h ?? 240,
                    style: { width: g.w ?? 360, height: g.h ?? 240, zIndex: -1 },
                  }
                : n,
            ),
          );
        }
        report(s.reason, "儲存分組框自動調整失敗，已回復");
      }

      const cardItems = Array.from(result.cards.entries()).map(([card_id, p]) => ({ card_id, x: p.x, y: p.y }));
      if (cardItems.length === 0) return;
      const revertCards = () =>
        setNodes((ns) =>
          ns.map((n) => {
            const g = saved.current.get(n.id);
            return n.type === "card" && result.cards.has(n.id) && g ? { ...n, position: { x: g.x, y: g.y } } : n;
          }),
        );
      if (failed) {
        // 有框沒存成功：被推開的卡片也不寫入，避免卡片與框的位置在伺服器上不一致
        revertCards();
        return;
      }
      try {
        await api.patchBoardCards(boardId, cardItems);
        cardItems.forEach((i) => {
          const g = saved.current.get(i.card_id);
          saved.current.set(i.card_id, { x: i.x, y: i.y, w: g?.w ?? null, h: g?.h ?? null });
        });
      } catch (e) {
        revertCards();
        report(e, "儲存被推開的卡片位置失敗，已回復");
      }
    } catch (e) {
      report(e, "分組框自動調整失敗");
    }
  };

  const toNode = useCallback(
    (c: BoardCard): CardFlowNode => ({
      id: c.card_id,
      type: "card",
      position: { x: c.x, y: c.y },
      width: c.w ?? 280,
      height: c.h ?? undefined,
      style: { width: c.w ?? 280, height: c.h ?? undefined },
      data: {
        title: c.title,
        body: c.body,
        updatedAt: c.updated_at,
        sized: c.h != null,
        onResizeEnd,
        onResetSize: onResetCardSize,
        onFitHeight: onFitCardHeight,
        onOpenCard,
        report,
      },
    }),
    [onOpenCard, onResizeEnd, onResetCardSize, onFitCardHeight, report],
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

  // 右側面板選了別張卡片，白板上同步選取（若白板目前正在多選且已包含該卡，則不洗掉多選；有選取卡片時一併清除分組框選取）
  useEffect(() => {
    syncedSelectedRef.current = selectedCardId;
    setNodes((ns) => {
      const selectedCards = ns.filter((n) => n.type === "card" && n.selected);
      if (selectedCards.length > 1 && selectedCardId && selectedCards.some((n) => n.id === selectedCardId)) {
        return ns.some((n) => n.type === "boardGroup" && n.selected)
          ? ns.map((n) => (n.type === "boardGroup" && n.selected ? { ...n, selected: false } : n))
          : ns;
      }
      const needUpdate = ns.some((n) =>
        n.type === "card"
          ? !!n.selected !== (n.id === selectedCardId)
          : Boolean(selectedCardId && n.selected),
      );
      if (!needUpdate) return ns;
      return ns.map((n) => {
        if (n.type === "card") return { ...n, selected: n.id === selectedCardId };
        if (selectedCardId && n.selected) return { ...n, selected: false };
        return n;
      });
    });
  }, [selectedCardId]);

  const onNodesChange = useCallback(
    (changes: NodeChange<AnyFlowNode>[]) => {
      const drags = changes.filter(
        (c): c is PositionChange => c.type === "position" && c.dragging === true && !!c.position,
      );
      let next = changes;
      let guides: MagnetGuide[] = [];

      // 若使用者主動抓取的是卡片，鎖定同批誤被帶入的 boardGroup 不移動（防止在分組框內拖卡片時把分組框一起拖走）
      const activeType = activeDragRef.current?.type;
      const cardDrags =
        activeType === "boardGroup"
          ? []
          : drags.filter((d) => !d.id.startsWith("group:"));

      if (drags.length > 0 && shiftRef.current) {
        // Shift：以拖曳起點為基準，位移取固定間距的整數倍
        next = changes.map((c) => {
          if (c.type !== "position" || !c.dragging || !c.position) return c;
          const start = dragStartRef.current.get(c.id);
          if (!start) return c;
          if (activeType === "card" && c.id.startsWith("group:")) {
            return { ...c, position: { x: start.x, y: start.y } };
          }
          const qPos = { x: quantizeFromStart(start.x, c.position.x), y: quantizeFromStart(start.y, c.position.y) };
          lastSnappedPosRef.current.set(c.id, qPos);
          return { ...c, position: qPos };
        });
      } else if (cardDrags.length >= 1 && snapRef.current) {
        // 單張或多張卡片拖曳（含分組框內卡片）：磁吸對齊其他未移動卡片的邊緣／中線，並吸到固定間距
        const movingCardIds = new Set(cardDrags.map((d) => d.id));
        const movingBoxes: LayoutBox[] = [];
        for (const d of cardDrags) {
          const moving = nodesRef.current.find((n): n is CardFlowNode => n.type === "card" && n.id === d.id);
          if (moving && d.position) {
            movingBoxes.push({ ...nodeBox(moving), x: d.position.x, y: d.position.y });
          }
        }
        const others = nodesRef.current
          .filter((n): n is CardFlowNode => n.type === "card" && !movingCardIds.has(n.id))
          .map(nodeBox);

        let snapDx = 0;
        let snapDy = 0;
        if (movingBoxes.length === 1) {
          const r = computeMagnetSnap(
            movingBoxes[0],
            others,
            MAGNET_THRESHOLD_PX / rf.getZoom(),
            undefined,
            true, // 只吸到放開後不會被推開的位置，紅線才可信
          );
          snapDx = r.x - movingBoxes[0].x;
          snapDy = r.y - movingBoxes[0].y;
          guides = r.guides;
        } else if (movingBoxes.length >= 2) {
          const threshold = MAGNET_THRESHOLD_PX / rf.getZoom();
          const minX = Math.min(...movingBoxes.map((b) => b.x));
          const minY = Math.min(...movingBoxes.map((b) => b.y));
          const maxX = Math.max(...movingBoxes.map((b) => b.x + b.w));
          const maxY = Math.max(...movingBoxes.map((b) => b.y + b.h));
          const unionBox: LayoutBox = {
            id: "__multi__",
            x: minX,
            y: minY,
            w: maxX - minX,
            h: maxY - minY,
          };
          const rUnion = computeMagnetSnap(unionBox, others, threshold);
          snapDx = rUnion.x - unionBox.x;
          snapDy = rUnion.y - unionBox.y;
          let vGuides = rUnion.guides.filter((g) => g.x1 === g.x2);
          let hGuides = rUnion.guides.filter((g) => g.y1 === g.y2);

          // 同時檢查滑鼠主動抓取的主卡片，若主卡片能更近距離對齊其他卡片，優先採用主卡片的軸向吸附
          const primaryId = activeDragRef.current?.id;
          const primaryBox = movingBoxes.find((b) => b.id === primaryId) ?? movingBoxes[0];
          const rPri = computeMagnetSnap(primaryBox, others, threshold);
          const dxPri = rPri.x - primaryBox.x;
          const dyPri = rPri.y - primaryBox.y;
          const priVGuides = rPri.guides.filter((g) => g.x1 === g.x2);
          const priHGuides = rPri.guides.filter((g) => g.y1 === g.y2);

          if (
            (dxPri !== 0 || priVGuides.length > 0) &&
            ((snapDx === 0 && vGuides.length === 0) || Math.abs(dxPri) < Math.abs(snapDx))
          ) {
            snapDx = dxPri;
            vGuides = priVGuides;
          }
          if (
            (dyPri !== 0 || priHGuides.length > 0) &&
            ((snapDy === 0 && hGuides.length === 0) || Math.abs(dyPri) < Math.abs(snapDy))
          ) {
            snapDy = dyPri;
            hGuides = priHGuides;
          }
          guides = [...vGuides, ...hGuides];
        }

        next = changes.map((c) => {
          if (c.type !== "position" || !c.dragging || !c.position) return c;
          if (c.id.startsWith("group:")) {
            const start = dragStartRef.current.get(c.id);
            return start ? { ...c, position: { x: start.x, y: start.y } } : c;
          }
          if (!movingCardIds.has(c.id)) return c;
          const pos = { x: c.position.x + snapDx, y: c.position.y + snapDy };
          lastSnappedPosRef.current.set(c.id, pos);
          return { ...c, position: pos };
        });
      } else if (activeType === "card" && drags.length > 0) {
        // 未開啟自動對齊但主動拖曳卡片時，仍防止誤被選中的分組框跟著移動
        next = changes.map((c) => {
          if (c.type === "position" && c.dragging && c.id.startsWith("group:")) {
            const start = dragStartRef.current.get(c.id);
            return start ? { ...c, position: { x: start.x, y: start.y } } : c;
          }
          return c;
        });
      }

      // 放開滑鼠瞬間（dragging === false），若 React Flow 帶入未吸附座標，保留最後一次磁吸座標
      next = next.map((c) => {
        if (c.type === "position" && c.dragging === false && c.position) {
          const snapped = lastSnappedPosRef.current.get(c.id);
          if (snapped) return { ...c, position: snapped };
        }
        return c;
      });

      setMagnetGuides((cur) => (cur.length === 0 && guides.length === 0 ? cur : guides));
      setNodes((ns) => {
        const updated = applyNodeChanges(next, ns);
        // 若在分組框內框選導致卡片與分組框同時被選取，自動取消分組框的選取，確保後續拖曳只作用於卡片
        const hasSelectedCard = updated.some((n) => n.type === "card" && n.selected);
        const hasSelectedGroup = updated.some((n) => n.type === "boardGroup" && n.selected);
        if (hasSelectedCard && hasSelectedGroup) {
          return updated.map((n) => (n.type === "boardGroup" && n.selected ? { ...n, selected: false } : n));
        }
        return updated;
      });
    },
    [rf],
  );

  const onSelectionChange = useCallback(
    ({ nodes: sel }: { nodes: { id: string; type?: string }[] }) => {
      const cardSel = sel.filter((n) => !n.id.startsWith("group:"));
      // App 的選取已變、nodes 還沒同步：這次回報是舊選取，丟棄；nodes 追上後 React Flow 會再回報一次
      if (syncedSelectedRef.current !== selectedRef.current) return;
      // React Flow 的 store 比 nodes state 晚一個 commit 才同步，回報的選取可能是上一刻的過期快照。
      // 以 nodes 為準：不一致就丟棄，等 store 追上後的下一次回報再處理；
      // 否則會與 [selectedCardId] effect 互相覆寫，形成無限迴圈（React error #185）
      const current = nodesRef.current.filter((n) => n.type === "card" && n.selected).map((n) => n.id);
      if (cardSel.length !== current.length || cardSel.some((n) => !current.includes(n.id))) {
        return;
      }
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

  // 分組框的伺服器已確認矩形（拖曳中的畫面位置不可信，取法與 refitGroupsImpl 一致）
  const savedGroupRects = useCallback(
    (): GroupRect[] =>
      nodesRef.current
        .filter((n): n is GroupFlowNode => n.type === "boardGroup")
        .map((n) => {
          const g = saved.current.get(n.id);
          return { id: n.id, x: g?.x ?? n.position.x, y: g?.y ?? n.position.y, w: g?.w ?? n.width ?? 360, h: g?.h ?? n.height ?? 240 };
        }),
    [],
  );

  // 拖曳卡片時亮起「放開後會歸入」的分組框；只在亮框集合改變時才更新 nodes
  const dropTargetKeyRef = useRef("");
  const setDropTargets = useCallback((ids: string[]) => {
    const key = [...ids].sort().join("|");
    if (key === dropTargetKeyRef.current) return;
    dropTargetKeyRef.current = key;
    const on = new Set(ids);
    setNodes((ns) =>
      ns.map((n) =>
        n.type === "boardGroup" && (n.className === "drop-target") !== on.has(n.id)
          ? { ...n, className: on.has(n.id) ? "drop-target" : undefined }
          : n,
      ),
    );
  }, []);

  // ---- 拖曳分組框時，框內卡片同步跟隨移動 ----
  const onNodeDragStart: OnNodeDrag<AnyFlowNode> = useCallback((_e, node, dragged) => {
    activeDragRef.current = { id: node.id, type: node.type ?? "card" };
    lastSnappedPosRef.current.clear();
    dragStartRef.current = new Map(dragged.map((n) => [n.id, { x: n.position.x, y: n.position.y }]));
    if (node.type !== "boardGroup") {
      groupDragRef.current = null;
      return;
    }
    const g = saved.current.get(node.id);
    const gx = g?.x ?? node.position.x;
    const gy = g?.y ?? node.position.y;
    // 原因：純幾何判定會把重疊區內別框的卡片一起拖走；改用唯一歸屬（與貼合、亮框同一判定）
    const rects = savedGroupRects();
    const members = nodesRef.current
      .filter((n): n is CardFlowNode => n.type === "card" && groupAtCenter(nodeBox(n), rects)?.id === node.id)
      .map((n) => n.id);
    groupDragRef.current = { groupId: node.id, startX: gx, startY: gy, memberIds: members };
  }, [savedGroupRects]);

  const onNodeDrag: OnNodeDrag<AnyFlowNode> = useCallback((_e, node, dragged) => {
    if (node.type === "card") {
      // 判定與 onNodeDragStop 相同：中心點、磁吸後座標、伺服器已確認的框
      const gs = savedGroupRects();
      const hits = new Set<string>();
      for (const n of dragged) {
        if (n.type !== "card") continue;
        const b = nodeBox(n as CardFlowNode);
        const p = lastSnappedPosRef.current.get(n.id);
        const hit = groupAtCenter(p ? { ...b, x: p.x, y: p.y } : b, gs);
        if (hit) hits.add(hit.id);
      }
      setDropTargets(Array.from(hits));
      return;
    }
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
  }, [savedGroupRects, setDropTargets]);

  // ---- 拖曳結束才寫入；開啟自動對齊時吸附格線並避開重疊卡片；失敗回復 ----
  const onNodeDragStop: OnNodeDrag<AnyFlowNode> = useCallback(
    async (_e, node, dragged) => {
      const activeType = activeDragRef.current?.type ?? node.type;
      activeDragRef.current = null;
      setMagnetGuides([]);
      setDropTargets([]);
      if (!boardId) return;
      const gd = groupDragRef.current;
      groupDragRef.current = null;

      const groupNodes =
        activeType === "boardGroup"
          ? dragged.filter((n): n is GroupFlowNode => n.type === "boardGroup")
          : [];
      // 框實際落地的位移（吸附後）與落地前的矩形；null＝沒動或沒存成功
      let groupMove: { dx: number; dy: number; old: { x: number; y: number; w: number; h: number } } | null = null;
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
          if (gd && gn.id === gd.groupId) {
            groupMove = {
              dx: nextX - gd.startX,
              dy: nextY - gd.startY,
              old: { x: gd.startX, y: gd.startY, w: prev?.w ?? gn.width ?? 360, h: prev?.h ?? gn.height ?? 240 },
            };
          }
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

      // 框對框：被框碰到的別的框連同它的卡片整組推開。owned＝這個框自己的成員，不會被當成別框的卡片帶走
      if (groupMove && gd) {
        await refitGroupsImpl.current?.(
          new Map(),
          new Map(),
          false,
          undefined,
          new Map([[gd.groupId, { old: groupMove.old, owned: new Set(gd.memberIds) }]]),
        );
      }

      const movedCardIds = new Set<string>(
        dragged.filter((n) => n.type === "card").map((n) => n.id),
      );
      if (gd) gd.memberIds.forEach((id) => movedCardIds.add(id));
      if (movedCardIds.size === 0) {
        lastSnappedPosRef.current.clear();
        return;
      }

      const allCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card");
      const movingBoxes = allCards
        .filter((n) => movedCardIds.has(n.id))
        .map((n) => {
          const b = nodeBox(n);
          const snapped = lastSnappedPosRef.current.get(n.id);
          return snapped ? { ...b, x: snapped.x, y: snapped.y } : b;
        });
      lastSnappedPosRef.current.clear();
      const fixedBoxes = allCards.filter((n) => !movedCardIds.has(n.id)).map(nodeBox);

      // 歸屬以「放開當下中心點在哪個框內」為準（與亮框同一判定）：
      // 中心進框＝不避讓自己要進的框，之後框長大包住它；中心沒進＝框是障礙物，卡片被推開、框不動。
      // 拖的是分組框時（成員剛體跟著走）不在此處理，維持原行為（檢查點 3 處理）。
      const groupRects = activeType === "card" ? savedGroupRects() : [];
      const intent = new Map<string, string>();
      for (const b of movingBoxes) {
        const hit = groupAtCenter(b, groupRects);
        if (hit) intent.set(b.id, hit.id);
      }

      const resolvedMap = new Map<string, { x: number; y: number }>();
      if (activeType === "boardGroup") {
        // 原因：成員被當成獨立卡片逐張避讓，整組相對位置會被打散。框是剛體：成員位移＝框實際落地（吸附後）的位移；
        // 框沒動或沒存成功（groupMove 為 null）就全部回到伺服器已確認的位置。碰撞由上面的框對框推開處理。
        for (const b of movingBoxes) {
          const o = saved.current.get(b.id);
          resolvedMap.set(b.id, o ? { x: o.x + (groupMove?.dx ?? 0), y: o.y + (groupMove?.dy ?? 0) } : { x: b.x, y: b.y });
        }
      } else if (!snapRef.current) {
        movingBoxes.forEach((b) => resolvedMap.set(b.id, { x: b.x, y: b.y }));
      } else {
        const fixed: LayoutBox[] = [...fixedBoxes];
        for (const key of Array.from(new Set(movingBoxes.map((b) => intent.get(b.id) ?? "")))) {
          const part = movingBoxes.filter((b) => (intent.get(b.id) ?? "") === key);
          const placed = placeCardsAvoidingCollisions(
            part,
            [...fixed, ...groupRects.filter((g) => g.id !== key)],
            GRID_SIZE,
          );
          for (const b of part) {
            const p = placed.get(b.id) ?? { x: b.x, y: b.y };
            resolvedMap.set(b.id, p);
            fixed.push({ ...b, x: p.x, y: p.y });
          }
        }
      }

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
      const before = new Map<string, { x: number; y: number }>(
        items.map((i) => {
          const g = saved.current.get(i.card_id);
          return [i.card_id, { x: g?.x ?? i.x, y: g?.y ?? i.y }];
        }),
      );
      try {
        await api.patchBoardCards(boardId, items);
        items.forEach((i) => {
          const g = saved.current.get(i.card_id);
          saved.current.set(i.card_id, { x: i.x, y: i.y, w: g?.w ?? null, h: g?.h ?? null });
        });
        // 拖的是分組框時成員跟著框走、相對位置不變，不需要貼合；只有拖卡片才會進出框
        if (activeType === "card") {
          await refitGroupsImpl.current?.(
            before,
            new Map<string, { x: number; y: number }>(items.map((i) => [i.card_id, { x: i.x, y: i.y }])),
            false,
            intent,
          );
        }
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
    [boardId, report, savedGroupRects, setDropTargets],
  );

  // ---- 拉線建立有向具名連結（成功後顯示線，並開啟關係設定視窗）----
  const onConnect = useCallback(
    async (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return;
      if (c.source.startsWith("group:") || c.target.startsWith("group:")) return;
      try {
        const r = await api.putLink(c.source, c.target, {
          relation_type: "延伸",
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
          // 對稱類型（類比、互補、鄰接、張力）沒有方向，不畫箭頭
          markerEnd: isSymmetricRelation(l.relation_type)
            ? undefined
            : {
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

  // 取消選取（少於 2 張）視為排版使用完畢：快照只對排版當下那批卡片有效，留著會讓之後的復原蓋掉新位置
  useEffect(() => {
    if (selectedCards.length < 2 && undoSnapshot) setUndoSnapshot(null);
  }, [selectedCards.length, undoSnapshot]);

  const runAutoLayout = useCallback(
    async (overrideOpts?: {
      mode?: LayoutMode;
      gap?: number;
      clusterThreshold?: number;
      centerCardId?: string | null;
      splitMode?: SplitMode;
      typeSideMap?: Record<RelationType, "left" | "right">;
      gridCols?: number | null;
      gridRows?: number | null;
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
        gridCols: overrideOpts?.gridCols !== undefined ? overrideOpts.gridCols : gridCols,
        gridRows: overrideOpts?.gridRows !== undefined ? overrideOpts.gridRows : gridRows,
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
        await refitGroupsImpl.current?.(
          new Map<string, { x: number; y: number }>(prevSnapshot.map((p) => [p.card_id, { x: p.x, y: p.y }])),
          new Map<string, { x: number; y: number }>(patchItems.map((p) => [p.card_id, { x: p.x, y: p.y }])),
          true,
        );
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
    [boardId, clusterThreshold, designatedCenterId, gridCols, gridRows, layoutGap, layoutMode, links, report, splitMode, typeSideMap],
  );

  const undoAutoLayout = useCallback(async () => {
    if (!boardId || !undoSnapshot || undoSnapshot.length === 0) return;
    const toRestore = undoSnapshot;
    const layoutPos = new Map<string, { x: number; y: number }>(
      toRestore.map((p) => {
        const g = saved.current.get(p.card_id);
        return [p.card_id, { x: g?.x ?? p.x, y: g?.y ?? p.y }];
      }),
    );
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
      await refitGroupsImpl.current?.(
        layoutPos,
        new Map<string, { x: number; y: number }>(toRestore.map((p) => [p.card_id, { x: p.x, y: p.y }])),
        true,
      );
    } catch (e) {
      report(e, "復原排版失敗");
    }
  }, [boardId, report, undoSnapshot]);

  // ---- 複製已選卡片：標題＋內文（不含圖片，保留代碼）----
  const copySelectedCards = useCallback(async () => {
    const sel = nodesRef.current
      .filter((n): n is CardFlowNode => n.type === "card" && !!n.selected)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    if (sel.length === 0) return;
    const text = sel
      .map((n) => {
        const title = (n.data.title || "（無標題）").trim();
        const body = stripImagesKeepCode(n.data.body || "");
        return body ? "# " + title + "\n\n" + body : "# " + title;
      })
      .join("\n\n---\n\n");
    try {
      await navigator.clipboard.writeText(text);
      info("已複製 " + String(sel.length) + " 張卡片的標題與內容（不含圖片）");
    } catch (e) {
      report(e, "複製失敗");
    }
  }, [info, report]);

  // 建立新卡片並加入白板的輔助邏輯
  const createCardFromDrop = useCallback(
    async (fileName: string, body: string, dropX: number, dropY: number) => {
      if (!boardId) return;
      let initX = dropX;
      let initY = dropY;
      if (snapRef.current) {
        const placed = placeCardsAvoidingCollisions(
          [{ id: "temp", x: initX, y: initY, w: DEFAULT_CARD_W, h: DEFAULT_CARD_H }],
          nodesRef.current.filter((n): n is CardFlowNode => n.type === "card").map(nodeBox),
          GRID_SIZE,
        );
        const pos = placed.get("temp");
        if (pos) {
          initX = pos.x;
          initY = pos.y;
        }
      }

      const created = await api.createCard();
      const updated = await api.patchCard(created.id, { title: fileName, body }, created.updated_at);
      const added = await api.addToBoard(boardId, created.id, initX, initY);
      saved.current.set(created.id, { x: added.x, y: added.y, w: added.w, h: added.h });
      const node = toNode({ ...added, title: updated.title, body: updated.body, updated_at: updated.updated_at });
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { ...node, selected: true }]);
      onSelectCard(created.id);
      onCountChanged();
      info(`已由代碼檔案 ${fileName} 建立卡片`);
    },
    [boardId, info, onCountChanged, onSelectCard, toNode],
  );

  // 覆蓋既有同名卡片的輔助邏輯
  const overwriteCardFromDrop = useCallback(
    async (cardId: string, fileName: string, body: string) => {
      try {
        const cur = await api.getCard(cardId);
        const updated = await api.patchCard(cardId, { title: fileName, body }, cur.updated_at);
        notifyCardTitleUpdated(cardId, updated.title);
        setNodes((ns) =>
          ns.map((n) =>
            n.id === cardId && n.type === "card"
              ? { ...n, data: { ...n.data, title: updated.title, body: updated.body } }
              : n,
          ),
        );
        info(`已覆蓋卡片「${fileName}」`);
      } catch (err) {
        report(err, `覆蓋卡片「${fileName}」失敗`);
      }
    },
    [info, report],
  );

  // ---- 拖曳代碼檔案建立新卡片（含同名覆蓋與分組框範圍保險）----
  const onBoardDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!boardId || !e.dataTransfer.files.length) return;
      e.preventDefault();

      const files = Array.from(e.dataTransfer.files);
      const flowPos = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });

      const allCards = nodesRef.current.filter((n): n is CardFlowNode => n.type === "card");
      const groupNodes = nodesRef.current.filter((n): n is GroupFlowNode => n.type === "boardGroup");

      const conflicts: DropConflictItem[] = [];

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const ext = file.name.split(".").pop()?.toLowerCase() || "";
        const lang = CODE_EXT_MAP[ext];
        if (!lang) {
          report(new Error(`略過不支援的檔案「${file.name}」，僅支援代碼檔案`), "檔案格式不支援");
          continue;
        }

        let content = "";
        try {
          content = await file.text();
        } catch (err) {
          report(err, `讀取檔案「${file.name}」失敗`);
          continue;
        }

        const dropX = flowPos.x + i * 24;
        const dropY = flowPos.y + i * 24;

        // 偵測落點是否在任一分組框內
        const hitGroup = groupNodes.find((g) => {
          const gw = g.width ?? 360;
          const gh = g.height ?? 240;
          return dropX >= g.position.x && dropX <= g.position.x + gw && dropY >= g.position.y && dropY <= g.position.y + gh;
        });

        let targetCards: CardFlowNode[] = [];
        let scopeLabel = "白板";

        if (hitGroup) {
          // 在分組框內：只比對屬於該分組框的卡片
          const gx = hitGroup.position.x;
          const gy = hitGroup.position.y;
          const gw = hitGroup.width ?? 360;
          const gh = hitGroup.height ?? 240;
          targetCards = allCards.filter((c) => {
            const b = nodeBox(c);
            const cx = b.x + b.w / 2;
            const cy = b.y + b.h / 2;
            return cx >= gx && cx <= gx + gw && cy >= gy && cy <= gy + gh;
          });
          scopeLabel = `分組框「${hitGroup.data.label || "未命名分組"}」`;
        } else {
          // 在分組框外：比對該白板所有卡片
          targetCards = allCards;
          scopeLabel = "白板";
        }

        const matched = targetCards.find((c) => (c.data.title || "").trim() === file.name.trim());

        if (matched) {
          conflicts.push({
            file,
            content,
            lang,
            dropX,
            dropY,
            matchedCard: matched,
            scopeLabel,
          });
        } else {
          const body = "```" + lang + ":" + file.name + "\n" + content + "\n```\n";
          await createCardFromDrop(file.name, body, dropX, dropY);
        }
      }

      if (conflicts.length > 0) {
        setConflictQueue(conflicts);
      }
    },
    [boardId, createCardFromDrop, report, rf],
  );

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
                  relation_type: l.relation_type ?? "延伸",
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
          x = minX - GROUP_PAD;
          y = minY - GROUP_PAD_TOP;
          w = Math.max(260, maxX - minX + GROUP_PAD * 2);
          h = Math.max(180, maxY - minY + GROUP_PAD_TOP + GROUP_PAD);
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
    <div
      className={`board${pickingCenterDrag ? " picking-center" : ""}`}
      ref={wrapRef}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDrop={(e) => void onBoardDrop(e)}
    >
      {boardId &&
        props.toolsSlot &&
        createPortal(
          <>
            <button
              type="button"
              onClick={() => setShowLocateModal(true)}
              title="貼上代碼片段或 AI 回覆，自動搜尋白板卡片並跳轉中央定位取代"
            >
              <CrosshairIcon />
              定位
            </button>
            <button
              type="button"
              className={snapToGrid ? "on" : ""}
              onClick={() => toggleSnapToGrid(!snapToGrid)}
              title="勾選時：拖曳卡片靠近其他卡片會磁吸對齊（顯示提示線）並吸到固定間距 20px；按住 Shift 拖曳則以 20px 為單位移動；放開時若重疊則自動移到最近空位"
            >
              <input
                type="checkbox"
                checked={snapToGrid}
                onChange={() => {}}
                style={{ margin: 0, width: 14, height: 14, pointerEvents: "none" }}
              />
              自動對齊
            </button>
          </>,
          props.toolsSlot,
        )}

      {showLocateModal && (
        <div className="modal" role="dialog" aria-label="貼上 AI 回覆並定位卡片">
          <div className="modal-card" style={{ maxWidth: 520 }}>
            <h4 style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <CrosshairIcon size={16} />
              貼上 AI 回覆並自動定位卡片
            </h4>
            <div className="muted" style={{ fontSize: 12, margin: "6px 0 10px" }}>
              貼上 AI 輸出的修改指令或代碼段落，系統將自動比對當前白板內的所有卡片，找到後立即進入中央編輯並啟動定位取代。
            </div>
            <textarea
              rows={8}
              value={locateText}
              onChange={(e) => setLocateText(e.target.value)}
              placeholder="在此貼上 AI 回覆全文（包含【尋找這段代碼】或檔名）..."
              autoFocus
              style={{
                width: "100%",
                boxSizing: "border-box",
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.45,
                resize: "vertical",
              }}
            />
            <div className="modal-actions" style={{ marginTop: 12, justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setShowLocateModal(false);
                  setLocateText("");
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleLocateCard}
                disabled={!locateText.trim()}
              >
                搜尋定位並開啟取代
              </button>
            </div>
          </div>
        </div>
      )}

      {boardId && selectedCards.length >= 2 && (
        <div className="board-multi-toolbar" role="toolbar" aria-label="多選批次與自動排列工具列">
          <span className="multi-count">已選 {selectedCards.length} 張</span>

          {selectedCards.length >= 2 && (
            <button
              onClick={() => void copySelectedCards()}
              title="複製已選卡片的標題與內容（不含圖片，保留代碼）"
            >
              📋 複製內容
            </button>
          )}

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
                  min={10}
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

              {layoutMode === "grid" && (
                <>
                  <label className="toolbar-ctrl" title="每排幾張卡片（橫排）。留空＝自動；兩者都填時以橫排為準">
                    <span>橫排</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      placeholder="自動"
                      value={gridCols ?? ""}
                      onChange={(e) => {
                        const next =
                          e.target.value === "" ? null : Math.max(1, Math.min(50, Math.floor(Number(e.target.value)) || 1));
                        setGridCols(next);
                        void runAutoLayout({ gridCols: next });
                      }}
                      style={{ width: 56 }}
                      aria-label="每排卡片張數"
                    />
                    <span>張</span>
                  </label>
                  <label className="toolbar-ctrl" title="每欄幾張卡片（縱排）。留空＝自動；只在橫排留空時生效">
                    <span>縱排</span>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      placeholder="自動"
                      value={gridRows ?? ""}
                      onChange={(e) => {
                        const next =
                          e.target.value === "" ? null : Math.max(1, Math.min(50, Math.floor(Number(e.target.value)) || 1));
                        setGridRows(next);
                        void runAutoLayout({ gridRows: next });
                      }}
                      style={{ width: 56 }}
                      aria-label="每欄卡片張數"
                    />
                    <span>張</span>
                  </label>
                </>
              )}

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
                      <CrosshairIcon size={12} />
                      {designatedCenterNode ? `中心：${designatedCenterNode.data.title || "（無標題）"}` : "拖曳指定中心"}
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
          const target = e.target as HTMLElement;
          if (target.closest(".media-size-bar") || target.closest(".nodrag")) return;
          if (node.type === "card") {
            setLastClickedCardId(node.id);
            if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
              onSelectCard(node.id);
            }
          }
        }}
        onNodeDragStart={onNodeDragStart}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onNodeDoubleClick={(e, node) => {
          const target = e.target as HTMLElement;
          if (target.closest(".media-size-bar") || target.closest(".nodrag")) return;
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
                // 用舊連結的兩端比對：改成對稱類型時後端可能把方向對調，updated 的兩端不一定等於舊的
                l.source_id === editingLink.source_id &&
                l.target_id === editingLink.target_id &&
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
      {conflictQueue.length > 0 && (
        <DropConflictModal
          item={conflictQueue[0]}
          remainingCount={conflictQueue.length}
          onResolve={async (decision, applyToAll) => {
            const currentItem = conflictQueue[0];
            const currentBody = "```" + currentItem.lang + ":" + currentItem.file.name + "\n" + currentItem.content + "\n```\n";

            if (applyToAll) {
              // 批次套用至當前及後續所有同名檔案
              for (const it of conflictQueue) {
                const b = "```" + it.lang + ":" + it.file.name + "\n" + it.content + "\n```\n";
                if (decision === "overwrite") {
                  await overwriteCardFromDrop(it.matchedCard.id, it.file.name, b);
                } else if (decision === "create_new") {
                  await createCardFromDrop(it.file.name, b, it.dropX, it.dropY);
                }
              }
              setConflictQueue([]);
            } else {
              // 單筆處理
              if (decision === "overwrite") {
                await overwriteCardFromDrop(currentItem.matchedCard.id, currentItem.file.name, currentBody);
              } else if (decision === "create_new") {
                await createCardFromDrop(currentItem.file.name, currentBody, currentItem.dropX, currentItem.dropY);
              }
              setConflictQueue((q) => q.slice(1));
            }
          }}
        />
      )}
    </div>
  );
}

function DropConflictModal(props: {
  item: {
    file: File;
    matchedCard: CardFlowNode;
    scopeLabel: string;
  };
  remainingCount: number;
  onResolve(decision: "overwrite" | "create_new" | "skip", applyToAll: boolean): void | Promise<void>;
}) {
  const { item, remainingCount, onResolve } = props;
  const [applyToAll, setApplyToAll] = useState(false);

  return (
    <div className="modal" role="dialog" aria-label="同名卡片覆蓋確認">
      <div className="modal-card" style={{ maxWidth: 440 }}>
        <h4>⚠️ 發現同名卡片</h4>
        <div style={{ fontSize: 13, lineHeight: 1.6, margin: "10px 0" }}>
          在<strong>【{item.scopeLabel}】</strong>已存在一張名為<strong>「{item.file.name}」</strong>的卡片。
          <br />
          您希望如何處理此檔案？
        </div>

        {remainingCount > 1 && (
          <label style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 14px", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            <span>套用此決定至本次其餘同名檔案（尚有 {remainingCount - 1} 個）</span>
          </label>
        )}

        <div className="modal-actions" style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" onClick={() => void onResolve("skip", applyToAll)}>
            略過此檔案
          </button>
          <button type="button" onClick={() => void onResolve("create_new", applyToAll)}>
            另建新卡片
          </button>
          <button type="button" className="primary" onClick={() => void onResolve("overwrite", applyToAll)}>
            覆蓋既有卡片
          </button>
        </div>
      </div>
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
          <span className="muted">
            {isSymmetricRelation(relationType)
              ? ` ──(${RELATION_LABELS[relationType]})── `
              : ` ──(${RELATION_LABELS[relationType]})──▶ `}
          </span>
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