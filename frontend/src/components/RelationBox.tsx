// @depends-on ../api.ts (api)
// @depends-on ../lib/storage/index.ts (getPreferredDriverType)
// @depends-on ../lib/tree.ts (isSameAxisGroup)
// @depends-on ../types.ts (PATTERN_FAMILIES, PATTERN_FAMILY_GUIDES, PatternFamily, CardDetail, CardRelation, RelationPattern, RelationsReport, Tag)
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { getPreferredDriverType } from "../lib/storage";
import { isSameAxisGroup } from "../lib/tree";
import {
  PATTERN_FAMILIES,
  PATTERN_FAMILY_GUIDES,
  type CardDetail,
  type CardRelation,
  type PatternFamily,
  type RelationPattern,
  type RelationsReport,
  type Tag,
} from "../types";

interface Props {
  card: CardDetail;
  tags: Tag[];
  onAssignBridgeTag(tagId: string, note?: string): Promise<void>;
  onSelectCard?(cardId: string): void;
  report(e: unknown, prefix?: string): void;
  info?(text: string): void;
}

function renderTemplatePreview(template: string, roleA: string, roleB: string, result: string): string {
  return template
    .replace(/\{A\}/g, roleA.trim() || "【A】")
    .replace(/\{B\}/g, roleB.trim() || "【B】")
    .replace(/\{結果\}/g, result.trim() || "【結果】");
}

// 後端回傳不認得的家族值時一律當成未分類，不會讓句型從畫面上消失
function normalizeFamily(f: string | null | undefined): PatternFamily | null {
  return (PATTERN_FAMILIES as readonly string[]).includes(f ?? "") ? (f as PatternFamily) : null;
}

function familyName(f: string | null | undefined): string {
  const fam = normalizeFamily(f);
  return fam ? PATTERN_FAMILY_GUIDES[fam].name : "未分類";
}

