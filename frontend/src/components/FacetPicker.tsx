import { useState } from "react";
import {
  DEFAULT_FACETS,
  FACET_ELIMINATION_STEPS,
  FACET_GUIDES,
  type FacetName,
} from "../types";

interface Props {
  value: string;
  onChange(next: string): void;
}

export function FacetPicker({ value, onChange }: Props) {
  const [openHelp, setOpenHelp] = useState(false);
  const [helpTab, setHelpTab] = useState<"elimination" | "table">("elimination");

  const currentGuide =
    value && (DEFAULT_FACETS as readonly string[]).includes(value)
      ? FACET_GUIDES[value as FacetName]
      : null;

  const isCustomValue =
    value.trim() !== "" && !(DEFAULT_FACETS as readonly string[]).includes(value);

  return (
    <div className="facet-picker">
      <div className="facet-picker-head">
        <span className="muted">描述維度（Facet）：</span>
        <button
          type="button"
          className={`facet-help-btn${openHelp ? " on" : ""}`}
          onClick={() => setOpenHelp((v) => !v)}
          title="查看各維度的本質定義、判斷標準與「問題消去法」"
          aria-label="查看維度定義與問題消去法"
        >
          ⓘ 維度判準／消去法
        </button>
      </div>

      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="選擇描述維度"
      >
        <option value="">未指定（待定 — 尚未確定維度時請留空）</option>
        {DEFAULT_FACETS.map((f) => (
          <option key={f} value={f}>
            {f}（【{FACET_GUIDES[f].role}】{FACET_GUIDES[f].criterion}）
          </option>
        ))}
        {isCustomValue && <option value={value}>{value}（既有維度）</option>}
      </select>

      {/* 選中維度時的即時本質與判準提示框 */}
      {currentGuide ? (
        <div
          className="facet-inline-hint"
          style={{ borderLeftColor: currentGuide.color }}
        >
          <div>
            <strong style={{ color: currentGuide.color }}>
              【{currentGuide.role}】{currentGuide.name}
            </strong>
            ：{currentGuide.essence}
          </div>
          <div className="facet-criterion-line">
            ✓ 判斷標準：「{currentGuide.criterion}」
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            實例：{currentGuide.examples}
          </div>
        </div>
      ) : (
        <div className="facet-inline-hint unassigned">
          <span>
            目前為<strong>「未指定（待定）」</strong>：若當下還拿不定主意，保持未指定即可，避免將不確定的概念塞入「屬性／原則」。不知怎麼選時可點右上角
            <strong>「ⓘ 維度判準／消去法」</strong>。
          </span>
        </div>
      )}

      {/* 點擊小圖標彈出的完整輔助框（問題消去法 ＋ 五大維度對照表） */}
      {openHelp && (
        <div className="facet-guide-popover" role="region" aria-label="維度本質定義與問題消去法">
          <div className="facet-guide-tabs">
            <button
              type="button"
              className={helpTab === "elimination" ? "on" : ""}
              onClick={() => setHelpTab("elimination")}
            >
              🔍 不知怎麼選？（問題消去法）
            </button>
            <button
              type="button"
              className={helpTab === "table" ? "on" : ""}
              onClick={() => setHelpTab("table")}
            >
              📖 5 大維度本質與判斷標準
            </button>
            <button
              type="button"
              className="facet-guide-close"
              onClick={() => setOpenHelp(false)}
              title="關閉說明"
              aria-label="關閉維度說明"
            >
              ✕
            </button>
          </div>

          {helpTab === "elimination" ? (
            <div className="facet-guide-body">
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                請依序問以下 5 個問題（<strong>先中者贏</strong>，點擊右側按鈕可直接套用該維度）：
              </div>
              <ol className="plain facet-step-list">
                {FACET_ELIMINATION_STEPS.map((s) => {
                  const g = FACET_GUIDES[s.targetFacet];
                  const active = value === s.targetFacet;
                  return (
                    <li
                      key={s.step}
                      className={`facet-step-item${active ? " active" : ""}`}
                    >
                      <div className="facet-step-main">
                        <span className="facet-step-num">Q{s.step}</span>
                        <div style={{ flex: 1 }}>
                          <div className="facet-step-q">{s.question}</div>
                          <div className="facet-step-tip">{s.tip}</div>
                        </div>
                        <button
                          type="button"
                          className={active ? "primary" : ""}
                          onClick={() => {
                            onChange(s.targetFacet);
                            setOpenHelp(false);
                          }}
                        >
                          選「{g.name}」
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="facet-step-footer">
                <span>還是不確定？別勉強分類：</span>
                <button
                  type="button"
                  onClick={() => {
                    onChange("");
                    setOpenHelp(false);
                  }}
                >
                  保持「未指定（待定）」
                </button>
              </div>
            </div>
          ) : (
            <div className="facet-guide-body">
              <div className="muted" style={{ fontSize: 11, marginBottom: 4 }}>
                學科領域由「收納位置（抽屜）」負責；維度則描述該概念在系統中扮演的<strong>跨學科本體角色</strong>：
              </div>
              <ul className="plain facet-table-list">
                {DEFAULT_FACETS.map((f) => {
                  const g = FACET_GUIDES[f];
                  const active = value === f;
                  return (
                    <li
                      key={f}
                      className={`facet-table-item${active ? " active" : ""}`}
                      style={{ borderLeftColor: g.color }}
                    >
                      <div className="facet-table-head">
                        <div>
                          <strong style={{ color: g.color }}>{g.name}</strong>
                          <span className="facet-role-tag">【{g.role}】</span>
                        </div>
                        <button
                          type="button"
                          className={active ? "primary" : ""}
                          onClick={() => {
                            onChange(f);
                            setOpenHelp(false);
                          }}
                        >
                          {active ? "✓ 目前選用" : "套用此維度"}
                        </button>
                      </div>
                      <div className="facet-table-essence">{g.essence}</div>
                      <div className="facet-criterion-line">
                        判斷標準：「{g.criterion}」
                      </div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {g.examples}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}