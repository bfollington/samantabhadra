import { useEffect, useState, useRef } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import { ArrowClockwise, X, MagnifyingGlass } from "@phosphor-icons/react";
import ForceGraph2D, {
  type NodeObject,
  type LinkObject,
} from "react-force-graph-2d";

interface Node extends NodeObject {
  id: string; // slug string (unique)
  slug: string;
  link_count: number;
}

interface Link extends LinkObject {
  source: string; // slug of source
  target: string; // slug of target
  type: string;
  weight: number;
}

interface Props {
  onClose: () => void;
  onNavigateToFragment: (slug: string) => void;
}

export function FragmentGraph({ onClose, onNavigateToFragment }: Props) {
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] } | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const fgRef = useRef<any>(null);

  // Fetch graph data once
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(
          "/agents/chat/default/fragment-graph?limit=1000"
        );
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as {
          nodes: Node[];
          links: Link[];
        };
        setData(json);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Filtered visible subgraph
  const visible = data
    ? {
      nodes: data.nodes.filter((n) =>
        filter
          ? n.slug.toLowerCase().includes(filter.toLowerCase())
          : true
      ),
      links: data.links.filter(
        (l) =>
          !filter ||
          (typeof l.source === "string"
            ? l.source.toLowerCase().includes(filter.toLowerCase())
            : false) ||
          (typeof l.target === "string"
            ? l.target.toLowerCase().includes(filter.toLowerCase())
            : false)
      ),
    }
    : { nodes: [], links: [] };

  /* -------------------- Rendering --------------------- */
  if (loading) {
    return (
      <Card className="m-4 p-4 flex items-center gap-2">
        <ArrowClockwise className="animate-spin" size={16} /> Building graph…
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="m-4 p-4 text-red-500">Error: {error}</Card>
    );
  }

  return (
    <div className="fixed inset-0 z-30 bg-white dark:bg-neutral-950">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">Fragment Graph ({data?.nodes.length})</h2>
          <div className="relative">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="pl-6 pr-2 py-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent text-sm outline-none"
            />
            <MagnifyingGlass
              size={14}
              className="absolute left-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
          </div>
        </div>
        <Button
          variant="ghost"
          size="md"
          shape="square"
          className="rounded-full h-9 w-9"
          onClick={onClose}
        >
          <X size={20} />
        </Button>
      </div>

      {/* Graph */}
      <ForceGraph2D
        ref={fgRef}
        graphData={visible}
        nodeId="slug"
        nodeLabel={(n: Node) => n.slug}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        linkColor={() => "#8884"}
        nodeRelSize={4}
        nodeVal={(n: Node) => 1 + n.link_count / 5}
        enableNodeDrag={false}
        warmupTicks={30}
        cooldownTicks={150}
        onNodeClick={(node: Node) => {
          onNavigateToFragment(node.slug);
        }}
        nodeCanvasObject={(node: Node, ctx, globalScale) => {
          const label = node.slug;
          const fontSize = 12 / globalScale;
          ctx.font = `${fontSize}px sans-serif`;
          const textWidth = ctx.measureText(label).width;
          const padding = 4;
          const bckgDimensions = [textWidth + padding * 2, fontSize + padding * 2];

          ctx.fillStyle = "rgba(0,0,0,0.7)";
          ctx.fillRect(
            (node.x as number) - bckgDimensions[0] / 2,
            (node.y as number) - fontSize / 2 - padding,
            bckgDimensions[0],
            bckgDimensions[1]
          );

          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, node.x as number, node.y as number);

          // Save dimensions for pointer interaction
          (node as any).__bckgDimensions = bckgDimensions;
        }}
        nodePointerAreaPaint={(node: Node, color, ctx) => {
          const bckgDimensions = (node as any).__bckgDimensions;
          if (!bckgDimensions) return;
          ctx.fillStyle = color;
          ctx.fillRect(
            (node.x as number) - bckgDimensions[0] / 2,
            (node.y as number) - bckgDimensions[1] / 2,
            bckgDimensions[0],
            bckgDimensions[1]
          );
        }}
      />
    </div>
  );
}
