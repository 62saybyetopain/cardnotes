import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { BoardLink, CardDetail } from "../types";
import { Editor } from "./Editor";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown, notifyCardTitleUpdated } from "./Markdown";

export interface CardNodeData extends Record<string, unknown> {
  title: string;
  body: string;
  updatedAt?: string;
  sized: boolean;
  onResizeEnd: (cardId: string, p: { x: number; y: number; width: number; height: number }) => void;
  onOpenCard?: (cardId: string) => void;
  onCardSaved?: (card: CardDetail) => void;
  onLinkAdded?: (sourceId: string, targetId: string, extra?: Partial<BoardLink>) => void;
  report?: (e: unknown, prefix?: string) => void;
}
export type CardFlowNode = Node<CardNodeData, "card">;

export function CardNode({ id, data, selected }: NodeProps<CardFlowNode>) {
  const [inlineEditing, setInlineEditing] = useState(false);
  const [editingCard, setEditingCard] = useState<CardDetail | null>(null);
  const [loadingEdit, setLoadingEdit] = useState(false);

  // 取消選取卡片時，自動結束白板內嵌編輯（Editor 卸載時會自動儲存未存檔內容）
  useEffect(() => {
    if (!selected && inlineEditing) {
      setInlineEditing(false);
      setEditingCard(null);
    }
  }, [selected, inlineEditing]);

  const startInlineEdit = async (e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (inlineEditing || loadingEdit) return;
    setLoadingEdit(true);
    try {
      const full = await api.getCard(id);
      setEditingCard(full);
      setInlineEditing(true);
    } catch (err) {
      data.report?.(err, "載入卡片編輯器失敗");
    } finally {
      setLoadingEdit(false);
    }
  };

  return (
    <ErrorBoundary fallback={<div className="card-node card-error">此卡片顯示失敗（{id.slice(0, 8)}）</div>}>
      <div
        className={`card-node${selected ? " selected" : ""}${data.sized || inlineEditing ? " sized" : ""}`}
        style={inlineEditing ? { minWidth: 340, zIndex: 20 } : undefined}
      >
        <NodeResizer
          minWidth={inlineEditing ? 320 : 180}
          minHeight={inlineEditing ? 220 : 80}
          isVisible={true}
          onResizeEnd={(_e, p) => data.onResizeEnd(id, p)}
        />
        <Handle type="target" position={Position.Left} />

        {inlineEditing && editingCard ? (
          <div
            className="card-inline-editor"
            style={{ display: "flex", flexDirection: "column", height: "100%", gap: 4 }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                paddingBottom: 4,
                borderBottom: "1px solid var(--line, #334155)",
                cursor: "grab",
                fontSize: 11,
              }}
              title="按住此處可拖曳卡片；雙擊進入中間編輯模式"
            >
              <span className="muted">⠿ 白板直接編輯（雙擊標題列進中間模式）</span>
              <span className="nodrag" style={{ display: "inline-flex", gap: 4 }}>
                {data.onOpenCard && (
                  <button
                    type="button"
                    style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setInlineEditing(false);
                      data.onOpenCard?.(id);
                    }}
                    title="切換至中間編輯模式"
                  >
                    ⤢ 中間編輯
                  </button>
                )}
                <button
                  type="button"
                  className="primary"
                  style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setInlineEditing(false);
                    setEditingCard(null);
                  }}
                >
                  ✓ 完成
                </button>
              </span>
            </div>
            <div
              className="nodrag nowheel"
              style={{ flex: 1, overflow: "auto", cursor: "text" }}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Editor
                key={`${editingCard.id}:${editingCard.updated_at}`}
                card={editingCard}
                compact={true}
                onSaved={(updated) => {
                  notifyCardTitleUpdated(updated.id, updated.title);
                  data.onCardSaved?.(updated);
                }}
                onReload={() => void startInlineEdit()}
                onLinkAdded={data.onLinkAdded}
                onOpenCard={data.onOpenCard}
                report={data.report ?? (() => {})}
              />
            </div>
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 6,
                marginBottom: "0.5rem",
              }}
            >
              <div
                className="card-title"
                style={{
                  fontSize: "1.15rem",
                  fontWeight: 700,
                  lineHeight: 1.35,
                  wordBreak: "break-word",
                  flex: 1,
                }}
              >
                {data.title || "（無標題）"}
              </div>
              <button
                type="button"
                className="nodrag"
                style={{
                  fontSize: 11,
                  padding: "1px 6px",
                  opacity: selected ? 0.95 : 0.55,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
                onClick={(e) => void startInlineEdit(e)}
                title="直接在白板上編輯此卡片（雙擊卡片則進入中間編輯模式）"
              >
                {loadingEdit ? "…" : "✎ 編輯"}
              </button>
            </div>
            <div className="card-body">
              <Markdown source={data.body} onOpenCard={data.onOpenCard} />
            </div>
          </>
        )}

        <Handle type="source" position={Position.Right} />
      </div>
    </ErrorBoundary>
  );
}
