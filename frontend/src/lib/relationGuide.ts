// 連結類型引導：「先中者贏」的問題消去法，與維度的 FACET_ELIMINATION_STEPS 同一個做法。
// 每一題以 A（連結的起點）與 B（終點）為主詞，答「是」就選該題的類型；不確定就用保底的「延伸＋待驗證假說」。
// @depends-on ../types.ts (RelationType, LinkStatus)
// 17 種類型都必須能從某一題到達，由 test_relation_contract.py 檢查。
import type { LinkStatus, RelationType } from "../types";

export interface RelationGuideStep {
  step: number;
  question: string;
  /** 一題可對應多個類型（例如限制／保護性限制），讓使用者在同一題裡再挑 */
  targets: readonly RelationType[];
  tip: string;
}

export const RELATION_GUIDE_STEPS: readonly RelationGuideStep[] = [
  {
    step: 1,
    question: "A 是 B 的一個例子、案例或具體實例嗎？",
    targets: ["實例"],
    tip: "例：A「SQLite」是 B「資料庫」的實例。方向是「實例 → 類別」。",
  },
  {
    step: 2,
    question: "A 是 B 的一部分，或 A 把 B 包含在內嗎？",
    targets: ["包含"],
    tip: "整體與組成。例：A「SQLite」包含 B「WAL 模式」。方向是「包含者 → 被包含者」。",
  },
  {
    step: 3,
    question: "沒有 B，A 就不成立或無法運作嗎？",
    targets: ["依賴"],
    tip: "例：A「樂觀鎖」依賴 B「版本號欄位」。",
  },
  {
    step: 4,
    question: "A 會造成 B 發生嗎？（確定或可能都算）",
    targets: ["導致"],
    tip: "只是可能、還沒驗證：選【導致】並勾選「待驗證假說」。",
  },
  {
    step: 5,
    question: "A 能改善、減輕 B 這個問題嗎？",
    targets: ["改善"],
    tip: "例：A「呼吸訓練」改善 B「肩頸代償」。",
  },
  {
    step: 6,
    question: "A 是方法、工具或原理，被拿來用在 B 上嗎？",
    targets: ["應用於"],
    tip: "例：A「力導向演算法」應用於 B「概念圖譜的排版」。若 A 的效果是讓 B 變好，上一題的【改善】優先。",
  },
  {
    step: 7,
    question: "A 在限制、卡住 B 嗎？",
    targets: ["限制", "保護性限制"],
    tip: "【限制】是造成問題的病理性限制；【保護性限制】是身體或系統為了保護自己而產生的限制（代償）。",
  },
  {
    step: 8,
    question: "A 與 B 要二選一、互相拉扯，或 A 取代 B 嗎？",
    targets: ["張力", "取代"],
    tip: "【張力】是權衡、拮抗或競爭，沒有方向；【取代】是 A 取代 B。",
  },
  {
    step: 9,
    question: "A 的出現，是在指示或證明 B 嗎？（診斷指標、證據）",
    targets: ["指標於"],
    tip: "例：A「腳踝內側麻感」指標於 B「跗骨隧道症候群」。證據不是因果，別選【導致】。",
  },
  {
    step: 10,
    question: "A 與 B 是相似、互補，或位置相鄰嗎？",
    targets: ["類比", "互補", "鄰接"],
    tip: "【類比】是不同領域的結構相似；【互補】是搭配起來更完整；【鄰接】是空間上相鄰（不是包含）。三種都沒有方向。",
  },
  {
    step: 11,
    question: "A 是在支持或反駁 B 的說法嗎？",
    targets: ["支持", "反駁"],
    tip: "這是論證上的立場，不是結構關係。",
  },
  {
    step: 12,
    question: "以上皆非，A 只是接著 B 往下說明或補充嗎？",
    targets: ["延伸"],
    tip: "拿不定主意時就用這個，並勾選「待驗證假說」。",
  },
];

/** 還拿不定主意時的保底：先連起來，之後再回頭確認。 */
export const RELATION_GUIDE_FALLBACK: { relation_type: RelationType; status: LinkStatus } = {
  relation_type: "延伸",
  status: "hypothesis",
};
