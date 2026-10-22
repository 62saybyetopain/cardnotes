import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown } from "./Markdown";

export interface CardNodeData extends Record<string, unknown> {
  title: string;
  body: string;
  updatedAt?: string;
  sized: boolean;
  onResizeEnd: (cardId: string, p: { x: number; y: number; width: number; height: number }) => void;
  onOpenCard?: (cardId: string) => void;
  report?: (e: unknown, prefix?: string) => void;
}
export type CardFlowNode = Node<CardNodeData, "card">;

export function CardNode({ id, data, selected }: NodeProps<CardFlowNode>) {
  return (
    <ErrorBoundary fallback={<div className="card-node card-error">此卡片顯示失敗（{id.slice(0, 8)}）</div>}>
      <div
        className={`card-node${selected ? " selected" : ""}${data.sized ? " sized" : ""}`}
      >
        <NodeResizer
          minWidth={180}
          minHeight={80}
          isVisible={true}
          onResizeEnd={(_e, p) => data.onResizeEnd(id, p)}
        />
        <Handle type="target" position={Position.Left} />

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
        </div>
        <div className="card-body">
          <Markdown source={data.body} onOpenCard={data.onOpenCard} />
        </div>

        <Handle type="source" position={Position.Right} />
      </div>
    </ErrorBoundary>
  );
}
