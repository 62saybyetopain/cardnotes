// 全文尋找（編輯器的標示與跳轉共用）：不分大小寫的「字面」比對，查詢字串不是正規表示式
export function findRanges(text: string, query: string, limit = 2000): { from: number; to: number }[] {
  if (!query) return [];
  const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  const out: { from: number; to: number }[] = [];
  let m: RegExpExecArray | null;
  while (out.length < limit && (m = re.exec(text)) !== null) {
    out.push({ from: m.index, to: m.index + m[0].length });
  }
  return out;
}