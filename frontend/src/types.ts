export type Axis = "location" | "domain" | "type" | "concept" | "free";
export type CardType = "untyped" | "concept" | "mechanism" | "hypothesis" | "method" | "case" | "source" | "question";
export type CurationStatus = "inbox" | "curated";

export const CARD_TYPE_LABELS: Record<CardType, string> = {
  untyped: "未指定型態",
  concept: "概念",
  mechanism: "機制／過程",
  hypothesis: "主張／假說",
  method: "方法／技術",
  case: "案例",
  source: "來源",
  question: "問題",
};

export const DEFAULT_FACETS = [
  "結構／實體",
  "功能／過程",
  "問題／現象",
  "方法／工具",
  "屬性／原則",
] as const;

export type FacetName = (typeof DEFAULT_FACETS)[number];

export interface FacetGuide {
  name: FacetName;
  role: string;
  essence: string;
  criterion: string;
  examples: string;
  color: string;
}

export const FACET_GUIDES: Record<FacetName, FacetGuide> = {
  "結構／實體": {
    name: "結構／實體",
    role: "靜態載體",
    essence: "系統中客觀存在的部位、硬體、組件、資料結構或作用對象。若把時間暫停，它依然存在於某處。",
    criterion: "它是事件發生的場所、零件、組件或被操作的實體對象嗎？",
    examples: "身體：橫膈膜、肩胛骨、胸椎｜軟體：SQLite、IndexedDB、DOM｜策略：期貨合約、底池 (Pot)",
    color: "#2563eb",
  },
  "功能／過程": {
    name: "功能／過程",
    role: "動態運作",
    essence: "結構所具備的「正常職責／能力」，或隨時間展開的「運作機制、階段與狀態變化」。",
    criterion: "它是在描述系統如何正常運作、某項生理／運算能力，或某個時間階段的動作嗎？",
    examples: "身體：吸氣、離心收縮、腹內壓調節｜軟體：非同步渲染、樂觀鎖｜策略：均值回歸、資金輪動",
    color: "#059669",
  },
  "問題／現象": {
    name: "問題／現象",
    role: "異常與表現",
    essence: "系統偏離預期時的失能、症狀、代償、錯誤狀態，或觀察到的特殊現象。",
    criterion: "它是需要被解釋、被除錯或被改善的異常現象、症狀、瓶頸或錯誤嗎？",
    examples: "身體：肩頸代償、翼狀肩胛、拉扯感｜軟體：版本衝突、記憶體洩漏｜策略：最大回撤 (MDD)、波動率暴增",
    color: "#d97706",
  },
  "方法／工具": {
    name: "方法／工具",
    role: "人為手段",
    essence: "我們主動施加於系統，用來「觀測、評估、測試、治療、訓練或最佳化」的技術、演算法與工具。",
    criterion: "它是我們用來「檢測問題」或「改變系統狀態」的人為技術、測試、演算法或工具嗎？",
    examples: "身體：呼吸訓練、關節活動度測試｜軟體：正規表達式、力導向演算法｜策略：動態波動率調整、GTO 策略",
    color: "#7c3aed",
  },
  "屬性／原則": {
    name: "屬性／原則",
    role: "抽象尺度與法則",
    essence: "用來衡量系統的「指標、物理／數學性質」，或跨領域的「底層理論、公理與設計原則」。",
    criterion: "它既不是具體零件也不是操作方法，而是用來「衡量狀態的指標／性質」或「底層法則」嗎？",
    examples: "身體：張力、活動度、力偶關係｜軟體：冪等性、原子性、時間複雜度｜策略：期望值 (EV)、賠率、隱含波動率",
    color: "#0891b2",
  },
};

export const FACET_ELIMINATION_STEPS: {
  step: number;
  question: string;
  targetFacet: FacetName;
  tip: string;
}[] = [
  {
    step: 1,
    question: "它是我們「主動拿來用」的技術、測試、處方或工具嗎？",
    targetFacet: "方法／工具",
    tip: "例：「深蹲」若當作評估動作或訓練處方 ➔ 選【方法／工具】；若分析下蹲動作階段本身 ➔ 往步驟 4。",
  },
  {
    step: 2,
    question: "它是在描述「出狀況、失衡、代償或需要解決的異常表現」嗎？",
    targetFacet: "問題／現象",
    tip: "例：「呼吸輔助肌過度活化」雖是動態過程，但本質是異常代償表現 ➔ 優先選【問題／現象】。",
  },
  {
    step: 3,
    question: "它是看得見摸得著（或架構中明確存在）的「部位、組件、資料載體」嗎？",
    targetFacet: "結構／實體",
    tip: "把時間暫停依然存在的客觀組件或部位 ➔ 選【結構／實體】。",
  },
  {
    step: 4,
    question: "它是在描述「隨時間發生的動態變化或正常運作職責」嗎？",
    targetFacet: "功能／過程",
    tip: "系統正常的運作階段、動作過程或生理／運算職責 ➔ 選【功能／過程】。",
  },
  {
    step: 5,
    question: "以上皆非，它是某種「程度、指標、性質或抽象定律」嗎？",
    targetFacet: "屬性／原則",
    tip: "注意：若只是「當下還沒想清楚」，請維持【未指定（待定）】，避免把未定概念塞進屬性／原則。",
  },
];

