// 提及建議：卡片文字裡提到、但還沒建立的概念標籤與其他卡片（對應 Obsidian 的「未連結的提及」）。
// 只比對文字、只提出建議：按下按鈕才會寫入，沒有建議時整個面板不顯示。
// @depends-on ../api.ts (api.listTags, api.assignTag)
// @depends-on ../lib/mentions.ts (findTagMentions, findCardMentions)
// @depends-on ../types.ts (CardDetail, Tag)
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { findCardMentions, findTagMentions, type MentionSnippet } from "../lib/mentions";
import type { CardDetail, Tag } from "../types";

interface Props {
  card: CardDetail;
  onChanged(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
  /** 全部卡片的標題清單，用於「提到其他卡片」；沒提供就只做標籤建議 */
  loadCardTitles?(): Promise<{ id: string; title: string }[]>;
  /** 使用者按「連結…」時的處理；沒提供就不顯示該按鈕 */
  onRequestLink?(target: { id: string; title: string }): void;
}

function Snippet({ s }: { s: MentionSnippet }) {
  return (
    <span className="snippet">
      …{s.before}
      <mark>{s.match}</mark>
      {s.after}…
    </span>
  );
}

export function MentionPanel({ card, onChanged, report, info, loadCardTitles, onRequestLink }: Props) {
  const [tags, setTags] = useState<Tag[]>([]);
  const [titles, setTitles] = useState<{ id: string; title: string }[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  // 換卡片時，上一張卡片按過「略過」的紀錄不帶過來
  useEffect(() => {
    setDismissed(new Set());
  }, [card.id]);

  // 卡片存檔後 updated_at 會變，順便重讀標籤清單（可能剛在別處新增了標籤或別名）
  useEffect(() => {
    let alive = true;
    api
      .listTags()
      .then((r) => alive && setTags(r.tags))
      .catch((e) => alive && report(e, "讀取標籤失敗"));
    return () => {
      alive = false;
    };
  }, [card.id, card.updated_at, report]);

  useEffect(() => {
    if (!loadCardTitles) return;
    let alive = true;
    loadCardTitles()
      .then((r) => alive && setTitles(r))
      .catch((e) => alive && report(e, "讀取卡片標題失敗"));
    return () => {
      alive = false;
    };
  }, [card.id, card.updated_at, loadCardTitles, report]);

  const text = `${card.title}\n${card.body}`;
  const tagMentions = useMemo(
    () => findTagMentions(text, tags, new Set(card.tags.map((t) => t.id))).filter((m) => !dismissed.has(`tag:${m.tag.id}`)),
    [text, tags, card.tags, dismissed],
  );
  const cardMentions = useMemo(
    () =>
      findCardMentions(text, titles, card.id, new Set(card.links.map((l) => l.id))).filter(
        (m) => !dismissed.has(`card:${m.card.id}`),
      ),
    [text, titles, card.id, card.links, dismissed],
  );

  const dismiss = (key: string) => setDismissed((prev) => new Set(prev).add(key));

  const assign = async (t: Tag) => {
    try {
      await api.assignTag(card.id, t.id);
      info(`已為這張卡片加上標籤「${t.name}」`);
      onChanged();
    } catch (e) {
      report(e, "加入標籤失敗");
    }
  };

  if (tagMentions.length === 0 && cardMentions.length === 0) return null;

  return (
    <div className="mention-panel">
      {tagMentions.length > 0 && (
        <>
          <h4>文中提到、尚未加入的概念標籤（{tagMentions.length}）</h4>
          <ul className="results">
            {tagMentions.map((m) => (
              <li key={m.tag.id}>
                <span className="result-main">
                  <strong>{m.tag.name}</strong>
                  {m.tag.facet && <span className="facet-badge">{m.tag.facet}</span>}
                  {m.via === "alias" && <span className="muted">（別名「{m.term}」）</span>}
                  {m.count > 1 && <span className="muted"> ×{m.count}</span>}
                  <br />
                  <Snippet s={m.snippet} />
                </span>
                <button className="primary" onClick={() => void assign(m.tag)}>
                  加入標籤
                </button>
                <button onClick={() => dismiss(`tag:${m.tag.id}`)}>略過</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {cardMentions.length > 0 && (
        <>
          <h4>文中提到、尚未連結的卡片（{cardMentions.length}）</h4>
          <ul className="results">
            {cardMentions.map((m) => (
              <li key={m.card.id}>
                <span className="result-main">
                  <strong>{m.card.title}</strong>
                  {m.count > 1 && <span className="muted"> ×{m.count}</span>}
                  <br />
                  <Snippet s={m.snippet} />
                </span>
                {onRequestLink && (
                  <button className="primary" onClick={() => onRequestLink({ id: m.card.id, title: m.card.title })}>
                    連結…
                  </button>
                )}
                <button onClick={() => dismiss(`card:${m.card.id}`)}>略過</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="muted" style={{ fontSize: 11 }}>
        系統只比對文字，按下按鈕才會寫入。
      </div>
    </div>
  );
}