export function RelationBox(props: Props) {
  const { card, tags, onAssignBridgeTag, onSelectCard, report, info } = props;
  const isDexie = getPreferredDriverType() === "dexie";

  const [patterns, setPatterns] = useState<RelationPattern[]>([]);
  const [savedRel, setSavedRel] = useState<CardRelation | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [saving, setSaving] = useState(false);

  // 表單欄位狀態
  const [patternId, setPatternId] = useState<string>("");
  const [roleA, setRoleA] = useState("");
  const [roleB, setRoleB] = useState("");
  const [result, setResult] = useState("");
  const [freeSentence, setFreeSentence] = useState("");

  // 子對話框開關
  const [manageOpen, setManageOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideFamily, setGuideFamily] = useState<PatternFamily | "none" | null>(null);

  const syncFormFromRelation = useCallback((rel: CardRelation | null) => {
    setSavedRel(rel);
    setPatternId(rel?.pattern_id ?? "");
    setRoleA(rel?.role_a ?? "");
    setRoleB(rel?.role_b ?? "");
    setResult(rel?.result ?? "");
    setFreeSentence(rel?.free_sentence ?? "");
  }, []);

  const loadData = useCallback(async () => {
    if (isDexie) return;
    setLoading(true);
    setLoadErr("");
    try {
      const [pRes, rRes] = await Promise.all([
        api.listRelationPatterns(),
        api.getCardRelation(card.id),
      ]);
      setPatterns(Array.isArray(pRes?.patterns) ? pRes.patterns : []);
      syncFormFromRelation(rRes?.relation ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLoadErr(msg);
      report(e, "載入關係句型資料失敗");
    } finally {
      setLoading(false);
    }
  }, [card.id, isDexie, report, syncFormFromRelation]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const selectedPattern = useMemo(
    () => patterns.find((p) => p.id === patternId) ?? null,
    [patterns, patternId],
  );

  const hasBridgeTagOnCard = useMemo(() => {
    if (!selectedPattern) return false;
    return card.tags.some((t) => t.id === selectedPattern.bridge_tag_id);
  }, [card.tags, selectedPattern]);

  const patternsByFamily = useMemo(() => {
    const map = new Map<PatternFamily | "none", RelationPattern[]>();
    for (const p of patterns) {
      const key = normalizeFamily(p.family) ?? "none";
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    return map;
  }, [patterns]);

  const closeGuide = () => {
    setGuideOpen(false);
    setGuideFamily(null);
  };
  const pickFromGuide = (id: string) => {
    setPatternId(id);
    closeGuide();
  };
  const pickFreeSentence = () => pickFromGuide("");

  if (isDexie) {
    return null;
  }

  const saveRelation = async (andAssignTag: boolean) => {
    setSaving(true);
    try {
      const pid = patternId.trim() ? patternId.trim() : null;
      const res = await api.putCardRelation(card.id, {
        pattern_id: pid,
        role_a: roleA,
        role_b: roleB,
        result,
        free_sentence: pid === null ? freeSentence : "",
      });
      syncFormFromRelation(res?.relation ?? null);
      const pList = await api.listRelationPatterns();
      setPatterns(Array.isArray(pList?.patterns) ? pList.patterns : []);

      if (andAssignTag && selectedPattern) {
        await onAssignBridgeTag(
          selectedPattern.bridge_tag_id,
          `已儲存關係句紀錄並套用橋樑詞「${selectedPattern.bridge_name}」`,
        );
      } else {
        info?.(pid ? "已儲存關係句紀錄（未變更卡片標籤）" : "已存入關係句候選池");
      }
    } catch (e) {
      report(e, "儲存關係句紀錄失敗");
    } finally {
      setSaving(false);
    }
  };

  const clearRelation = async () => {
    if (!savedRel) return;
    if (!window.confirm("確定要清除這張卡片的關係句紀錄嗎？\n（已貼在卡片上的橋樑詞標籤不會被移除）")) return;
    setSaving(true);
    try {
      await api.deleteCardRelation(card.id);
      syncFormFromRelation(null);
      const pList = await api.listRelationPatterns();
      setPatterns(Array.isArray(pList?.patterns) ? pList.patterns : []);
      info?.("已清除此卡的關係句紀錄");
    } catch (e) {
      report(e, "清除關係句紀錄失敗");
    } finally {
      setSaving(false);
    }
  };

  const summaryBadge = savedRel
    ? savedRel.pattern_id
      ? `已記錄句型：${patterns.find((p) => p.id === savedRel.pattern_id)?.label ?? "（句型）"}`
      : "已記錄於候選池（無句型）"
    : "尚未記錄";

  return (
    <details className="resolve-box" open={Boolean(savedRel)} style={{ margin: "8px 0" }}>
      <summary style={{ cursor: "pointer", fontWeight: 600, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>🌉 跨領域關係句型（本機 SQLite）</span>
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>{summaryBadge}</span>
      </summary>

      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span className="muted" style={{ fontSize: 11 }}>
            先將學科名詞代換為角色 A／B／結果，再選句型；此表僅存本機，不納入雲端同步。
          </span>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            <button type="button" onClick={() => setManageOpen(true)}>
              ⚙ 句型庫（{patterns.length}）
            </button>
            <button type="button" onClick={() => setReportOpen(true)}>
              📊 評估報告與候選池
            </button>
            <button type="button" onClick={() => setNotesOpen(true)} title="查看新增橋樑詞與句型的規則、評估方法與待處理清單">
              📖 規則與備註
            </button>
          </div>
        </div>

        {loadErr && (
          <div className="banner danger">
            載入失敗：{loadErr} <button type="button" onClick={() => void loadData()}>重試</button>
          </div>
        )}

        {loading ? (
          <div className="muted">載入關係句型中…</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
              <label className="field-row" style={{ margin: 0 }}>
                <span className="muted" style={{ fontSize: 11 }}>角色 A（選填）：</span>
                <input
                  value={roleA}
                  onChange={(e) => setRoleA(e.target.value)}
                  placeholder="例：前鋸肌 / 做市商"
                />
              </label>
              <label className="field-row" style={{ margin: 0 }}>
                <span className="muted" style={{ fontSize: 11 }}>角色 B（選填）：</span>
                <input
                  value={roleB}
                  onChange={(e) => setRoleB(e.target.value)}
                  placeholder="例：上斜方肌 / 剩餘掛單者"
                />
              </label>
              <label className="field-row" style={{ margin: 0 }}>
                <span className="muted" style={{ fontSize: 11 }}>結果（選填）：</span>
                <input
                  value={result}
                  onChange={(e) => setResult(e.target.value)}
                  placeholder="例：頸肩緊繃 / 價差擴大"
                />
              </label>
            </div>

            <label className="field-row" style={{ margin: 0 }}>
              <span className="muted" style={{ fontSize: 11 }}>關係句型：</span>
              <select
                value={patternId}
                onChange={(e) => setPatternId(e.target.value)}
                aria-label="選擇關係句型"
              >
                <option value="">（套不進現有句型 → 填寫自由關係句進入候選池）</option>
                {PATTERN_FAMILIES.map((fam) => {
                  const list = patternsByFamily.get(fam) ?? [];
                  if (list.length === 0) return null;
                  return (
                    <optgroup key={fam} label={PATTERN_FAMILY_GUIDES[fam].name}>
                      {list.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label} → 【{p.bridge_name}】
                        </option>
                      ))}
                    </optgroup>
                  );
                })}
                {(patternsByFamily.get("none") ?? []).length > 0 && (
                  <optgroup label="未分類">
                    {(patternsByFamily.get("none") ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label} → 【{p.bridge_name}】
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>

            <div>
              <button type="button" onClick={() => (guideOpen ? closeGuide() : setGuideOpen(true))}>
                {guideOpen ? "收合導引" : "🧭 不知道選哪個？"}
              </button>
            </div>

            {guideOpen && (
              <div className="resolve-box" role="region" aria-label="關係句型導引">
                {guideFamily === null ? (
                  <>
                    <div className="resolve-title">
                      選最接近的一類；兩類都像時，看上面「結果」欄在描述什麼：
                    </div>
                    <ul className="plain resolve-list">
                      {PATTERN_FAMILIES.map((fam) => {
                        const g = PATTERN_FAMILY_GUIDES[fam];
                        const n = (patternsByFamily.get(fam) ?? []).length;
                        return (
                          <li key={fam} className="resolve-item">
                            <button
                              type="button"
                              className="resolve-pick"
                              disabled={n === 0}
                              onClick={() => setGuideFamily(fam)}
                            >
                              <strong>{g.name}</strong>（{n}）
                              <div className="resolve-def">{g.question}</div>
                              <div className="muted" style={{ fontSize: 11 }}>{g.resultHint}</div>
                            </button>
                          </li>
                        );
                      })}
                      {(patternsByFamily.get("none") ?? []).length > 0 && (
                        <li className="resolve-item">
                          <button type="button" className="resolve-pick" onClick={() => setGuideFamily("none")}>
                            <strong>未分類</strong>（{(patternsByFamily.get("none") ?? []).length}）
                            <div className="resolve-def">尚未指定家族的句型（含你自己新增的）</div>
                          </button>
                        </li>
                      )}
                    </ul>
                    <div className="resolve-actions">
                      <button type="button" onClick={pickFreeSentence}>都不像 → 寫自由關係句（進候選池）</button>
                      <button type="button" onClick={closeGuide}>關閉</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="resolve-title">
                      {guideFamily === "none" ? "未分類" : PATTERN_FAMILY_GUIDES[guideFamily].name}：哪一句最像這張卡片？
                    </div>
                    <ul className="plain resolve-list">
                      {(patternsByFamily.get(guideFamily) ?? []).map((p) => (
                        <li key={p.id} className="resolve-item">
                          <button type="button" className="resolve-pick" onClick={() => pickFromGuide(p.id)}>
                            <strong>{p.note || p.template}</strong>
                            <div className="resolve-def">{p.label} → 橋樑詞：【{p.bridge_name}】</div>
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="resolve-actions">
                      <button type="button" onClick={() => setGuideFamily(null)}>← 回上一步</button>
                      <button type="button" onClick={pickFreeSentence}>都不像 → 寫自由關係句（進候選池）</button>
                    </div>
                  </>
                )}
              </div>
            )}

            {selectedPattern ? (
              <div
                style={{
                  padding: "6px 8px",
                  borderRadius: 4,
                  background: "rgba(59, 130, 246, 0.08)",
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                <div>
                  <strong>預覽：</strong>
                  {renderTemplatePreview(selectedPattern.template, roleA, roleB, result)}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                  <span>
                    對應橋樑詞：<strong>{selectedPattern.bridge_name}</strong>
                    {selectedPattern.note ? <span className="muted">（{selectedPattern.note}）</span> : null}
                  </span>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {hasBridgeTagOnCard ? "✓ 此卡已貼此橋樑詞" : "⚠ 此卡尚未貼此橋樑詞"}
                  </span>
                </div>
              </div>
            ) : (
              <label className="field-row" style={{ margin: 0 }}>
                <span className="muted" style={{ fontSize: 11 }}>
                  自由關係句（候選池必填，請勿出現學科專有名詞）：
                </span>
                <input
                  value={freeSentence}
                  onChange={(e) => setFreeSentence(e.target.value)}
                  placeholder="例：A 失效導致負擔轉移到 B，使 B 過載"
                />
              </label>
            )}

            <div className="resolve-actions" style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              {selectedPattern ? (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={saving}
                    onClick={() => void saveRelation(true)}
                    title="寫入 card_relations 並呼叫 assignTag 將橋樑詞貼上此卡片"
                  >
                    {hasBridgeTagOnCard
                      ? `儲存紀錄（已貼「${selectedPattern.bridge_name}」）`
                      : `確認：儲存紀錄並貼上「${selectedPattern.bridge_name}」`}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveRelation(false)}
                    title="只寫入 card_relations 供稽核，不自動貼上橋樑詞標籤"
                  >
                    僅儲存紀錄
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={saving || !freeSentence.trim()}
                  onClick={() => void saveRelation(false)}
                >
                  存入候選池
                </button>
              )}
              {savedRel && (
                <button type="button" className="danger" disabled={saving} onClick={() => void clearRelation()}>
                  清除此卡紀錄
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {manageOpen && (
        <PatternManageModal
          patterns={patterns}
          tags={tags}
          onClose={() => setManageOpen(false)}
          onChanged={() => void loadData()}
          report={report}
          info={info}
        />
      )}

      {reportOpen && (
        <RelationsReportModal
          onClose={() => setReportOpen(false)}
          onSelectCard={(cid) => {
            setReportOpen(false);
            onSelectCard?.(cid);
          }}
          report={report}
        />
      )}

      {notesOpen && <RelationNotesModal onClose={() => setNotesOpen(false)} />}
    </details>
  );
}

function PatternManageModal(props: {
  patterns: RelationPattern[];
  tags: Tag[];
  onClose(): void;
  onChanged(): void;
  report(e: unknown, prefix?: string): void;
  info?(text: string): void;
}) {
  const { patterns, tags, onClose, onChanged, report, info } = props;
  const conceptTags = useMemo(
    () =>
      tags
        .filter((t) => !isSameAxisGroup(t.axis, "location"))
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hant")),
    [tags],
  );

  const [label, setLabel] = useState("");
  const [template, setTemplate] = useState("{A} 失效，{B} 接手並出現 {結果}");
  // 預設橋樑詞不能在這裡直接取 conceptTags[0]：標籤清單晚到時會永遠停在空值，所以每次由清單推導
  const [bridgeTagId, setBridgeTagId] = useState("");
  const [note, setNote] = useState("");
  const [family, setFamily] = useState<PatternFamily | "">("");

  const effectiveBridgeTagId = conceptTags.some((t) => t.id === bridgeTagId)
    ? bridgeTagId
    : (conceptTags[0]?.id ?? "");
  // 按鈕停用時要明確告訴使用者缺什麼，不能無聲無息
  const missing: string[] = [];
  if (!label.trim()) missing.push("句型名稱");
  if (!template.trim()) missing.push("句型模板");
  if (!effectiveBridgeTagId) missing.push("橋樑詞（請先建立概念標籤）");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editTemplate, setEditTemplate] = useState("");
  const [editNote, setEditNote] = useState("");
  const [editFamily, setEditFamily] = useState<PatternFamily | "">("");

  const create = async () => {
    if (missing.length > 0) return;
    try {
      await api.createRelationPattern({
        label: label.trim(),
        template: template.trim(),
        bridge_tag_id: effectiveBridgeTagId,
        note: note.trim(),
        ...(family ? { family } : {}),
      });
      setLabel("");
      setNote("");
      info?.("已新增關係句型");
      onChanged();
    } catch (e) {
      report(e, "新增關係句型失敗");
    }
  };

  const saveEdit = async (id: string) => {
    try {
      await api.patchRelationPattern(id, {
        label: editLabel.trim(),
        template: editTemplate.trim(),
        note: editNote.trim(),
        ...(editFamily ? { family: editFamily } : {}),
      });
      setEditingId(null);
      info?.("已更新關係句型");
      onChanged();
    } catch (e) {
      report(e, "更新關係句型失敗");
    }
  };

  const remove = async (p: RelationPattern) => {
    if (!window.confirm(`確定要刪除句型「${p.label}」嗎？`)) return;
    try {
      await api.deleteRelationPattern(p.id);
      info?.("已刪除關係句型");
      onChanged();
    } catch (e) {
      report(e, "刪除關係句型失敗");
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="管理關係句型庫">
      <div className="modal-card" style={{ minWidth: 520, maxWidth: 680, maxHeight: "85vh", overflow: "auto" }}>
        <h4>管理關係句型庫（僅電腦端 SQLite）</h4>
        <div className="resolve-box" style={{ marginBottom: 12 }}>
          <div className="resolve-title">新增關係句型（模板必含 {"{A}"}、{"{B}"} 或 {"{結果}"}）</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <label className="field-row">
              <span className="muted">句型名稱（唯一）：</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="例：負載轉移（代償）"
              />
            </label>
            <label className="field-row">
              <span className="muted">對應橋樑詞（概念標籤，建立後不可改指）：</span>
              <select value={effectiveBridgeTagId} onChange={(e) => setBridgeTagId(e.target.value)}>
                {conceptTags.length === 0 && <option value="">（請先建立概念標籤）</option>}
                {conceptTags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.facet ? `[${t.facet}] ` : ""}{t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field-row">
            <span className="muted">句型模板（只能使用 {"{A}"}、{"{B}"}、{"{結果}"} 作為佔位符）：</span>
            <input
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder="例：{A} 失效，{B} 被迫接手並導致 {結果}"
            />
          </label>
          <label className="field-row">
            <span className="muted">家族（導引與下拉分組用，可日後再改，但無法清回未分類）：</span>
            <select value={family} onChange={(e) => setFamily(e.target.value as PatternFamily | "")}>
              <option value="">未分類</option>
              {PATTERN_FAMILIES.map((fam) => (
                <option key={fam} value={fam}>
                  {PATTERN_FAMILY_GUIDES[fam].name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-row">
            <span className="muted">備註／判準說明（選填）：</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="例：壓力或流量從原承擔者轉移至另一承擔者"
            />
          </label>
          <div className="resolve-actions">
            <button
              type="button"
              className="primary"
              disabled={missing.length > 0}
              onClick={() => void create()}
            >
              ＋新增句型
            </button>
            {missing.length > 0 && (
              <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
                請先填寫：{missing.join("、")}
              </span>
            )}
          </div>
        </div>

        <ul className="results" style={{ maxHeight: 320, overflow: "auto" }}>
          {patterns.length === 0 && <li className="muted">目前尚無關係句型</li>}
          {patterns.map((p) => {
            const isEd = editingId === p.id;
            return (
              <li key={p.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 6 }}>
                  <div>
                    <strong>{p.label}</strong> → <span className="chip concept">{p.bridge_name}</span>{" "}
                    <span className="facet-badge">{familyName(p.family)}</span>
                    <span className="muted" style={{ fontSize: 11, marginLeft: 6 }}>
                      （已用 {p.use_count} 張卡）
                    </span>
                    <div className="snippet">{p.template}</div>
                    {p.note && <div className="muted" style={{ fontSize: 11 }}>備註：{p.note}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => {
                        if (isEd) {
                          setEditingId(null);
                        } else {
                          setEditingId(p.id);
                          setEditLabel(p.label);
                          setEditTemplate(p.template);
                          setEditNote(p.note);
                          setEditFamily(normalizeFamily(p.family) ?? "");
                        }
                      }}
                    >
                      {isEd ? "取消" : "編輯"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(p)}
                      title={p.use_count > 0 ? `仍有 ${p.use_count} 張卡片使用中` : "刪除句型"}
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {isEd && (
                  <div className="resolve-box" style={{ marginTop: 4 }}>
                    <label className="field-row">
                      <span className="muted">句型名稱：</span>
                      <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} />
                    </label>
                    <label className="field-row">
                      <span className="muted">句型模板：</span>
                      <input value={editTemplate} onChange={(e) => setEditTemplate(e.target.value)} />
                    </label>
                    <label className="field-row">
                      <span className="muted">家族：</span>
                      <select
                        value={editFamily}
                        onChange={(e) => setEditFamily(e.target.value as PatternFamily | "")}
                      >
                        <option value="">維持現狀（無法清回未分類）</option>
                        {PATTERN_FAMILIES.map((fam) => (
                          <option key={fam} value={fam}>
                            {PATTERN_FAMILY_GUIDES[fam].name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field-row">
                      <span className="muted">備註：</span>
                      <input value={editNote} onChange={(e) => setEditNote(e.target.value)} />
                    </label>
                    <div className="resolve-actions">
                      <button type="button" className="primary" onClick={() => void saveEdit(p.id)}>
                        儲存修改
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>

        <div className="modal-actions">
          <button type="button" onClick={onClose}>關閉</button>
        </div>
      </div>
    </div>
  );
}

function RelationsReportModal(props: {
  onClose(): void;
  onSelectCard(cardId: string): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { onClose, onSelectCard, report } = props;
  const [data, setData] = useState<RelationsReport | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getRelationsReport();
      setData(res);
    } catch (e) {
      report(e, "載入關係句評估報告失敗");
    } finally {
      setLoading(false);
    }
  }, [report]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="modal" role="dialog" aria-label="橋樑詞評估報告與候選池">
      <div className="modal-card" style={{ minWidth: 560, maxWidth: 740, maxHeight: "85vh", overflow: "auto" }}>
        <h4>橋樑詞評估報告與候選池（唯讀）</h4>
        {loading && <div className="empty">載入報告中…</div>}
        {!loading && data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <section>
              <h5 style={{ margin: "0 0 4px 0" }}>
                1. 橋樑詞跨櫃分布（全庫共 {data.total_cards} 張卡片）
              </h5>
              <p className="muted" style={{ margin: "0 0 6px 0", fontSize: 12 }}>
                註：櫃子數為涉及的最上層收納位置數量，僅為「領域數」的上界，是否真正跨領域請人工判斷。
                若集中於單一櫃子可能實為領域詞；若佔全庫卡片超過 25% 代表過度泛化。
              </p>
              {data.bridges.length === 0 ? (
                <div className="muted">尚無句型引用任何橋樑詞</div>
              ) : (
                <ul className="results">
                  {data.bridges.map((b) => {
                    const pct = (b.card_ratio * 100).toFixed(1);
                    const tooBroad = b.card_ratio > 0.25;
                    const singleCabinet = b.card_count > 0 && b.cabinet_count <= 1;
                    return (
                      <li key={b.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 2 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <strong>🌉 {b.name}</strong>
                          <span style={{ fontSize: 12 }}>
                            {b.card_count} 張卡（{pct}%） · 橫跨 <strong>{b.cabinet_count}</strong> 個櫃子
                            {b.unfiled_count > 0 ? `（另 ${b.unfiled_count} 張未歸檔）` : ""}
                          </span>
                        </div>
                        <div className="snippet">
                          涉及櫃子：
                          {b.cabinets.length === 0
                            ? "無"
                            : b.cabinets.map((c) => `${c.name}(${c.card_count})`).join("、")}
                        </div>
                        {(tooBroad || singleCabinet) && (
                          <div style={{ fontSize: 11, color: "#f59e0b" }}>
                            {tooBroad ? "⚠ 佔比超過 25%，請評估拆分或停用。 " : ""}
                            {singleCabinet ? "⚠ 僅出現於單一櫃子（或未歸檔），請檢視是否實為領域專有詞。" : ""}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <section>
              <h5 style={{ margin: "0 0 4px 0" }}>
                2. 紀錄與卡片標籤不一致（共 {data.inconsistencies.length} 張）
              </h5>
              <p className="muted" style={{ margin: "0 0 6px 0", fontSize: 12 }}>
                以下卡片存有關係句紀錄，但卡片目前未貼上該句型對應的橋樑詞標籤：
              </p>
              {data.inconsistencies.length === 0 ? (
                <div className="muted">✓ 所有句型紀錄皆與卡片標籤一致</div>
              ) : (
                <ul className="results">
                  {data.inconsistencies.map((inc) => (
                    <li key={inc.card_id}>
                      <button
                        type="button"
                        className="result-main"
                        onClick={() => onSelectCard(inc.card_id)}
                      >
                        <strong>{inc.title || "（無標題）"}</strong>
                        <span className="snippet">
                          句型「{inc.pattern_label}」→ 缺少橋樑詞標籤「{inc.bridge_name}」
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h5 style={{ margin: "0 0 4px 0" }}>
                3. 關係句候選池（無句型之自由關係句，共 {data.candidates.length} 張）
              </h5>
              <p className="muted" style={{ margin: "0 0 6px 0", fontSize: 12 }}>
                湊滿三個不同領域抽屜的同構自由句後，即可於句型庫升格為正式橋樑詞與句型：
              </p>
              {data.candidates.length === 0 ? (
                <div className="muted">目前候選池為空</div>
              ) : (
                <ul className="results">
                  {data.candidates.map((cand) => (
                    <li key={cand.card_id}>
                      <button
                        type="button"
                        className="result-main"
                        onClick={() => onSelectCard(cand.card_id)}
                      >
                        <strong>{cand.title || "（無標題）"}</strong>
                        <span className="snippet">{cand.free_sentence}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={() => void load()}>重新整理</button>
          <button type="button" className="primary" onClick={onClose}>關閉</button>
        </div>
      </div>
    </div>
  );
}

function RelationNotesModal(props: { onClose(): void }) {
  return (
    <div className="modal" role="dialog" aria-label="跨領域橋樑詞與關係句型備註">
      <div
        className="modal-card"
        style={{ minWidth: 580, maxWidth: 760, maxHeight: "85vh", overflow: "auto", fontSize: 13, lineHeight: 1.6 }}
      >
        <h4>📖 跨領域橋樑詞與關係句型｜規則、評估方法與待處理清單</h4>

        <section style={{ marginBottom: 12 }}>
          <h5 style={{ margin: "0 0 4px 0" }}>一、核心定位：橋樑詞與五大描述維度正交</h5>
          <p className="muted" style={{ margin: 0 }}>
            橋樑詞不是新的標籤軸（仍屬於 concept 軸概念標籤），而是<strong>被至少一個關係句型引用的跨領域結構詞</strong>。
            不同領域的專有名詞（如「前鋸肌」、「做市商」、「伺服器節點」）不會直接共現，跨領域連結依賴兩步路徑：
            <strong>領域詞 A — 橋樑詞 — 領域詞 B</strong>。
          </p>
        </section>

        <section style={{ marginBottom: 12 }}>
          <h5 style={{ margin: "0 0 4px 0" }}>二、寫卡片時的 30 秒變數化三步驟</h5>
          <ol style={{ margin: "4px 0", paddingLeft: 20 }}>
            <li>
              <strong>圈出名詞，標上角色（A、B、結果）</strong>：問自己每個名詞在因果鏈扮演什麼角色？若卡片只記錄單一現象（「這裡很緊」），先補一句「為什麼會這樣」；補不出來就留白不貼橋樑詞。
            </li>
            <li>
              <strong>去領域化代換</strong>：將學科專有名詞拿掉，只留動詞與關係（句子裡不可出現「肌肉」、「訂單」、「梯度」等領域詞）。
            </li>
            <li>
              <strong>對照句型表或送入候選池</strong>：套得進現有句型就選取並按「確認：儲存紀錄並貼上橋樑詞」；套不進時<strong>不要當場發明新標籤</strong>，將句型留空、寫下自由關係句存入候選池。若一張卡片有第二個形狀的橋樑詞，第二個用一般貼標籤方式手動加。
            </li>
          </ol>
        </section>

        <section style={{ marginBottom: 12 }}>
          <h5 style={{ margin: "0 0 4px 0" }}>三、種子關係句型對照表</h5>
          <ul className="plain" style={{ margin: "4px 0", fontSize: 12 }}>
            <li>・<strong>負載轉移</strong>：{"{A} 失效或撤出，{B} 被迫接手並出現 {結果}"}</li>
            <li>・<strong>負回饋調節</strong>：{"{A} 偏離基準時觸發 {B}，將系統拉回 {結果}"}</li>
            <li>・<strong>正回饋</strong>：{"{A} 強化 {B}，{B} 再反過來放大 {A}，導致 {結果}"}</li>
            <li>・<strong>回饋延遲</strong>：{"{A} 的修正訊號延遲抵達 {B}，導致矯枉過正並產生 {結果}"}</li>
            <li>・<strong>瓶頸效應</strong>：{"{A} 的容量上限卡住 {B}，使整體產出受限於 {結果}"}</li>
            <li>・<strong>取捨</strong>：{"提升 {A} 必然犧牲 {B}，兩者形成 {結果} 的取捨"}</li>
            <li>・<strong>臨界閾值</strong>：{"{A} 累積跨越 {B} 後，系統狀態突變為 {結果}"}</li>
            <li>・<strong>過度擬合</strong>：{"{A} 過度適應特定情境 {B}，遇到新環境時產生 {結果}"}</li>
            <li>・<strong>單點失效</strong>：{"{A} 缺乏 {B} 備援，一旦失效即引發 {結果}"}</li>
          </ul>
        </section>

        <section style={{ marginBottom: 12 }}>
          <h5 style={{ margin: "0 0 4px 0" }}>四、候選池新詞升格四規則</h5>
          <ol style={{ margin: "4px 0", paddingLeft: 20 }}>
            <li><strong>三抽屜測試</strong>：能在三個不同領域（不同櫃子）各舉出一張真實卡片套入同一個關係句。</li>
            <li><strong>無領域名詞定義</strong>：定義與句型模板中不能出現任何單一學科專有名詞。</li>
            <li><strong>遷移測試（防假類比）</strong>：在甲領域對該機制的認識，能對乙領域做出可檢驗的推論（例如「筋膜張力」與「戲劇張力」變數化後句子形狀完全不同，屬假類比，不得共用）。</li>
            <li><strong>單一正名</strong>：選最通用名稱當正式標籤，同義詞放別名（aliases）。若重複建立，用左側標籤樹「合併標籤（⇄）」，系統會自動把句型的 bridge_tag_id 改指向目標標籤。</li>
          </ol>
        </section>

        <section style={{ marginBottom: 12 }}>
          <h5 style={{ margin: "0 0 4px 0" }}>五、評估方法與圖譜檢視要點</h5>
          <ul className="plain" style={{ margin: "4px 0" }}>
            <li>・<strong>櫃子數是領域數的上界</strong>：報告中的 cabinet_count 是涉及的最上層收納位置（櫃子）數量；若同一領域拆成多個櫃子會高估領域數，是否真的跨領域由人工判斷。</li>
            <li>・<strong>單一櫃子集中（cabinet_count ≤ 1）</strong>：代表它可能實為領域專有詞，應降級或改名。</li>
            <li>・<strong>過度泛化（card_ratio &gt; 25%）</strong>：出現在超過四分之一的卡片代表太泛，應拆分或停用。</li>
            <li>・<strong>圖譜檢視注意</strong>：橋樑詞的 card_count 大，與單一標籤的 Jaccard 天然偏低；在圖譜觀察跨領域路徑時請把「最低強度」調低、選「全部維度」，並滑過／點選節點以展開被鄰居上限（預設 8）隱藏的邊。</li>
          </ul>
        </section>

        <section>
          <h5 style={{ margin: "0 0 4px 0" }}>六、已知限制與待處理清單（Backlog）</h5>
          <ul className="plain" style={{ margin: "4px 0", fontSize: 12 }}>
            <li>1. <strong>本機儲存與備份</strong>：relation_patterns 與 card_relations 第一版僅存於電腦端 SQLite，不納入雲端同步封包（sync_export）與 iPad（Dexie），請定期備份電腦端 SQLite 檔案。</li>
            <li>2. <strong>同步缺乏墓碑（既有問題）</strong>：iPad→PC 的 sync_diff 把本機沒有的標籤 id 一律當新增。PC 合併或刪除標籤後，必須先由 PC 匯出讓 iPad 整庫覆蓋；若 iPad 先推回 PC，被合併掉的舊標籤會復活。</li>
            <li>3. <strong>init_db 版本號條件（既有問題）</strong>：db.py 的 version in (1, 3) 會把版本 3 送進 v1→v2 遷移，本次用 CREATE TABLE IF NOT EXISTS 避開，日後改表結構需先清理該條件。</li>
            <li>4. <strong>is_bridge 範圍</strong>：第一版只算「被句型引用」的標籤，像「奧卡姆剃刀」這類無關係句的原則詞暫不涵蓋。</li>
            <li>5. <strong>Dexie stub 慣例差異</strong>：本次新增的寫入方法在 Dexie 採 Fail Loud（丟出 ApiError），舊有的 cleanupMedia 等仍為靜默回空 stub，日後可統一清理。</li>
            <li>6. <strong>家族欄位</strong>：relation_patterns.family 只能設定、不能清回「未分類」；資料庫沒有 CHECK 約束，合法值只由後端 PatternFamily 列舉把關。新增家族需同步修改 schemas.py、types.ts、種子腳本與導引說明。</li>
            <li>7. <strong>橋樑詞下拉</strong>：句型庫的橋樑詞選單包含 type 軸標籤，但後端只接受 concept／free，選到會被拒絕（AXIS_MISMATCH）。</li>
            <li>8. <strong>橋樑詞鎖定</strong>：句型建立後不能改指其他橋樑詞（刻意設計）。要換橋樑詞，同義詞用標籤合併，否則新建句型再逐張卡片換選。</li>
          </ul>
        </section>

        <div className="modal-actions">
          <button type="button" className="primary" onClick={props.onClose}>關閉</button>
        </div>
      </div>
    </div>
  );
}