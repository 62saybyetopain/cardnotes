// @depends-on ./Editor.tsx (Editor 自動儲存後，onSaved 回傳的 CardDetail 至少含 title/body/updated_at；父層 card 快照必須同步這三項，否則 ContentTab.updateMeta 以舊版本號送出會 409，onReload 重建 Editor 時也會顯示舊內文)
// @depends-on ../api.ts (patchCard 回傳值含 title/body/updated_at)
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { isSameAxisGroup, tagPath } from "../lib/tree";
import {
  CARD_TYPE_LABELS,
  LINK_STATUS_LABELS,
  RELATION_COLORS,
  RELATION_LABELS,
  type BoardCard,
  type BoardData,
  type BoardLink,
  type CardDetail,
  type CardLink,
  type CardSummary,
  type CardType,
  type CurationStatus,
  type LinkStatus,
  type RelationType,
  type Tag,
  type TagResolveResponse,
} from "../types";
import { Editor } from "./Editor";
import { FacetPicker } from "./FacetPicker";
import { Markdown } from "./Markdown";
import { RelationBox } from "./RelationBox";

export interface Filter {
  tagId?: string;
  unclassified?: boolean;
  curationStatus?: CurationStatus;
}
export type TabKey = "content" | "search" | "relations";

interface Props {
  selectedCardId: string | null;
  previewCardId?: string | null;
  boardId?: string | null;
  centerEditing?: boolean;
  tags: Tag[];
  filter: Filter;
  version: number; // 外部觸發資料變化（連結、標籤）時遞增，觸發重新載入卡片
  tab: TabKey;
  hideContentTab?: boolean;
  onResizeStart?(e: React.MouseEvent): void;
  onTab(t: TabKey): void;
  onClearFilter(): void;
  onSelectCard(id: string): void;
  onPreviewCard?(id: string | null): void;
  onCreateCard?(): void;
  onAddToBoard(id: string): void;
  onSaved(card: CardDetail): void;
  onCardDeleted(id: string): void;
  onLinkAdded?(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  onLinkDeleted?(sourceId: string, targetId: string, relationType?: RelationType): void;
  onTagsChanged(): void;
  onOpenBoard(id: string): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

export function CardEditorPane(props: {
  cardId: string;
  tags: Tag[];
  version: number;
  initialSmartPaste?: string | null;
  onClearInitialSmartPaste?(): void;
  onSaved(card: CardDetail): void;
  onCardDeleted(id: string): void;
  onLinkAdded?(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  onSelectCard?(id: string): void;
  onTagsChanged(): void;
  report(e: unknown, prefix?: string): void;
  info?(text: string): void;
}) {
  const { cardId, tags, version, initialSmartPaste, onClearInitialSmartPaste, onSaved, onCardDeleted, onLinkAdded, onSelectCard, onTagsChanged, report, info } = props;
  const [card, setCard] = useState<CardDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [fetchTick, setFetchTick] = useState(0);

  useEffect(() => {
    setCard(null);
    setLoadError("");
  }, [cardId]);

  useEffect(() => {
    let alive = true;
    api
      .getCard(cardId)
      .then((c) => alive && (setCard(c), setLoadError("")))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [cardId, version, fetchTick]);

  const refetch = useCallback(() => setFetchTick((n) => n + 1), []);

  if (loadError) {
    return (
      <div className="banner danger">
        載入卡片失敗：{loadError}
        <button onClick={refetch}>重試</button>
      </div>
    );
  }
  if (!card) return <div className="empty">載入中…</div>;

  return (
    <ContentTab
      card={card}
      tags={tags}
      nonce={nonce}
      initialSmartPaste={initialSmartPaste}
      onClearInitialSmartPaste={onClearInitialSmartPaste}
      onReload={() => (setNonce((n) => n + 1), refetch())}
      onSaved={(c) => {
        // Editor 自動儲存後，載入時的快照已落後伺服器：同步版本號與內容，
        // updateMeta 才不會以舊版本送出而 409，onReload 重建 Editor 時也會顯示已儲存的內容
        setCard((cur) => (cur && cur.id === c.id ? { ...cur, title: c.title, body: c.body, updated_at: c.updated_at } : cur));
        onSaved(c);
      }}
      onCardDeleted={onCardDeleted}
      onLinkAdded={onLinkAdded}
      onSelectCard={onSelectCard}
      onTagsChanged={() => (onTagsChanged(), refetch())}
      report={report}
      info={info}
    />
  );
}

const ALL_TABS: readonly (readonly [TabKey, string])[] = [
  ["content", "內容"],
  ["search", "搜尋"],
  ["relations", "關聯"],
];

export function RightPanel(p: Props) {
  const [card, setCard] = useState<CardDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [nonce, setNonce] = useState(0); // 只有「捨棄修改重新載入」才重建編輯器
  const [fetchTick, setFetchTick] = useState(0);
  const { selectedCardId, version, report, centerEditing, boardId } = p;
  const activeTab: TabKey = p.hideContentTab && p.tab === "content" ? "relations" : p.tab;
  const visibleTabs = p.hideContentTab ? ALL_TABS.filter(([k]) => k !== "content") : ALL_TABS;

  useEffect(() => {
    setCard(null);
    setLoadError("");
  }, [selectedCardId]);

  useEffect(() => {
    if (!selectedCardId) return;
    let alive = true;
    api
      .getCard(selectedCardId)
      .then((c) => alive && (setCard(c), setLoadError("")))
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [selectedCardId, version, fetchTick]);

  const refetch = useCallback(() => setFetchTick((n) => n + 1), []);

  return (
    <aside className="right">
      {p.onResizeStart && (
        <div
          className="right-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="調整右側面板寬度"
          onMouseDown={p.onResizeStart}
        />
      )}
      <div className="right-head">
        <div className="tabs" role="tablist">
          {visibleTabs.map(([k, label]) => {
            const displayLabel = k === "content" && centerEditing ? "白板卡片" : label;
            return (
              <button key={k} role="tab" aria-selected={activeTab === k} className={activeTab === k ? "on" : ""} onClick={() => p.onTab(k)}>
                {displayLabel}
              </button>
            );
          })}
        </div>
      </div>
      <div className="right-body">
        {activeTab === "search" && <SearchTab {...p} />}
        {activeTab === "content" && centerEditing && (
          <BoardCardsTab
            boardId={boardId ?? null}
            selectedCardId={selectedCardId}
            version={version}
            onJumpToCard={p.onSelectCard}
            report={report}
            info={p.info}
          />
        )}
        {activeTab !== "search" && !(activeTab === "content" && centerEditing) && !selectedCardId && (
          <div className="empty">在白板上點選一張卡片，或按「新增卡片」。</div>
        )}
        {activeTab !== "search" && !(activeTab === "content" && centerEditing) && selectedCardId && loadError && (
          <div className="banner danger">
            載入卡片失敗：{loadError}
            <button onClick={refetch}>重試</button>
          </div>
        )}
        {activeTab !== "search" && !(activeTab === "content" && centerEditing) && selectedCardId && !loadError && !card && (
          <div className="empty">載入中…</div>
        )}
        {activeTab === "content" && !centerEditing && card && (
          <ContentTab
            card={card}
            tags={p.tags}
            nonce={nonce}
            onReload={() => (setNonce((n) => n + 1), refetch())}
            onSaved={(c) => {
              // 同 CardEditorPane：快照要跟上 Editor 自動儲存後的版本與內容
              setCard((cur) => (cur && cur.id === c.id ? { ...cur, title: c.title, body: c.body, updated_at: c.updated_at } : cur));
              p.onSaved(c);
            }}
            onCardDeleted={p.onCardDeleted}
            onLinkAdded={p.onLinkAdded}
            onSelectCard={(id) => {
              if (p.onPreviewCard) {
                p.onPreviewCard(id);
                p.onTab("search");
              } else {
                p.onSelectCard(id);
              }
            }}
            onTagsChanged={() => (p.onTagsChanged(), refetch())}
            report={report}
            info={p.info}
          />
        )}
        {activeTab === "relations" && card && (
          <RelationsTab
            card={card}
            onChanged={refetch}
            onSelectCard={p.onSelectCard}
            onOpenBoard={p.onOpenBoard}
            onLinkAdded={p.onLinkAdded}
            onLinkDeleted={p.onLinkDeleted}
            report={report}
            info={p.info}
          />
        )}
      </div>
    </aside>
  );
}

function ContentTab(props: {
  card: CardDetail;
  tags: Tag[];
  nonce: number;
  initialSmartPaste?: string | null;
  onClearInitialSmartPaste?(): void;
  onReload(): void;
  onSaved(card: CardDetail): void;
  onCardDeleted(id: string): void;
  onLinkAdded?(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  onSelectCard?(id: string): void;
  onTagsChanged(): void;
  report(e: unknown, prefix?: string): void;
  info?(text: string): void;
}) {
  const { card, tags, report, info } = props;
  const [pick, setPick] = useState("");
  const [resolution, setResolution] = useState<TagResolveResponse | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newFacet, setNewFacet] = useState<string>("");
  const [newDef, setNewDef] = useState("");

  const locationTags = card.tags.filter((t) => isSameAxisGroup(t.axis, "location"));
  const conceptTags = card.tags.filter((t) => !isSameAxisGroup(t.axis, "location"));
  const allLocations = tags.filter((t) => isSameAxisGroup(t.axis, "location"));

  const updateMeta = async (patch: { card_type?: CardType; curation_status?: CurationStatus }) => {
    try {
      const updated = await api.patchCard(card.id, patch, card.updated_at);
      props.onSaved(updated);
      props.onReload();
    } catch (e) {
      report(e, "更新卡片狀態失敗");
    }
  };

  const assignTagById = async (tagId: string, note?: string) => {
    try {
      await api.assignTag(card.id, tagId);
      setPick("");
      setResolution(null);
      setCreatingNew(false);
      setNewFacet("");
      setNewDef("");
      if (note) info?.(note);
      props.onTagsChanged();
    } catch (e) {
      report(e, "加入標籤失敗");
    }
  };

  // 四階段標籤輸入解析：1.路徑或正式名 -> 2.別名自動解析 -> 3.相似或跨維度候選 -> 4.新增概念
  const resolveAndAssign = async () => {
    const text = pick.trim();
    if (!text) return;
    const byPath = tags.find((t) => tagPath(tags, t.id) === text);
    if (byPath) {
      await assignTagById(byPath.id);
      return;
    }
    try {
      const res = await api.resolveTag(text);
      if (res.status === "exact_tag" && res.tag) {
        await assignTagById(res.tag.id);
      } else if (res.status === "exact_alias" && res.tag) {
        await assignTagById(
          res.tag.id,
          `已將別名「${res.matched_alias ?? text}」自動解析為正式標籤「${res.tag.name}」`,
        );
      } else if (res.status === "ambiguous" || res.status === "similar") {
        setResolution(res);
        setCreatingNew(false);
      } else {
        setResolution(res);
        setCreatingNew(true);
      }
    } catch (e) {
      report(e, "解析標籤失敗");
    }
  };

  const createAndAssignConcept = async () => {
    const text = pick.trim();
    if (!text) return;
    try {
      const tag = await api.createTag(text, "concept", null, {
        facet: newFacet.trim() || null,
        definition: newDef.trim(),
      });
      await assignTagById(tag.id);
    } catch (e) {
      report(e, "建立概念標籤失敗");
    }
  };

  const unassign = async (tagId: string) => {
    try {
      await api.unassignTag(card.id, tagId);
      props.onTagsChanged();
    } catch (e) {
      report(e, "移除標籤失敗");
    }
  };

  const remove = async () => {
    try {
      const i = await api.cardImpact(card.id);
      const msg =
        `確定要刪除這張卡片？（此動作無法復原）\n` +
        `・會從 ${i.board_count} 塊白板上消失${i.board_names.length ? `（${i.board_names.join("、")}）` : ""}\n` +
        `・會移除 ${i.link_count} 條連結`;
      if (!window.confirm(msg)) return;
      await api.deleteCard(card.id);
      props.onCardDeleted(card.id);
    } catch (e) {
      report(e, "刪除卡片失敗");
    }
  };

  return (
    <>
      <div className="curation-bar">
        <label className="curation-item" title="STEP 2：這張卡片本身屬於什麼知識型態？">
          <span className="muted">型態：</span>
          <select
            value={card.card_type ?? "untyped"}
            onChange={(e) => void updateMeta({ card_type: e.target.value as CardType })}
            aria-label="卡片型態"
          >
            {(Object.entries(CARD_TYPE_LABELS) as [CardType, string][]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className={`curation-btn ${card.curation_status === "curated" ? "curated" : "inbox"}`}
          onClick={() =>
            void updateMeta({
              curation_status: card.curation_status === "curated" ? "inbox" : "curated",
            })
          }
          title="區分「尚未整理（收件夾）」與「已審視整理完成（即使目前不需額外標籤或連結）」"
        >
          {card.curation_status === "curated" ? "✓ 已整理" : "📥 待整理（點擊完成整理）"}
        </button>
      </div>

      <div className="tag-section">
        <div className="chips">
          <span className="muted">收納位置：</span>
          {locationTags.length === 0 && <span className="muted">未歸檔</span>}
          {locationTags.map((t) => (
            <span key={t.id} className="chip location">
              📁 {tagPath(tags, t.id) || t.name}
              <button aria-label={`移除位置 ${t.name}`} onClick={() => void unassign(t.id)}>
                ✕
              </button>
            </span>
          ))}
          {allLocations.length > 0 && (
            <select
              className="loc-select"
              value=""
              onChange={(e) => e.target.value && void assignTagById(e.target.value)}
              aria-label="選擇收納位置"
            >
              <option value="">＋歸入抽屜…</option>
              {allLocations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {tagPath(tags, loc.id)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="chips">
          <span className="muted">概念標籤：</span>
          {conceptTags.length === 0 && <span className="muted">無概念標籤</span>}
          {conceptTags.map((t) => (
            <span
              key={t.id}
              className="chip concept"
              title={[t.facet ? `維度：${t.facet}` : "", t.definition ? `定義：${t.definition}` : ""].filter(Boolean).join("\n")}
            >
              {t.facet && <span className="facet-badge">{t.facet}</span>}
              {t.name}
              <button aria-label={`移除標籤 ${t.name}`} onClick={() => void unassign(t.id)}>
                ✕
              </button>
            </span>
          ))}
        </div>
      </div>

      <div className="tag-pick">
        <input
          list="all-tags"
          value={pick}
          placeholder="輸入概念或別名（自動解析同義詞、提示相似概念）"
          onChange={(e) => {
            setPick(e.target.value);
            if (resolution) setResolution(null);
            if (creatingNew) setCreatingNew(false);
          }}
          onKeyDown={(e) => e.key === "Enter" && void resolveAndAssign()}
          aria-label="加入標籤"
        />
        <datalist id="all-tags">
          {tags.map((t) => (
            <option
              key={t.id}
              value={isSameAxisGroup(t.axis, "location") ? tagPath(tags, t.id) : t.name}
              label={
                [t.facet ? `[${t.facet}]` : "", t.aliases?.length ? `別名: ${t.aliases.join(",")}` : ""]
                  .filter(Boolean)
                  .join(" ")
              }
            />
          ))}
        </datalist>
        <button onClick={() => void resolveAndAssign()}>加入</button>
      </div>

      {resolution && (resolution.status === "ambiguous" || resolution.status === "similar") && (
        <div className="resolve-box">
          <div className="resolve-title">
            {resolution.status === "ambiguous"
              ? `發現同名但不同維度的概念「${pick.trim()}」，請選擇正確語意：`
              : `找到與「${pick.trim()}」相似的既有概念（優先重用既有標籤）：`}
          </div>
          <ul className="plain resolve-list">
            {resolution.candidates.map((cand) => (
              <li key={cand.id} className="resolve-item">
                <button className="resolve-pick" onClick={() => void assignTagById(cand.id)}>
                  {cand.facet && <span className="facet-badge">{cand.facet}</span>}
                  <strong>{cand.name}</strong>
                  {cand.aliases && cand.aliases.length > 0 && (
                    <span className="muted">（別名：{cand.aliases.join("、")}）</span>
                  )}
                  {cand.definition && <div className="resolve-def">{cand.definition}</div>}
                </button>
              </li>
            ))}
          </ul>
          <div className="resolve-actions">
            <button onClick={() => setCreatingNew(true)}>都不是，建立新概念「{pick.trim()}」</button>
            <button onClick={() => setResolution(null)}>取消</button>
          </div>
        </div>
      )}

      {creatingNew && pick.trim() && (
        <div className="resolve-box">
          <div className="resolve-title">建立新概念標籤：「{pick.trim()}」</div>
          <FacetPicker value={newFacet} onChange={setNewFacet} />
          <div className="field-row">
            <span className="muted">簡短定義（選填）：</span>
            <input
              value={newDef}
              onChange={(e) => setNewDef(e.target.value)}
              placeholder="一句話定義此概念，避免未來與其他標籤混淆"
            />
          </div>
          <div className="resolve-actions">
            <button className="primary" onClick={() => void createAndAssignConcept()}>
              建立並套用
            </button>
            <button onClick={() => (setCreatingNew(false), setResolution(null))}>暫不建立</button>
          </div>
        </div>
      )}

      <RelationBox
        key={card.id}
        card={card}
        tags={tags}
        onAssignBridgeTag={assignTagById}
        onSelectCard={props.onSelectCard}
        report={report}
        info={info}
      />

      <Editor
        key={`${card.id}:${props.nonce}`}
        card={card}
        initialSmartPaste={props.initialSmartPaste}
        onClearInitialSmartPaste={props.onClearInitialSmartPaste}
        onSaved={props.onSaved}
        onReload={props.onReload}
        onLinkAdded={props.onLinkAdded}
        onOpenCard={props.onSelectCard}
        report={report}
      />
      <button className="danger" onClick={() => void remove()}>
        刪除卡片…
      </button>
    </>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SearchTab(p: Props) {
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [items, setItems] = useState<CardSummary[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [err, setErr] = useState("");
  const [localPreviewId, setLocalPreviewId] = useState<string | null>(p.previewCardId ?? null);
  const [paneOpen, setPaneOpen] = useState<boolean>(!!p.previewCardId);
  const [previewCard, setPreviewCard] = useState<CardDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState("");
  const [boardLocations, setBoardLocations] = useState<Map<string, string[]>>(new Map());
  const seq = useRef(0);
  const { tagId, unclassified, curationStatus } = p.filter;

  // 快取白板與分組框拓撲資訊，聚合每張卡片的所在白板與分組框
  useEffect(() => {
    let alive = true;
    api
      .listBoards()
      .then(async ({ boards }) => {
        if (!alive) return;
        const details = await Promise.allSettled(boards.map((b) => api.getBoard(b.id)));
        if (!alive) return;
        const locMap = new Map<string, string[]>();
        details.forEach((res) => {
          if (res.status !== "fulfilled") return;
          const b = res.value;
          const groups = b.groups ?? [];
          for (const c of b.cards) {
            const cw = c.w ?? 280;
            const ch = c.h ?? 160;
            const cx = c.x + cw / 2;
            const cy = c.y + ch / 2;
            const hitGroup = groups.find(
              (g) => cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h,
            );
            const loc = hitGroup ? `${b.name} | ${hitGroup.label || "未命名分組"}` : b.name;
            const cur = locMap.get(c.card_id) ?? [];
            cur.push(loc);
            locMap.set(c.card_id, cur);
          }
        });
        setBoardLocations(locMap);
      })
      .catch(() => {
        /* 忽略載入白板拓撲失敗，不阻礙搜尋功能 */
      });
    return () => {
      alive = false;
    };
  }, [p.version]);

  // 當外部點擊 @ 引用連結傳入 previewCardId 時，自動展開下方預覽區並載入該卡片
  useEffect(() => {
    if (p.previewCardId) {
      setLocalPreviewId(p.previewCardId);
      setPaneOpen(true);
    }
  }, [p.previewCardId]);

  useEffect(() => {
    const my = ++seq.current;
    setState("loading");
    api
      .listCards({ q: dq, tag_id: tagId, unclassified, curation_status: curationStatus, limit: 200 })
      .then((r) => my === seq.current && (setItems(r.items), setState("idle")))
      .catch((e) => my === seq.current && (setErr(e instanceof Error ? e.message : String(e)), setState("error")));
  }, [dq, tagId, unclassified, curationStatus, p.version]);

  useEffect(() => {
    if (!localPreviewId || !paneOpen) {
      setPreviewCard(null);
      setPreviewErr("");
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreviewErr("");
    api
      .getCard(localPreviewId)
      .then((c) => {
        if (alive) setPreviewCard(c);
      })
      .catch((e) => {
        if (alive) {
          setPreviewCard(null);
          setPreviewErr(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (alive) setPreviewLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [localPreviewId, paneOpen, p.version]);

  const selectForPreview = (id: string) => {
    setLocalPreviewId(id);
    setPaneOpen(true);
    p.onPreviewCard?.(id);
  };

  const copyPreviewBody = async () => {
    if (!previewCard) return;
    try {
      await navigator.clipboard.writeText(previewCard.body);
      p.info("已複製卡片內文");
    } catch (e) {
      p.report(e, "複製失敗");
    }
  };

  const selectedTag = tagId ? p.tags.find((t) => t.id === tagId) : undefined;
  const label =
    curationStatus === "inbox"
      ? "📥 收件夾（待整理）"
      : unclassified
        ? "未歸檔（無位置）"
        : tagId
          ? tagPath(p.tags, tagId)
          : "";
  return (
    <div className={`search search-split${paneOpen ? " with-preview" : ""}`}>
      <div className="search-upper">
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="關鍵字或標籤別名搜尋卡片"
            aria-label="關鍵字搜尋"
            autoFocus
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className={paneOpen ? "on" : ""}
            onClick={() => setPaneOpen((o) => !o)}
            title="手動開啟或關閉下方卡片內容預覽區"
          >
            {paneOpen ? "▾ 收合預覽" : "▸ 展開預覽"}
          </button>
        </div>
        {selectedTag ? (
          <div className="concept-header-card">
            <div className="concept-header-top">
              <div>
                <strong className="concept-header-title">{selectedTag.name}</strong>
                <div className="muted" style={{ fontSize: 12 }}>
                  {isSameAxisGroup(selectedTag.axis, "location") ? "收納位置" : "概念標籤"}
                  {selectedTag.facet ? ` · ${selectedTag.facet}` : ""} · {items.length} 張卡片
                </div>
              </div>
              <button onClick={p.onClearFilter} title="清除篩選">
                ✕
              </button>
            </div>
            {selectedTag.definition && <div className="concept-header-def">{selectedTag.definition}</div>}
            {selectedTag.aliases && selectedTag.aliases.length > 0 && (
              <div className="muted" style={{ fontSize: 11 }}>
                別名：{selectedTag.aliases.join("、")}
              </div>
            )}
          </div>
        ) : label ? (
          <div className="filter-badge">
            篩選：{label}（{items.length}） <button onClick={p.onClearFilter}>✕</button>
          </div>
        ) : (
          <div className="filter-badge">卡片冊：全部卡片（{items.length}）</div>
        )}
        {state === "error" && <div className="banner danger">搜尋失敗：{err}</div>}
        {state === "idle" && items.length === 0 && <div className="empty">沒有符合的卡片</div>}
        <ul className="results">
          {items.map((c) => {
            const isPreviewed = paneOpen && localPreviewId === c.id;
            const locList = boardLocations.get(c.id);
            const locStr = locList && locList.length > 0 ? locList.join("、") : "（未放入白板）";

            // 分離收納位置（抽屜）與概念標籤
            const locationTags = (c.tags ?? []).filter((t) => isSameAxisGroup(t.axis, "location"));
            const conceptTags = (c.tags ?? []).filter((t) => !isSameAxisGroup(t.axis, "location"));

            const tagParts = [
              c.card_type && c.card_type !== "untyped" ? CARD_TYPE_LABELS[c.card_type] : "",
              ...locationTags.map((t) => `📁 ${tagPath(p.tags, t.id) || t.name}`),
              ...conceptTags.map((t) => (t.facet ? `[${t.facet}] ${t.name}` : t.name)),
            ].filter(Boolean);

            const hasTags = tagParts.length > 0;

            return (
              <li key={c.id} className={isPreviewed ? "previewing-row" : undefined}>
                <button
                  className="result-main"
                  onClick={() => selectForPreview(c.id)}
                  title={`點擊在下方預覽區查看與複製內容\n所在位置：${locStr}${hasTags ? `\n標籤/抽屜：${tagParts.join(" · ")}` : ""}`}
                >
                  <strong>{c.title || "（無標題）"}</strong>
                  <span
                    className="card-meta-line"
                    style={{
                      display: "block",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "clip",
                      minHeight: "1.3em",
                      lineHeight: "1.3",
                      visibility: hasTags ? "visible" : "hidden",
                      maskImage: hasTags ? "linear-gradient(to right, black calc(100% - 24px), transparent 100%)" : "none",
                      WebkitMaskImage: hasTags ? "linear-gradient(to right, black calc(100% - 24px), transparent 100%)" : "none",
                    }}
                  >
                    {hasTags ? tagParts.join(" · ") : "\u00A0"}
                  </span>
                  <span className="snippet">{c.snippet || "\u00A0"}</span>
                </button>
                <button
                  onClick={() => {
                    p.onSelectCard(c.id);
                    if (!p.hideContentTab) p.onTab("content");
                  }}
                  title="跳轉至此卡片進行編輯"
                >
                  編輯
                </button>
                <button onClick={() => p.onAddToBoard(c.id)}>加到白板</button>
              </li>
            );
          })}
        </ul>
      </div>

      {paneOpen && (
        <div className="search-preview-pane" role="region" aria-label="卡片內容預覽區">
          <div className="search-preview-head">
            <strong className="search-preview-title">
              {previewCard ? previewCard.title || "（無標題）" : "卡片內容預覽"}
            </strong>
            <div className="search-preview-actions">
              {previewCard && (
                <>
                  <button type="button" onClick={() => void copyPreviewBody()} title="複製整篇 Markdown 內文">
                    複製內文
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      p.onSelectCard(previewCard.id);
                      if (!p.hideContentTab) p.onTab("content");
                    }}
                    title="跳轉到這張卡片進行編輯"
                  >
                    跳轉編輯此卡
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setPaneOpen(false)}
                aria-label="關閉預覽區"
                title="關閉預覽區"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="search-preview-body">
            {!localPreviewId && (
              <div className="empty">點選上方搜尋結果或內文中的 @ 引用連結，即可在此查看與複製內容。</div>
            )}
            {localPreviewId && previewLoading && <div className="empty">載入預覽中…</div>}
            {localPreviewId && !previewLoading && previewErr && (
              <div className="banner danger">載入預覽失敗：{previewErr}</div>
            )}
            {localPreviewId && !previewLoading && previewCard && (
              <Markdown source={previewCard.body} onOpenCard={selectForPreview} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RelationsTab(props: {
  card: CardDetail;
  onChanged(): void;
  onSelectCard(id: string): void;
  onOpenBoard(id: string): void;
  onLinkAdded?(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  onLinkDeleted?(sourceId: string, targetId: string, relationType?: RelationType): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}) {
  const { card, report } = props;
  const [q, setQ] = useState("");
  const dq = useDebounced(q, 250);
  const [found, setFound] = useState<CardSummary[]>([]);
  const [newRel, setNewRel] = useState<RelationType>("support");
  const [newStatus, setNewStatus] = useState<LinkStatus>("confirmed");
  const [newReason, setNewReason] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editRel, setEditRel] = useState<RelationType>("extend");
  const [editStatus, setEditStatus] = useState<LinkStatus>("confirmed");
  const [editReason, setEditReason] = useState("");

  useEffect(() => {
    if (!dq.trim()) return void setFound([]);
    let alive = true;
    api
      .listCards({ q: dq, limit: 10 })
      .then((r) => alive && setFound(r.items.filter((c) => c.id !== card.id)))
      .catch((e) => alive && report(e, "搜尋失敗"));
    return () => {
      alive = false;
    };
  }, [dq, card.id, report]);

  const link = async (targetId: string) => {
    try {
      const res = await api.putLink(card.id, targetId, {
        relation_type: newRel,
        status: newStatus,
        reason: newReason.trim(),
      });
      setQ("");
      setNewReason("");
      props.onChanged();
      props.onLinkAdded?.(card.id, targetId, res);
    } catch (e) {
      report(e, "建立連結失敗");
    }
  };

  const saveEdit = async (l: CardLink) => {
    const src = l.source_id ?? (l.direction === "incoming" ? l.id : card.id);
    const dst = l.target_id ?? (l.direction === "incoming" ? card.id : l.id);
    const oldRel = l.relation_type ?? "extend";
    try {
      const updated = await api.patchLink(src, dst, {
        old_relation_type: oldRel,
        relation_type: editRel,
        status: editStatus,
        reason: editReason.trim(),
      });
      setEditingKey(null);
      props.onChanged();
      if (oldRel !== editRel) props.onLinkDeleted?.(src, dst, oldRel);
      props.onLinkAdded?.(src, dst, updated);
    } catch (e) {
      report(e, "更新連結失敗");
    }
  };

  const unlink = async (l: CardLink) => {
    const src = l.source_id ?? (l.direction === "incoming" ? l.id : card.id);
    const dst = l.target_id ?? (l.direction === "incoming" ? card.id : l.id);
    const rel = l.relation_type;
    try {
      await api.deleteLink(src, dst, rel);
      props.onChanged();
      props.onLinkDeleted?.(src, dst, rel);
    } catch (e) {
      report(e, "刪除連結失敗");
    }
  };

  return (
    <div className="relations">
      <h4>語意連結（{card.links.length}）</h4>
      {card.links.length === 0 && <div className="muted">還沒有語意連結</div>}
      <ul className="results">
        {card.links.map((l) => {
          const rel = l.relation_type ?? "extend";
          const st = l.status ?? "confirmed";
          const key = `${l.source_id ?? l.id}:${l.target_id ?? card.id}:${rel}`;
          const isEditing = editingKey === key;
          const color = RELATION_COLORS[rel] ?? "#2f6fed";
          return (
            <li key={key} style={{ flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
                <button className="result-main" onClick={() => props.onSelectCard(l.id)}>
                  <div>
                    <span
                      className="facet-badge"
                      style={{ backgroundColor: color, color: "#fff" }}
                    >
                      {l.direction === "incoming" ? `← ${RELATION_LABELS[rel]}` : `→ ${RELATION_LABELS[rel]}`}
                    </span>
                    {st === "hypothesis" && <span className="facet-badge">待驗證假說</span>}
                    <strong>{l.title || "（無標題）"}</strong>
                  </div>
                  {l.reason && <span className="snippet">理由：{l.reason}</span>}
                </button>
                <button
                  onClick={() => {
                    if (isEditing) {
                      setEditingKey(null);
                    } else {
                      setEditingKey(key);
                      setEditRel(rel);
                      setEditStatus(st);
                      setEditReason(l.reason ?? "");
                    }
                  }}
                >
                  {isEditing ? "收合" : "編輯"}
                </button>
                <button aria-label={`刪除與 ${l.title} 的連結`} onClick={() => void unlink(l)}>
                  移除
                </button>
              </div>
              {isEditing && (
                <div className="resolve-box" style={{ marginTop: 2 }}>
                  <div className="field-row">
                    <span className="muted">關係類型與可信度：</span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <select value={editRel} onChange={(e) => setEditRel(e.target.value as RelationType)}>
                        {(Object.entries(RELATION_LABELS) as [RelationType, string][]).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <select value={editStatus} onChange={(e) => setEditStatus(e.target.value as LinkStatus)}>
                        {(Object.entries(LINK_STATUS_LABELS) as [LinkStatus, string][]).map(([k, label]) => (
                          <option key={k} value={k}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="field-row">
                    <span className="muted">連接理由：</span>
                    <input
                      value={editReason}
                      onChange={(e) => setEditReason(e.target.value)}
                      placeholder="說明為何存在此關係"
                    />
                  </div>
                  <div className="resolve-actions">
                    <button className="primary" onClick={() => void saveEdit(l)}>
                      儲存修改
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <h4>新增有向語意連結（此卡片 → 目標卡片）</h4>
      <div className="resolve-box">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <select value={newRel} onChange={(e) => setNewRel(e.target.value as RelationType)} aria-label="新連結關係類型">
            {(Object.entries(RELATION_LABELS) as [RelationType, string][]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <select value={newStatus} onChange={(e) => setNewStatus(e.target.value as LinkStatus)} aria-label="新連結可信度">
            {(Object.entries(LINK_STATUS_LABELS) as [LinkStatus, string][]).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <input
          value={newReason}
          onChange={(e) => setNewReason(e.target.value)}
          placeholder="選填：連接理由（為什麼這張卡片與目標卡片有此關係？）"
        />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜尋目標卡片以建立連結"
          aria-label="搜尋要連結的卡片"
        />
      </div>
      <ul className="results">
        {found.map((c) => (
          <li key={c.id}>
            <span className="result-main">{c.title || "（無標題）"}</span>
            <button className="primary" onClick={() => void link(c.id)}>
              建立「{RELATION_LABELS[newRel]}」
            </button>
          </li>
        ))}
      </ul>
      <h4>所在白板（{card.boards.length}）</h4>
      {card.boards.length === 0 && <div className="muted">不在任何白板上</div>}
      <ul className="results">
        {card.boards.map((b) => (
          <li key={b.id}>
            <button className="result-main" onClick={() => props.onOpenBoard(b.id)}>
              {b.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BoardCardsTab(props: {
  boardId: string | null;
  selectedCardId: string | null;
  version: number;
  onJumpToCard(id: string): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}) {
  const { boardId, selectedCardId, version, onJumpToCard, report, info } = props;
  const [boardData, setBoardData] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [previewCardId, setPreviewCardId] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(true);
  const [previewCard, setPreviewCard] = useState<CardDetail | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewErr, setPreviewErr] = useState("");

  useEffect(() => {
    if (!boardId) {
      setBoardData(null);
      return;
    }
    let alive = true;
    setLoading(true);
    api
      .getBoard(boardId)
      .then((b) => alive && setBoardData(b))
      .catch((e) => alive && report(e, "載入白板卡片清單失敗"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [boardId, version, report]);

  useEffect(() => {
    if (!previewCardId || !paneOpen) {
      setPreviewCard(null);
      setPreviewErr("");
      return;
    }
    let alive = true;
    setPreviewLoading(true);
    setPreviewErr("");
    api
      .getCard(previewCardId)
      .then((c) => alive && setPreviewCard(c))
      .catch((e) => alive && setPreviewErr(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setPreviewLoading(false));
    return () => {
      alive = false;
    };
  }, [previewCardId, paneOpen, version]);

  const copyPreviewBody = async () => {
    if (!previewCard) return;
    try {
      await navigator.clipboard.writeText(previewCard.body);
      info("已複製卡片內文");
    } catch (e) {
      report(e, "複製失敗");
    }
  };

  if (!boardId) {
    return <div className="empty">尚未選取任何白板。</div>;
  }

  const cards: BoardCard[] = boardData?.cards ?? [];
  const q = filterText.trim().toLowerCase();
  const filtered: BoardCard[] = q
    ? cards.filter((c: BoardCard) => (c.title || "").toLowerCase().includes(q) || (c.body || "").toLowerCase().includes(q))
    : cards;

  return (
    <div className={`search search-split${paneOpen ? " with-preview" : ""}`}>
      <div className="search-upper">
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="搜尋此白板內的卡片…"
            aria-label="搜尋此白板卡片"
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className={paneOpen ? "on" : ""}
            onClick={() => setPaneOpen((o) => !o)}
            title="開啟或收合下方預覽區"
          >
            {paneOpen ? "▾ 收合預覽" : "▸ 展開預覽"}
          </button>
        </div>

        <div className="filter-badge" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>白板「{boardData?.name || ""}」：{cards.length} 張卡片</span>
          <span className="muted" style={{ fontSize: 11 }}>雙擊卡片跳轉編輯</span>
        </div>

        {loading && <div className="empty">載入白板卡片中…</div>}
        {!loading && filtered.length === 0 && <div className="empty">此白板尚無符合的卡片</div>}

        <ul className="results">
          {filtered.map((c: BoardCard) => {
            const isEditing = c.card_id === selectedCardId;
            const isPreviewed = paneOpen && previewCardId === c.card_id;
            return (
              <li
                key={c.card_id}
                className={isPreviewed ? "previewing-row" : undefined}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  onJumpToCard(c.card_id);
                }}
                title="單擊下方預覽，雙擊立即跳轉中央編輯"
              >
                <button
                  type="button"
                  className="result-main"
                  onClick={() => {
                    setPreviewCardId(c.card_id);
                    setPaneOpen(true);
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {isEditing && (
                      <span className="facet-badge" style={{ background: "var(--accent)", color: "#fff" }}>
                        編輯中
                      </span>
                    )}
                    <strong>{c.title || "（無標題）"}</strong>
                  </div>
                  <span className="snippet">{c.body.slice(0, 160)}</span>
                </button>
                <button
                  type="button"
                  className={isEditing ? "primary" : ""}
                  onClick={() => onJumpToCard(c.card_id)}
                  title="將中央面板切換至此卡片編輯"
                >
                  {isEditing ? "當前" : "跳轉"}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {paneOpen && (
        <div className="search-preview-pane" role="region" aria-label="白板卡片內容預覽區">
          <div className="search-preview-head">
            <strong className="search-preview-title">
              {previewCard ? previewCard.title || "（無標題）" : "卡片內容預覽"}
            </strong>
            <div className="search-preview-actions">
              {previewCard && (
                <>
                  <button type="button" onClick={() => void copyPreviewBody()} title="複製整篇 Markdown 內文">
                    複製內文
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => onJumpToCard(previewCard.id)}
                    title="跳轉中央編輯此卡"
                  >
                    跳轉編輯此卡
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={() => setPaneOpen(false)}
                aria-label="關閉預覽區"
                title="關閉預覽區"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="search-preview-body">
            {!previewCardId && (
              <div className="empty">單擊上方卡片即可在此預覽與複製文字，雙擊卡片可直接跳轉編輯。</div>
            )}
            {previewCardId && previewLoading && <div className="empty">載入預覽中…</div>}
            {previewCardId && !previewLoading && previewErr && (
              <div className="banner danger">載入預覽失敗：{previewErr}</div>
            )}
            {previewCardId && !previewLoading && previewCard && (
              <Markdown source={previewCard.body} onOpenCard={(id) => setPreviewCardId(id)} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
