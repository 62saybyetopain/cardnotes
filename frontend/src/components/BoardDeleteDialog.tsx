// @depends-on ../api.ts (boardDeletePreview／deleteBoard)
// @depends-on 後端 boards.py::delete_board（children／keep_record／reason 的語意與驗證都在後端；這裡只負責讓使用者選，不重複判斷規則）
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BoardChildrenMode, BoardContents, BoardDeletePreview } from "../types";

interface Props {
  boardId: string;
  onClose(): void;
  onDone(): void;
  report(e: unknown, prefix?: string): void;
}

const hasContents = (c: BoardContents) => c.cards + c.literatures + c.notes + c.groups > 0;

// 卡片與文獻本體永遠不會被刪；靈感筆記的文字與分組框只存在這塊白板，永久刪除後就沒了
function ContentsLine({ c }: { c: BoardContents }) {
  if (!hasContents(c)) return <span className="muted">（空白）</span>;
  return (
    <span className="muted">
      卡片 {c.cards}・文獻 {c.literatures}・靈感筆記 {c.notes}・分組框 {c.groups}
    </span>
  );
}

export function BoardDeleteDialog({ boardId, onClose, onDone, report }: Props) {
  const [plan, setPlan] = useState<BoardDeletePreview | null>(null);
  const [children, setChildren] = useState<BoardChildrenMode>("subtree");
  const [keepRecord, setKeepRecord] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .boardDeletePreview(boardId)
      .then((r) => {
        if (alive) setPlan(r);
      })
      .catch((e) => {
        report(e, "載入刪除預覽失敗");
        onClose();
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardId]);

  if (!plan) return null;

  const direct = plan.descendants.filter((d) => d.depth === 1);
  const hasKids = plan.descendants.length > 0;
  // 已封存的只能永久刪除；一般白板本身永遠是永久刪除（但可以封存它底下的問題）
  const canKeep = !plan.archived && (plan.is_question || hasKids);
  const canPromote = plan.is_question && !plan.archived && direct.length > 0;
  const mode: BoardChildrenMode = hasKids ? children : "block";
  const keeping = canKeep && keepRecord;
  // 這次會永久消失的「無法由別處找回」的內容：靈感筆記與分組框只存在白板自己身上。
  // 提升一級時子問題都還在；封存時全部原封不動，所以只有「永久刪除」才需要警告
  const lostHere = (c: BoardContents) => c.notes + c.groups;
  const losing = keeping
    ? 0
    : lostHere(plan.contents) + (mode === "promote" ? 0 : plan.descendants.reduce((n, d) => n + lostHere(d.contents), 0));

  const submit = async () => {
    setBusy(true);
    try {
      await api.deleteBoard(plan.id, {
        children: mode,
        keep_record: keeping,
        reason: keeping ? reason.trim() : undefined,
      });
      onDone();
    } catch (e) {
      report(e, "刪除失敗");
    } finally {
      setBusy(false);
    }
  };

  const title = plan.archived ? "永久刪除已封存的問題" : plan.is_question ? "刪除問題" : "刪除白板";

  return (
    <div className="modal" role="dialog" aria-label={title}>
      <div className="modal-card" style={{ minWidth: 380, maxWidth: 520 }}>
        <h4>
          {title}：「{plan.name}」
        </h4>
        <p style={{ margin: "4px 0" }}>
          這塊白板本身：<ContentsLine c={plan.contents} />
        </p>
        <p className="muted" style={{ margin: "4px 0", fontSize: 12 }}>
          卡片與文獻本身不會被刪除，只會移除它們在這塊白板上的位置，並失去「屬於這個問題」的歸屬紀錄。
        </p>

        {hasKids && (
          <div className="field-row">
            <span>
              底下還有 {plan.descendants.length} 個問題白板
              {plan.archived ? "（已封存）" : ""}：
            </span>
            <ul className="plain" style={{ margin: "4px 0", maxHeight: 160, overflowY: "auto" }}>
              {plan.descendants.map((d) => (
                <li key={d.id} style={{ paddingLeft: (d.depth - 1) * 14, fontSize: 13 }}>
                  {d.name} <ContentsLine c={d.contents} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {hasKids && canPromote && (
          <div className="field-row" role="radiogroup" aria-label="子問題的處理方式">
            <label>
              <input type="radio" name="children" checked={children === "subtree"} onChange={() => setChildren("subtree")} />
              連同底下全部 {plan.descendants.length} 個一起處理
            </label>
            <label>
              <input type="radio" name="children" checked={children === "promote"} onChange={() => setChildren("promote")} />
              只處理這一個；{direct.length} 個直接子問題提升一級（改掛到上一層，排在原位置）
            </label>
          </div>
        )}

        {canKeep && (
          <div className="field-row" role="radiogroup" aria-label="要不要留下紀錄">
            <label>
              <input type="radio" name="keep" checked={!keepRecord} onChange={() => setKeepRecord(false)} />
              永久刪除
            </label>
            <label>
              <input type="radio" name="keep" checked={keepRecord} onChange={() => setKeepRecord(true)} />
              {plan.is_question
                ? "封存，留下紀錄（內容原封不動，只是離開路徑樹；之後可在「已封存的問題」查看或永久刪除）"
                : "封存底下的問題，留下紀錄（這塊白板本身仍會被刪除；問題的內容原封不動，之後可在「已封存的問題」查看或永久刪除）"}
            </label>
            {keepRecord && (
              <input
                value={reason}
                maxLength={500}
                onChange={(e) => setReason(e.target.value)}
                placeholder="刪除原因（選填）"
                aria-label="刪除原因"
              />
            )}
          </div>
        )}

        {losing > 0 && (
          <p style={{ margin: "4px 0", color: "var(--danger, #f87171)", fontSize: 12 }}>
            永久刪除後，將有 {losing} 個靈感筆記與分組框消失，無法復原。
          </p>
        )}

        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "處理中…" : keeping ? "封存" : "永久刪除"}
          </button>
        </div>
      </div>
    </div>
  );
}