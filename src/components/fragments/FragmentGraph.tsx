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

  // After graph ready tweak physics and forces
  useEffect(() => {
    if (fgRef.current) {
      // MUCH stronger negative charge for global repulsion
      fgRef.current.d3Force("charge").strength(-16);

      // Ensure connected nodes have plenty of space for labels
      fgRef.current.d3Force("link")
        .distance(150)     // target distance between connected nodes
        .strength(0.3);    // how strongly links pull/push (lower = more spacing)

      // Add collision detection to prevent node overlap
      fgRef.current.d3Force("collide")
        ?.radius((n: any) => 30 + (n.link_count || 0))  // minimum space between nodes
        .strength(0.9);    // how strongly nodes push each other away
    }
  }, [data]);

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
        d3VelocityDecay={0.2}        // lower = more movement
        d3AlphaDecay={0.01}         // lower = longer simulation
        cooldownTime={5000}         // ms to run physics sim
        linkDirectionalParticles={2} // animated dots on links
        linkDirectionalParticleWidth={2}
        graphData={visible}
        nodeId="slug"
        nodeLabel={(n: Node) => n.slug}
        linkDistance={120}           // target link length
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={1}
        linkColor={() => "#F4812080"}
        nodeRelSize={5}
        nodeVal={(n: Node) => 1 + n.link_count / 3}
        enableNodeDrag={true}
        warmupTicks={100}
        cooldownTicks={200}
        onNodeClick={(node: Node) => {
          onNavigateToFragment(node.slug);
        }}
        nodeCanvasObjectMode={() => "replace"} // complete control over node rendering
        nodeCanvasObject={(node: Node, ctx, globalScale) => {
          const radius = Math.max(8, 5 + node.link_count); // bigger nodes

          // Orange circle with slight darker border
          ctx.beginPath();
          ctx.arc(node.x as number, node.y as number, radius, 0, 2 * Math.PI, false);
          ctx.fillStyle = "#F48120";
          ctx.fill();
          ctx.strokeStyle = "#D46100";
          ctx.lineWidth = 1;
          ctx.stroke();

          // Always-visible node label (white text on dark pill)
          const label = node.slug;
          const fontSize = 12 / globalScale;
          ctx.font = `${fontSize}px sans-serif`;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";

          const textX = (node.x as number) + radius + 5; // more space from node
          const textY = node.y as number;
          const textW = ctx.measureText(label).width;
          const pad = 4; // more padding

          // Rounded dark background pill
          const rectHeight = fontSize + pad * 2;
          const rectWidth = textW + pad * 2;
          const cornerRadius = rectHeight / 3;

          ctx.fillStyle = "rgba(0,0,0,0.85)"; // darker for better contrast
          ctx.beginPath();
          ctx.moveTo(textX - pad + cornerRadius, textY - fontSize / 2 - pad);
          ctx.lineTo(textX - pad + rectWidth - cornerRadius, textY - fontSize / 2 - pad);
          ctx.arc(textX - pad + rectWidth - cornerRadius, textY - fontSize / 2 - pad + cornerRadius, cornerRadius, 3 * Math.PI / 2, 0, false);
          ctx.lineTo(textX - pad + rectWidth, textY - fontSize / 2 - pad + rectHeight - cornerRadius);
          ctx.arc(textX - pad + rectWidth - cornerRadius, textY - fontSize / 2 - pad + rectHeight - cornerRadius, cornerRadius, 0, Math.PI / 2, false);
          ctx.lineTo(textX - pad + cornerRadius, textY - fontSize / 2 - pad + rectHeight);
          ctx.arc(textX - pad + cornerRadius, textY - fontSize / 2 - pad + rectHeight - cornerRadius, cornerRadius, Math.PI / 2, Math.PI, false);
          ctx.lineTo(textX - pad, textY - fontSize / 2 - pad + cornerRadius);
          ctx.arc(textX - pad + cornerRadius, textY - fontSize / 2 - pad + cornerRadius, cornerRadius, Math.PI, 3 * Math.PI / 2, false);
          ctx.closePath();
          ctx.fill();

          // White text
          ctx.fillStyle = "#FFFFFF";
          ctx.fillText(label, textX, textY);
        }}
        linkColor={() => "#F4812080"}
        linkCanvasObjectMode={() => "after"}
        linkCanvasObject={(link: Link, ctx, globalScale) => {
          const LABEL = link.type ?? "";
          if (!LABEL) return;
          const start = link.source as Node;
          const end = link.target as Node;
          if (typeof start === "string" || typeof end === "string") return;

          // midpoint of the line
          const midX = (start.x! + end.x!) / 2;
          const midY = (start.y! + end.y!) / 2;

          const fontSize = Math.max(6, 10 / globalScale);
          ctx.font = `${fontSize}px sans-serif`;
          const textWidth = ctx.measureText(LABEL).width;
          const padding = 4; // more padding
          const cornerRadius = fontSize / 2;

          // Rounded dark rectangle background for better visibility
          const rectHeight = fontSize + padding * 2;
          const rectWidth = textWidth + padding * 2;

          ctx.fillStyle = "rgba(0,0,0,0.85)"; // darker for better contrast
          ctx.beginPath();
          ctx.moveTo(midX - textWidth / 2 - padding + cornerRadius, midY - fontSize / 2 - padding);
          ctx.lineTo(midX + textWidth / 2 + padding - cornerRadius, midY - fontSize / 2 - padding);
          ctx.arc(midX + textWidth / 2 + padding - cornerRadius, midY - fontSize / 2 - padding + cornerRadius, cornerRadius, 3 * Math.PI / 2, 0, false);
          ctx.lineTo(midX + textWidth / 2 + padding, midY + fontSize / 2 + padding - cornerRadius);
          ctx.arc(midX + textWidth / 2 + padding - cornerRadius, midY + fontSize / 2 + padding - cornerRadius, cornerRadius, 0, Math.PI / 2, false);
          ctx.lineTo(midX - textWidth / 2 - padding + cornerRadius, midY + fontSize / 2 + padding);
          ctx.arc(midX - textWidth / 2 - padding + cornerRadius, midY + fontSize / 2 + padding - cornerRadius, cornerRadius, Math.PI / 2, Math.PI, false);
          ctx.lineTo(midX - textWidth / 2 - padding, midY - fontSize / 2 - padding + cornerRadius);
          ctx.arc(midX - textWidth / 2 - padding + cornerRadius, midY - fontSize / 2 - padding + cornerRadius, cornerRadius, Math.PI, 3 * Math.PI / 2, false);
          ctx.closePath();
          ctx.fill();

          // white text
          ctx.fillStyle = "#FFFFFF";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(LABEL, midX, midY);
        }}
      />
    </div>
  );
}
