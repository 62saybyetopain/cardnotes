export const MEDIA_SCHEME = "media:";
const ACCEPTED = /^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm))$/;

export const isAcceptedMime = (mime: string) => ACCEPTED.test(mime);

export const mediaRef = (id: string) => `![](media:${id})`;

export const mediaUrl = (id: string) => `/api/media/${id}`;

/** 把 media:<id> 轉成後端網址；其他網址原樣回傳。 */
export function mediaIdFromSrc(src: string | undefined): string | null {
  if (!src) return null;
  if (src.startsWith(MEDIA_SCHEME)) return src.slice(MEDIA_SCHEME.length);
  const m = /^\/api\/media\/([0-9a-fA-F-]{36})$/.exec(src);
  return m ? m[1] : null;
}

/** 在 [start, end) 的選取範圍以 insert 取代，回傳新文字與新的游標位置。 */
export function insertAtCursor(text: string, start: number, end: number, insert: string) {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return { text: text.slice(0, s) + insert + text.slice(e), cursor: s + insert.length };
}

/** 內文裡引用的 media id（去重，保持順序）。 */
export function extractMediaIds(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/!\[[^\]]*\]\(media:([0-9a-fA-F-]{36})\)/g)) {
    const id = m[1].toLowerCase();
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** react-markdown 的 urlTransform：只放行 media:（轉成本機網址）、http(s)、mailto。 */
export function urlTransform(url: string): string {
  if (url.startsWith(MEDIA_SCHEME)) return mediaUrl(url.slice(MEDIA_SCHEME.length));
  if (/^(https?:|mailto:|#|\/)/i.test(url)) return url;
  return "";
}