// 值必須等於後端 relation_types.py 的 RELATION_TYPE_KEYS（逐項同序）：
// 前 14 項與知識庫 RELATION_TAXONOMY 同文，後 3 項是 cardnote 擴充（支持、反駁＝論證立場；實例＝舊 instance_of）
export const RELATION_TYPES = [
  "依賴",
  "延伸",
  "包含",
  "類比",
  "互補",
  "應用於",
  "導致",
  "改善",
  "張力",
  "取代",
  "限制",
  "鄰接",
  "指標於",
  "保護性限制",
  "支持",
  "反駁",
  "實例",
] as const;
export type RelationType = (typeof RELATION_TYPES)[number];
export type LinkStatus = "confirmed" | "hypothesis";

export const RELATION_LABELS: Record<RelationType, string> = {
  依賴: "依賴",
  延伸: "延伸／補充",
  包含: "包含",
  類比: "類比",
  互補: "互補",
  應用於: "應用於",
  導致: "導致",
  改善: "改善",
  張力: "張力（權衡／拮抗）",
  取代: "取代",
  限制: "限制",
  鄰接: "鄰接",
  指標於: "指標於",
  保護性限制: "保護性限制",
  支持: "支持",
  反駁: "反駁",
  實例: "是……的實例",
};

// 對稱類型沒有方向（與後端 SYMMETRIC_TYPES 同）：畫圖時不畫箭頭，資料庫只存 source_id < target_id 一種寫法
export const SYMMETRIC_RELATIONS: ReadonlySet<RelationType> = new Set<RelationType>(["類比", "互補", "鄰接", "張力"]);

// 與後端 CARD_RELATION_TYPES 的 category／is_tension 同文
export const RELATION_CATEGORIES: Record<RelationType, { category: string; isTension: boolean }> = {
  依賴: { category: "dependency", isTension: false },
  延伸: { category: "hierarchy", isTension: false },
  包含: { category: "hierarchy", isTension: false },
  類比: { category: "similarity", isTension: false },
  互補: { category: "complementary", isTension: false },
  應用於: { category: "application", isTension: false },
  導致: { category: "causality", isTension: false },
  改善: { category: "enhancement", isTension: false },
  張力: { category: "tension", isTension: true },
  取代: { category: "tension", isTension: true },
  限制: { category: "tension", isTension: true },
  鄰接: { category: "spatial", isTension: false },
  指標於: { category: "evidential", isTension: false },
  保護性限制: { category: "compensatory", isTension: false },
  支持: { category: "stance", isTension: false },
  反駁: { category: "stance", isTension: false },
  實例: { category: "instantiation", isTension: false },
};

// 顏色是暫定值：沿用舊六種的顏色，新增的依類別挑色，之後可依畫面調整
export const RELATION_COLORS: Record<RelationType, string> = {
  依賴: "#64748b",
  延伸: "#2f6fed",
  包含: "#1d4ed8",
  類比: "#0ea5e9",
  互補: "#14b8a6",
  應用於: "#0891b2",
  導致: "#d97706",
  改善: "#65a30d",
  張力: "#e11d48",
  取代: "#be123c",
  限制: "#9f1239",
  鄰接: "#94a3b8",
  指標於: "#8b5cf6",
  保護性限制: "#ca8a04",
  支持: "#16a34a",
  反駁: "#dc2626",
  實例: "#7c3aed",
};

export const LINK_STATUS_LABELS: Record<LinkStatus, string> = {
  confirmed: "已確認",
  hypothesis: "待驗證假說",
};

export interface CardLink {
  id: string;
  title: string;
  source_id?: string;
  target_id?: string;
  direction?: "outgoing" | "incoming";
  relation_type?: RelationType;
  status?: LinkStatus;
  reason?: string;
}

export interface BoardLink {
  source_id: string;
  target_id: string;
  card_a?: string;
  card_b?: string;
  relation_type: RelationType;
  status: LinkStatus;
  reason: string;
}

