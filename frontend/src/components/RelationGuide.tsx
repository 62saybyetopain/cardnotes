// 連結類型引導面板：問幾個問題，幫你決定 A→B 該選哪一種關係。樣式沿用維度引導（FacetPicker）的 class，不需新增 CSS。
// @depends-on ../lib/relationGuide.ts (RELATION_GUIDE_STEPS, RELATION_GUIDE_FALLBACK)
// @depends-on ../lib/relations.ts (isSymmetricRelation)
// @depends-on ../types.ts (RELATION_COLORS, RELATION_LABELS)
import { useState } from "react";
import { RELATION_GUIDE_FALLBACK, RELATION_GUIDE_STEPS } from "../lib/relationGuide";
import { isSymmetricRelation } from "../lib/relations";
import { RELATION_COLORS, RELATION_LABELS, type LinkStatus, type RelationType } from "../types";

interface Props {
  /** 目前這張卡片（預設的 A） */
  aTitle: string;
  /** 對方（預設的 B） */
  bTitle: string;
  /** 能不能把 A、B 對調。修改既有連結時不能（方向要改就得刪掉重建），預設可以 */
  allowSwap?: boolean;
  /** swapped＝true 表示使用者把 A、B 對調了：連結要從 b 指向 a */
  onPick(rel: RelationType, status: LinkStatus, swapped: boolean): void;
  onCancel(): void;
}

function short(title: string): string {
  const t = title.trim() || "（無標題）";
  return t.length > 18 ? `${t.slice(0, 18)}…` : t;
}

export function RelationGuide({ aTitle, bTitle, allowSwap = true, onPick, onCancel }: Props) {
  const [swappedState, setSwapped] = useState(false);
  const swapped = allowSwap && swappedState;
  const [hypothesis, setHypothesis] = useState(false);
  const a = swapped ? bTitle : aTitle;
  const b = swapped ? aTitle : bTitle;
  const status: LinkStatus = hypothesis ? "hypothesis" : "confirmed";

  return (
    <div className="facet-guide-popover" role="region" aria-label="連結類型引導">
      <div className="facet-guide-tabs">
        <span style={{ flex: 1, fontSize: 12 }}>
          <strong>A</strong>＝「{short(a)}」　<strong>B</strong>＝「{short(b)}」
        </span>
        {allowSwap && (
          <button type="button" onClick={() => setSwapped((v) => !v)} title="把 A、B 對調（連結方向跟著反過來）">
            ⇄ 對調 A、B
          </button>
        )}
        <button type="button" className="facet-guide-close" onClick={onCancel} title="關閉引導" aria-label="關閉連結類型引導">
          ✕
        </button>
      </div>

      <div className="facet-guide-body">
        <label className="sync-check-row" style={{ fontSize: 12, marginBottom: 4 }}>
          <input type="checkbox" checked={hypothesis} onChange={(e) => setHypothesis(e.target.checked)} />
          <span>這條關係還沒確定（標成待驗證假說）</span>
        </label>
        <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
          請依序回答以下問題（<strong>先中者贏</strong>），按右側按鈕直接套用：
        </div>
        <ol className="plain facet-step-list">
          {RELATION_GUIDE_STEPS.map((s) => (
            <li key={s.step} className="facet-step-item">
              <div className="facet-step-main">
                <span className="facet-step-num">Q{s.step}</span>
                <div style={{ flex: 1 }}>
                  <div className="facet-step-q">{s.question}</div>
                  <div className="facet-step-tip">{s.tip}</div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {s.targets.map((rel) => (
                    <button key={rel} type="button" onClick={() => onPick(rel, status, swapped)}>
                      <span style={{ color: RELATION_COLORS[rel] }}>●</span> 選「{RELATION_LABELS[rel]}」
                      {isSymmetricRelation(rel) ? "（無方向）" : ""}
                    </button>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="facet-step-footer">
          <span>還是不確定？別勉強分類：</span>
          <button
            type="button"
            onClick={() => onPick(RELATION_GUIDE_FALLBACK.relation_type, RELATION_GUIDE_FALLBACK.status, swapped)}
          >
            先連起來：{RELATION_LABELS[RELATION_GUIDE_FALLBACK.relation_type]}＋待驗證假說
          </button>
        </div>
      </div>
    </div>
  );
}
