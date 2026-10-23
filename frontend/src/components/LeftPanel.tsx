// @depends-on ./SyncModal.tsx (SyncModal)
// @depends-on ../lib/storage/index.ts (getPreferredDriverType)
import { useState } from "react";
import { api } from "../api";
import { getPreferredDriverType } from "../lib/storage";
import { buildTree, descendantIds, isSameAxisGroup, tagPath, type TreeNode } from "../lib/tree";
import type { Axis, BoardSummary, CleanupResult, Tag } from "../types";
import { FacetPicker } from "./FacetPicker";
import type { Filter } from "./RightPanel";
import { SyncModal } from "./SyncModal";

interface Props {
  boards: BoardSummary[];
  boardId: string | null;
  tags: Tag[];
  unclassifiedCount: number;
  inboxCount?: number;
  filter: Filter;
  isSearchTab?: boolean;
  theme: "dark" | "light";
  onToggleTheme(): void;
  onToggleCollapse(): void;
  onSelectBoard(id: string): void;
  onBoardsChanged(): void;
  onFilter(f: Filter): void;
  onTagsChanged(): void;
  report(e: unknown, prefix?: string): void;
}

const AXIS_LABEL: Record<Axis, string> = {
  location: "收納位置（櫃子／抽屜）",
  domain: "收納位置（櫃子／抽屜）",
  type: "類型",
  concept: "概念標籤（描述維度）",
  free: "概念標籤（描述維度）",
};