export interface BoardGroup {
  id: string;
  board_id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  created_at?: string;
}

export interface Tag {
  id: string;
  name: string;
  axis: Axis;
  facet?: string | null;
  definition?: string;
  parent_id: string | null;
  aliases?: string[];
}
export interface TagsResponse {
  tags: Tag[];
  unclassified_count: number;
  inbox_count?: number;
}
export interface TagResolveResponse {
  status: "exact_tag" | "exact_alias" | "ambiguous" | "similar" | "not_found";
  matched_alias?: string;
  tag: Tag | null;
  candidates: Tag[];
}
export interface Warning {
  code: string;
  ids: string[];
}
export interface CardDetail {
  id: string;
  title: string;
  body: string;
  card_type?: CardType;
  curation_status?: CurationStatus;
  file_path?: string | null;
  file_hash?: string | null;
  file_mtime?: number | null;
  updated_at: string;
  created_at: string;
  sources?: string[]; // 出處（多筆）；舊資料沒有此欄時視為 []
  tags: Tag[];
  links: CardLink[];
  boards: { id: string; name: string }[];
  warnings: Warning[];
}

export interface FileSyncResult {
  success: boolean;
  file_path: string;
  file_hash: string;
  mtime: number;
  has_backup: boolean;
  message: string;
}
export interface CardSummary {
  id: string;
  title: string;
  snippet: string;
  card_type?: CardType;
  curation_status?: CurationStatus;
  tags?: { id: string; name: string; axis: Axis; facet?: string | null }[];
  updated_at: string;
}

export interface ConceptGraphNode {
  id: string;
  name: string;
  axis: Axis;
  facet?: string | null;
  definition?: string;
  parent_id: string | null;
  aliases?: string[];
  card_count: number;
  is_bridge?: boolean;
}

export interface ConceptGraphEdge {
  source_id: string;
  target_id: string;
  co_count: number;
  jaccard: number;
}

export interface ConceptGraphResponse {
  nodes: ConceptGraphNode[];
  edges: ConceptGraphEdge[];
  hidden_edges: ConceptGraphEdge[];
}
export interface BoardSummary {
  id: string;
  name: string;
  card_count: number;
}
export interface BoardCard {
  card_id: string;
  x: number;
  y: number;
  w: number | null;
  h: number | null;
  z: number;
  title: string;
  body: string;
  updated_at: string;
}
export interface BoardData {
  id: string;
  name: string;
  cards: BoardCard[];
  links: BoardLink[];
  groups?: BoardGroup[];
}
export interface MediaInfo {
  id: string;
  kind: "image" | "video";
  mime: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  existed?: boolean;
}
export interface DeletePreview {
  child_count: number;
  card_count: number;
  new_parent: { id: string; name: string } | null;
  conflicts: string[];
}
export interface CardImpact {
  board_count: number;
  board_names: string[];
  link_count: number;
}
export interface CleanupResult {
  dry_run: boolean;
  orphans: { id: string; rel_path: string; byte_size: number }[];
  stray_files: string[];
}

export interface SyncMediaEntry {
  id: string;
  kind: "image" | "video";
  mime: string;
  byte_size: number;
}

export interface SyncPackage {
  version: number;
  exported_at: string;
  source_device: string;
  cards: CardDetail[];
  tags: Tag[];
  card_tags: { card_id: string; tag_id: string }[];
  links: BoardLink[];
  boards: { id: string; name: string }[];
  board_cards: { board_id: string; card_id: string; x?: number; y?: number; w?: number; h?: number }[];
  board_groups?: BoardGroup[];
  // 電腦端雲端備份才有：卡片引用的圖片清單，iPad 據此下載缺少的圖片
  media?: SyncMediaEntry[];
}

export interface SyncCardDiff {
  id: string;
  title: string;
  old_title?: string;
  new_title?: string;
  old_body?: string;
  new_body?: string;
  old_updated_at?: string;
  new_updated_at?: string;
}

export interface SyncDiffReport {
  source_device: string;
  exported_at: string;
  cards_new: { id: string; title: string; body: string; updated_at: string }[];
  cards_updated: SyncCardDiff[];
  cards_unchanged_count: number;
  tags_new: Tag[];
  tags_updated: Tag[];
  card_tags_new: { card_id: string; tag_id: string }[];
  links_new: BoardLink[];
  board_cards_new: { board_id: string; card_id: string }[];
}

