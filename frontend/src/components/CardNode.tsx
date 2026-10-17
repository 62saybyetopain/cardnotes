import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { Markdown } from "./Markdown";

export interface CardNodeData extends Record<string, unknown> {
  title: string;
  body: string;
  sized: boolean;
  onResizeEnd: (cardId: string, p: { x: number; y: number; width: number; height: number }) => void;
  onOpenCard?: (cardId: string) => void;
}
export type CardFlowNode = Node<CardNodeData, "card">;

export function CardNode({ id, data, selected }: NodeProps<CardFlowNode>) {
  return (
    <ErrorBoundary fallback={<div className="card-node card-error">此卡片顯示失敗（{id.slice(0, 8)}）</div>}>
      <div
        className={`card-node${selected ? " selected" : ""}${data.sized ? " sized" : ""}`}
        onClick={(e) => {
          if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
            data.onOpenCard?.(id);
          }
        }}
      >
        <NodeResizer
          minWidth={180}
          minHeight={80}
          isVisible={true}
          onResizeEnd={(_e, p) => data.onResizeEnd(id, p)}
        />
        <Handle type="target" position={Position.Left} />
        <div className="card-title">{data.title || "（無標題）"}</div>
        <div className="card-body">
          <Markdown source={data.body} />
        </div>
        <Handle type="source" position={Position.Right} />
      </div>
    </ErrorBoundary>
  );
}