export function LeftPanel(p: Props) {
  const [moving, setMoving] = useState<Tag | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [mergingTag, setMergingTag] = useState<Tag | null>(null);
  const [dragging, setDragging] = useState<Tag | null>(null);
  const [cleanup, setCleanup] = useState<CleanupResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const run = async (fn: () => Promise<unknown>, prefix: string) => {
    try {
      await fn();
    } catch (e) {
      p.report(e, prefix);
    }
  };

  // ---- 白板 ----
  const newBoard = () =>
    run(async () => {
      const name = window.prompt("新白板名稱");
      if (!name?.trim()) return;
      const b = await api.createBoard(name.trim());
      p.onBoardsChanged();
      p.onSelectBoard(b.id);
    }, "建立白板失敗");
  const renameBoard = (b: BoardSummary) =>
    run(async () => {
      const name = window.prompt("白板新名稱", b.name);
      if (!name?.trim() || name.trim() === b.name) return;
      await api.renameBoard(b.id, name.trim());
      p.onBoardsChanged();
    }, "改名失敗");
  const deleteBoard = (b: BoardSummary) =>
    run(async () => {
      if (!window.confirm(`刪除白板「${b.name}」？\n只會刪除白板與卡片的擺放位置，卡片本身不會被刪除。`)) return;
      await api.deleteBoard(b.id);
      p.onBoardsChanged();
    }, "刪除白板失敗");

  // ---- 標籤 ----
  const createTag = (axis: Axis, parent: Tag | null) =>
    run(async () => {
      const name = window.prompt(parent ? `在「${parent.name}」底下新增` : `新增${AXIS_LABEL[axis]}`);
      if (!name?.trim()) return;
      await api.createTag(name.trim(), axis, parent?.id ?? null);
      p.onTagsChanged();
    }, "新增標籤失敗");
  const renameTag = (t: Tag) =>
    run(async () => {
      const name = window.prompt("新名稱", t.name);
      if (!name?.trim() || name.trim() === t.name) return;
      await api.patchTag(t.id, { name: name.trim() });
      p.onTagsChanged();
    }, "改名失敗");
  const deleteTag = (t: Tag) =>
    run(async () => {
      const plan = await api.deletePreview(t.id);
      if (plan.conflicts.length) {
        window.alert(`無法刪除：子標籤上移後會與同層標籤同名（${plan.conflicts.join("、")}）。請先改名再刪除。`);
        return;
      }
      const lines = [`刪除「${tagPath(p.tags, t.id)}」？`];
      if (plan.child_count)
        lines.push(`・${plan.child_count} 個子抽屜會上移到${plan.new_parent ? `「${plan.new_parent.name}」底下` : "最上層"}`);
      if (plan.card_count)
        lines.push(
          plan.new_parent
            ? `・${plan.card_count} 張卡片會改歸屬到「${plan.new_parent.name}」`
            : `・${plan.card_count} 張卡片會移除這個歸屬（卡片本身不會被刪除；沒有其他領域歸屬的會變成未分類）`,
        );
      if (!window.confirm(lines.join("\n"))) return;
      await api.deleteTag(t.id);
      if (p.filter.tagId === t.id) p.onFilter({});
      p.onTagsChanged();
    }, "刪除標籤失敗");
  const moveTag = (t: Tag, parentId: string | null) =>
    run(async () => {
      if (t.parent_id === parentId) {
        setMoving(null);
        return;
      }
      await api.patchTag(t.id, { parent_id: parentId });
      setMoving(null);
      p.onTagsChanged();
    }, "移動失敗");

  const isFlat = (a: Axis) => a === "free" || a === "concept";

  const canDropOn = (dragged: Tag | null, target: Tag | null, axis: Axis): boolean => {
    if (!dragged || !isSameAxisGroup(dragged.axis, axis) || isFlat(axis)) return false;
    if (target === null) return dragged.parent_id !== null;
    if (dragged.id === target.id || dragged.parent_id === target.id) return false;
    return !descendantIds(p.tags, dragged.id).has(target.id);
  };

  const handleDrop = (target: Tag | null, axis: Axis, rawId?: string) => {
    const dragged = dragging ?? p.tags.find((t) => t.id === rawId) ?? null;
    setDragging(null);
    if (!dragged) return;
    if (!isSameAxisGroup(dragged.axis, axis)) {
      p.report(new Error("不能跨軸移動標籤"), "移動失敗");
      return;
    }
    if (target && descendantIds(p.tags, dragged.id).has(target.id)) {
      p.report(new Error("不能把標籤移到自己或自己的後代底下"), "移動失敗");
      return;
    }
    const newParentId = target ? target.id : null;
    if (dragged.parent_id === newParentId) return;
    void moveTag(dragged, newParentId);
  };

  // ---- 孤兒媒體清理 ----
  const openCleanup = () =>
    run(async () => {
      const res = await api.cleanupMedia(true);
      setCleanup(res);
    }, "檢查孤兒媒體失敗");

  const confirmCleanup = () =>
    run(async () => {
      setCleaning(true);
      try {
        const res = await api.cleanupMedia(false);
        setCleanup(res);
      } finally {
        setCleaning(false);
      }
    }, "清理孤兒媒體失敗");

  return (
    <nav className="left" aria-label="路徑與功能">
      <div className="left-header">
        <span className="left-header-title">白板筆記</span>
        <div className="left-header-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={p.onToggleTheme}
            aria-label={p.theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
            title={p.theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
          >
            {p.theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={p.onToggleCollapse}
            aria-label="收納左側面板"
            title="收納左側面板"
          >
            ◀
          </button>
        </div>
      </div>

      <section>
        <div className="section-head">
          <h3>白板</h3>
          <button onClick={() => void newBoard()} aria-label="新增白板">
            ＋
          </button>
        </div>
        {p.boards.length === 0 && <div className="muted pad">還沒有白板</div>}
        <ul className="plain">
          {p.boards.map((b) => (
            <li key={b.id} className={`row${b.id === p.boardId ? " on" : ""}`}>
              <button className="label" onClick={() => p.onSelectBoard(b.id)}>
                {b.name} <span className="count">{b.card_count}</span>
              </button>
              <span className="actions">
                <button onClick={() => void renameBoard(b)} aria-label={`重新命名 ${b.name}`}>
                  ✎
                </button>
                <button onClick={() => void deleteBoard(b)} aria-label={`刪除白板 ${b.name}`}>
                  ✕
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="section-head">
          <h3>卡片冊</h3>
        </div>
        <div
          className={`row${
            p.isSearchTab && !p.filter.unclassified && !p.filter.tagId && !p.filter.curationStatus ? " on" : ""
          }`}
        >
          <button className="label" onClick={() => p.onFilter({})}>
            全部卡片
          </button>
        </div>
        <div className={`row${p.filter.curationStatus === "inbox" ? " on" : ""}`}>
          <button className="label" onClick={() => p.onFilter({ curationStatus: "inbox" })}>
            📥 收件夾（待整理） <span className="count">{p.inboxCount ?? 0}</span>
          </button>
        </div>
        <div className={`row${p.filter.unclassified ? " on" : ""}`}>
          <button className="label" onClick={() => p.onFilter({ unclassified: true })}>
            未歸檔（無位置） <span className="count">{p.unclassifiedCount}</span>
          </button>
        </div>
      </section>

      <section>
        <div
          className="section-head"
          onDragOver={(e) => {
            if (canDropOn(dragging, null, "location")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(null, "location", e.dataTransfer.getData("text/plain"));
          }}
          title="將子抽屜拖曳至此處可移回最上層"
        >
          <h3>收納位置（櫃子／抽屜）</h3>
          <button onClick={() => void createTag("location", null)} aria-label="新增櫃子">
            ＋櫃子
          </button>
        </div>
        <Tree
          nodes={buildTree(p.tags, "location")}
          axis="location"
          filter={p.filter}
          dragging={dragging}
          canDropOn={canDropOn}
          onDragStartTag={setDragging}
          onDragEndTag={() => setDragging(null)}
          onDropTag={handleDrop}
          onFilter={p.onFilter}
          onAdd={(t) => void createTag(t.axis, t)}
          onRename={(t) => void renameTag(t)}
          onEditMeta={setEditingTag}
          onMerge={setMergingTag}
          onMove={setMoving}
          onDelete={(t) => void deleteTag(t)}
        />
      </section>

      <details open>
        <summary>
          {AXIS_LABEL.concept}
          <button
            className="add"
            onClick={(e) => (e.preventDefault(), void createTag("concept", null))}
            aria-label="新增概念標籤"
          >
            ＋
          </button>
        </summary>
        <Tree
          nodes={buildTree(p.tags, "concept")}
          axis="concept"
          filter={p.filter}
          dragging={dragging}
          canDropOn={canDropOn}
          onDragStartTag={setDragging}
          onDragEndTag={() => setDragging(null)}
          onDropTag={handleDrop}
          onFilter={p.onFilter}
          onAdd={(t) => void createTag(t.axis, t)}
          onRename={(t) => void renameTag(t)}
          onEditMeta={setEditingTag}
          onMerge={setMergingTag}
          onMove={setMoving}
          onDelete={(t) => void deleteTag(t)}
          canNest={false}
        />
      </details>

      <section>
        <div className="section-head">
          <h3>資料維護與同步</h3>
          <div style={{ display: "flex", gap: 4 }}>
            <button onClick={() => setSyncOpen(true)} aria-label="資料同步與備份">
              同步／備份
            </button>
            {getPreferredDriverType() !== "dexie" && (
              <button onClick={() => void openCleanup()} aria-label="清理孤兒媒體">
                孤兒媒體
              </button>
            )}
          </div>
        </div>
      </section>

      {syncOpen && (
        <SyncModal
          onClose={() => setSyncOpen(false)}
          onApplied={() => {
            p.onTagsChanged();
            p.onBoardsChanged();
          }}
          report={p.report}
          info={(text) => p.report(null, text)}
        />
      )}

      {moving && <MoveDialog tag={moving} tags={p.tags} onCancel={() => setMoving(null)} onMove={(id) => void moveTag(moving, id)} />}
      {editingTag && (
        <TagMetaDialog
          tag={p.tags.find((x) => x.id === editingTag.id) ?? editingTag}
          onClose={() => setEditingTag(null)}
          onChanged={p.onTagsChanged}
          report={p.report}
        />
      )}
      {mergingTag && (
        <MergeTagDialog
          source={mergingTag}
          tags={p.tags}
          onClose={() => setMergingTag(null)}
          onMerged={() => {
            if (p.filter.tagId === mergingTag.id) p.onFilter({});
            setMergingTag(null);
            p.onTagsChanged();
          }}
          report={p.report}
        />
      )}
      {cleanup && (
        <CleanupDialog
          result={cleanup}
          cleaning={cleaning}
          onClose={() => setCleanup(null)}
          onConfirm={() => void confirmCleanup()}
        />
      )}
    </nav>
  );
}

function Tree(props: {
  nodes: TreeNode[];
  axis: Axis;
  filter: Filter;
  dragging: Tag | null;
  canDropOn(dragged: Tag | null, target: Tag | null, axis: Axis): boolean;
  onDragStartTag(t: Tag): void;
  onDragEndTag(): void;
  onDropTag(target: Tag | null, axis: Axis, rawId?: string): void;
  onFilter(f: Filter): void;
  onAdd(t: Tag): void;
  onRename(t: Tag): void;
  onEditMeta(t: Tag): void;
  onMerge(t: Tag): void;
  onMove(t: Tag): void;
  onDelete(t: Tag): void;
  canNest?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const nest = props.canNest !== false;
  return (
    <ul className="plain tree">
      {props.nodes.map((n) => (
        <li key={n.tag.id}>
          <div
            className={`row${props.filter.tagId === n.tag.id ? " on" : ""}`}
            draggable={nest}
            onDragStart={(e) => {
              if (!nest) return;
              e.stopPropagation();
              e.dataTransfer.setData("text/plain", n.tag.id);
              e.dataTransfer.effectAllowed = "move";
              props.onDragStartTag(n.tag);
            }}
            onDragEnd={() => props.onDragEndTag()}
            onDragOver={(e) => {
              if (!nest) return;
              if (!props.dragging || props.canDropOn(props.dragging, n.tag, props.axis)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(e) => {
              if (!nest) return;
              e.preventDefault();
              e.stopPropagation();
              props.onDropTag(n.tag, props.axis, e.dataTransfer.getData("text/plain"));
            }}
          >
            {n.children.length > 0 ? (
              <button className="twisty" onClick={() => toggle(n.tag.id)} aria-label={collapsed.has(n.tag.id) ? "展開" : "收合"}>
                {collapsed.has(n.tag.id) ? "▸" : "▾"}
              </button>
            ) : (
              <span className="twisty" />
            )}
            <button
              className="label"
              onClick={() => props.onFilter({ tagId: n.tag.id })}
              title={
                [
                  n.tag.facet ? `維度：${n.tag.facet}` : "",
                  n.tag.definition ? `定義：${n.tag.definition}` : "",
                  n.tag.aliases?.length ? `別名：${n.tag.aliases.join("、")}` : "",
                ]
                  .filter(Boolean)
                  .join("\n") || undefined
              }
            >
              {n.tag.facet && <span className="facet-badge">{n.tag.facet}</span>}
              {n.tag.name}
              {n.tag.aliases && n.tag.aliases.length > 0 && (
                <span className="count" title={`別名：${n.tag.aliases.join("、")}`}>
                  +{n.tag.aliases.length}
                </span>
              )}
            </button>
            <span className="actions">
              {nest && (
                <button onClick={() => props.onAdd(n.tag)} aria-label={`在 ${n.tag.name} 底下新增`} title="新增子項目">
                  ＋
                </button>
              )}
              <button onClick={() => props.onEditMeta(n.tag)} aria-label={`設定 ${n.tag.name} 維度與別名`} title="設定維度、定義與別名">
                ⚙
              </button>
              <button onClick={() => props.onMerge(n.tag)} aria-label={`合併 ${n.tag.name}`} title="合併至其他同軸標籤">
                ⇄
              </button>
              <button onClick={() => props.onRename(n.tag)} aria-label={`重新命名 ${n.tag.name}`} title="重新命名">
                ✎
              </button>
              {nest && (
                <button onClick={() => props.onMove(n.tag)} aria-label={`移動 ${n.tag.name}`} title="移動">
                  ↗
                </button>
              )}
              <button onClick={() => props.onDelete(n.tag)} aria-label={`刪除 ${n.tag.name}`} title="刪除">
                ✕
              </button>
            </span>
          </div>
          {n.children.length > 0 && !collapsed.has(n.tag.id) && <Tree {...props} nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

function MoveDialog(props: { tag: Tag; tags: Tag[]; onCancel(): void; onMove(parentId: string | null): void }) {
  const banned = descendantIds(props.tags, props.tag.id);
  const options = props.tags.filter((t) => isSameAxisGroup(t.axis, props.tag.axis) && !banned.has(t.id));
  const [value, setValue] = useState<string>(props.tag.parent_id ?? "");
  return (
    <div className="modal" role="dialog" aria-label="移動標籤">
      <div className="modal-card">
        <h4>移動「{props.tag.name}」</h4>
        <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="新的父節點">
          <option value="">（最上層）</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {tagPath(props.tags, t.id)}
            </option>
          ))}
        </select>
        <div className="modal-actions">
          <button onClick={props.onCancel}>取消</button>
          <button className="primary" onClick={() => props.onMove(value || null)}>
            移動
          </button>
        </div>
      </div>
    </div>
  );
}

function TagMetaDialog(props: {
  tag: Tag;
  onClose(): void;
  onChanged(): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { tag, onClose, onChanged, report } = props;
  const [facet, setFacet] = useState(tag.facet ?? "");
  const [definition, setDefinition] = useState(tag.definition ?? "");
  const [newAlias, setNewAlias] = useState("");
  const isConcept = isSameAxisGroup(tag.axis, "concept");

  const saveMeta = async () => {
    try {
      await api.patchTag(tag.id, {
        facet: isConcept ? facet.trim() || null : null,
        definition: definition.trim(),
      });
      onChanged();
      onClose();
    } catch (e) {
      report(e, "儲存標籤屬性失敗");
    }
  };

  const addAlias = async () => {
    const a = newAlias.trim();
    if (!a) return;
    try {
      await api.addTagAlias(tag.id, a);
      setNewAlias("");
      onChanged();
    } catch (e) {
      report(e, "新增別名失敗");
    }
  };

  const removeAlias = async (a: string) => {
    try {
      await api.removeTagAlias(tag.id, a);
      onChanged();
    } catch (e) {
      report(e, "刪除別名失敗");
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="標籤定義與別名">
      <div className="modal-card" style={{ minWidth: 360 }}>
        <h4>標籤設定：「{tag.name}」</h4>
        {isConcept && <FacetPicker value={facet} onChange={setFacet} />}
        <label className="field-row">
          <span className="muted">簡短定義（協助區分一詞多義）：</span>
          <textarea
            rows={2}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder="定義這個概念的邊界與判斷標準"
          />
        </label>
        <div className="field-row">
          <span className="muted">同義詞／別名（輸入別名時會自動指向此標籤）：</span>
          <div className="chips">
            {(tag.aliases ?? []).length === 0 && <span className="muted">尚無別名</span>}
            {(tag.aliases ?? []).map((a) => (
              <span key={a} className="chip free">
                {a}
                <button onClick={() => void removeAlias(a)} aria-label={`移除別名 ${a}`}>
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="tag-pick">
            <input
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addAlias()}
              placeholder="輸入新別名後按加入"
            />
            <button onClick={() => void addAlias()}>＋別名</button>
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>關閉</button>
          <button className="primary" onClick={() => void saveMeta()}>
            儲存設定
          </button>
        </div>
      </div>
    </div>
  );
}

function MergeTagDialog(props: {
  source: Tag;
  tags: Tag[];
  onClose(): void;
  onMerged(): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { source, tags, onClose, onMerged, report } = props;
  const banned = descendantIds(tags, source.id);
  const candidates = tags.filter((t) => isSameAxisGroup(t.axis, source.axis) && !banned.has(t.id));
  const [targetId, setTargetId] = useState(candidates[0]?.id ?? "");

  const confirmMerge = async () => {
    if (!targetId) return;
    const target = tags.find((t) => t.id === targetId);
    if (
      !window.confirm(
        `確定要將「${source.name}」合併至「${target?.name ?? ""}」嗎？\n` +
          `・所有套用「${source.name}」的卡片將自動改歸屬至「${target?.name ?? ""}」\n` +
          `・「${source.name}」及其別名將自動保留為「${target?.name ?? ""}」的別名`,
      )
    )
      return;
    try {
      await api.mergeTag(source.id, targetId);
      onMerged();
    } catch (e) {
      report(e, "合併標籤失敗");
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="合併標籤">
      <div className="modal-card" style={{ minWidth: 340 }}>
        <h4>合併重複標籤：「{source.name}」</h4>
        <p className="muted" style={{ margin: 0 }}>
          將此標籤併入目標標籤後，原名稱「{source.name}」會自動轉為目標標籤的別名，既有卡片不需手動重貼。
        </p>
        {candidates.length === 0 ? (
          <p className="muted">目前沒有其他同軸標籤可供合併。</p>
        ) : (
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="目標正式標籤">
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.facet ? `[${t.facet}] ` : ""}
                {tagPath(tags, t.id)}
              </option>
            ))}
          </select>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          {candidates.length > 0 && (
            <button className="primary" onClick={() => void confirmMerge()}>
              確認合併
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CleanupDialog(props: {
  result: CleanupResult;
  cleaning: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  const { result, cleaning, onClose, onConfirm } = props;
  return (
    <div className="modal" role="dialog" aria-label="清理孤兒媒體">
      <div className="modal-card">
        <h4>{result.dry_run ? "孤兒媒體清理預覽" : "孤兒媒體清理完成"}</h4>
        {result.orphans.length === 0 ? (
          <p className="muted">
            {result.dry_run
              ? "目前沒有需要清理的孤兒媒體（建立未滿 24 小時的檔案會自動略過）。"
              : "已無孤兒媒體。"}
          </p>
        ) : (
          <div>
            <p>
              {result.dry_run
                ? `找到 ${result.orphans.length} 個未被任何卡片內文引用（且建立超過 24 小時）的媒體檔案：`
                : `已刪除 ${result.orphans.length} 個孤兒媒體檔案：`}
            </p>
            <ul className="plain">
              {result.orphans.map((o) => (
                <li key={o.id} className="muted">
                  {o.rel_path}（{Math.max(1, Math.round(o.byte_size / 1024))} KB）
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.stray_files.length > 0 && (
          <div>
            <p>磁碟上有檔案但資料庫無紀錄（僅列出，不自動刪除）：</p>
            <ul className="plain">
              {result.stray_files.map((f) => (
                <li key={f} className="muted">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={cleaning}>
            關閉
          </button>
          {result.dry_run && result.orphans.length > 0 && (
            <button className="primary" onClick={onConfirm} disabled={cleaning}>
              {cleaning ? "清理中…" : `確認刪除（${result.orphans.length}）`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