export interface SyncApplyRequest {
  card_ids_to_add: string[];
  card_ids_to_update: string[];
  tag_ids_to_add: string[];
  tag_ids_to_update: string[];
  card_tags_to_add: { card_id: string; tag_id: string }[];
  links_to_add: BoardLink[];
  board_cards_to_add: { board_id: string; card_id: string }[];
  package: SyncPackage;
}


export interface SyncApplyResult {
  applied: {
    cards_added: number;
    cards_updated: number;
    tags_added: number;
    tags_updated: number;
    card_tags_added: number;
    links_added: number;
    board_cards_added: number;
    tags_merged?: number;
    board_cards_skipped?: number;
    boards_created?: number;
  };
}

// 關係句型的導引分類。值必須與後端 schemas.py 的 PatternFamily、種子腳本一致
export type PatternFamily = "failure" | "constraint" | "feedback" | "change" | "evidence";

export const PATTERN_FAMILIES: readonly PatternFamily[] = [
  "failure",
  "constraint",
  "feedback",
  "change",
  "evidence",
];

export interface PatternFamilyGuide {
  name: string;
  question: string;
  resultHint: string;
}

export const PATTERN_FAMILY_GUIDES: Record<PatternFamily, PatternFamilyGuide> = {
  failure: {
    name: "失效與承載",
    question: "有東西壞了、撐不住，或被拖累？",
    resultHint: "結果欄在寫：壞掉、過載、擴散",
  },
  constraint: {
    name: "卡住與限制",
    question: "被什麼卡住、限制，或要在兩件事之間選一個？",
    resultHint: "結果欄在寫：受限、付出代價",
  },
  feedback: {
    name: "回饋與調節",
    question: "這件事會回頭影響自己（拉回、放大、過頭、慢半拍）？",
    resultHint: "結果欄在寫：反覆、穩定、失控",
  },
  change: {
    name: "變化的形狀",
    question: "變化和原因不成比例，或到某個點突然改變？",
    resultHint: "結果欄在寫：突變、不成比例",
  },
  evidence: {
    name: "判讀與證據",
    question: "我看到的結果可能不是真的（不準、被誤導）？",
    resultHint: "結果欄在寫：誤判、失準",
  },
};

export interface RelationPattern {
  id: string;
  label: string;
  template: string;
  bridge_tag_id: string;
  bridge_name: string;
  note: string;
  family?: PatternFamily | null;
  use_count: number;
}

export interface RelationPatternCreate {
  label: string;
  template: string;
  bridge_tag_id: string;
  note?: string;
  family?: PatternFamily | null;
}

export interface RelationPatternPatch {
  label?: string;
  template?: string;
  note?: string;
  family?: PatternFamily;
}

export interface CardRelation {
  card_id: string;
  pattern_id: string | null;
  role_a: string;
  role_b: string;
  result: string;
  free_sentence: string;
  updated_at: string;
}

export interface CardRelationPut {
  pattern_id: string | null;
  role_a: string;
  role_b: string;
  result: string;
  free_sentence: string;
}

export interface BridgeCabinetStat {
  id: string;
  name: string;
  card_count: number;
}

export interface BridgeStat {
  id: string;
  name: string;
  card_count: number;
  card_ratio: number;
  unfiled_count: number;
  cabinet_count: number;
  cabinets: BridgeCabinetStat[];
}

export interface RelationInconsistency {
  card_id: string;
  title: string;
  pattern_id: string;
  pattern_label: string;
  bridge_tag_id: string;
  bridge_name: string;
}

export interface RelationCandidate {
  card_id: string;
  title: string;
  free_sentence: string;
  updated_at: string;
}

export interface RelationsReport {
  total_cards: number;
  bridges: BridgeStat[];
  inconsistencies: RelationInconsistency[];
  candidates: RelationCandidate[];
}

// 今日總結（日誌）。值必須與後端 schemas.py 的 DailyStatus／DailyChangeKind 一致
export type DailyStatus = "recalling" | "comparing" | "done";
export type DailyChangeKind = "new" | "updated";

export interface DailyStream {
  id: string;
  day: string; // 用戶端本地日期 YYYY-MM-DD
  position: number;
  title: string;
  status: DailyStatus;
  recall_text: string;
  review_text: string;
  peeked_at: string | null;
  unlocked_at: string | null;
  converted_card_id: string | null;
  created_at: string;
  updated_at: string;
  cards: { id: string; title: string }[];
}

export interface DailyChange {
  id: string;
  title: string;
  body: string;
  card_type: CardType;
  created_at: string;
  updated_at: string;
  kind: DailyChangeKind;
}

export interface DailyChangesResponse {
  items: DailyChange[];
  truncated: boolean;
}

