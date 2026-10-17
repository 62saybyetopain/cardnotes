import type { Tag } from "../types";

export interface TreeNode {
  tag: Tag;
  children: TreeNode[];
}

export function isSameAxisGroup(a: Tag["axis"], b: Tag["axis"]): boolean {
  const norm = (x: Tag["axis"]) => (x === "domain" ? "location" : x === "free" ? "concept" : x);
  return norm(a) === norm(b);
}

export function buildTree(tags: Tag[], axis: Tag["axis"]): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  for (const t of tags) if (isSameAxisGroup(t.axis, axis)) nodes.set(t.id, { tag: t, children: [] });
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.tag.parent_id ? nodes.get(n.tag.parent_id) : undefined;
    (parent ? parent.children : roots).push(n);
  }
  const sort = (list: TreeNode[]) => {
    list.sort((a, b) => a.tag.name.localeCompare(b.tag.name, "zh-Hant"));
    list.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}

/** 某標籤的所有後代 id（含自己）。 */
export function descendantIds(tags: Tag[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tags) if (t.parent_id && out.has(t.parent_id) && !out.has(t.id)) (out.add(t.id), (grew = true));
  }
  return out;
}

export function tagPath(tags: Tag[], id: string): string {
  const byId = new Map(tags.map((t) => [t.id, t]));
  const parts: string[] = [];
  for (let cur = byId.get(id); cur; cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) parts.unshift(cur.name);
  return parts.join(" / ");
}
