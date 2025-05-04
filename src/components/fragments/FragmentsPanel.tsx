import { useEffect, useState, useRef } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import {
  ArrowClockwise,
  X,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { FragmentViewer } from "./FragmentViewer";
import { FragmentGraph } from "./FragmentGraph";

const PAGE_SIZE = 50;

interface Fragment {
  id: string;
  slug: string;
  content: string;
  speaker?: string | null;
  created: string;
  modified: string;
  link_count: number;
}

interface Props {
  onClose: () => void;
}

export function FragmentsPanel({ onClose }: Props) {
  // ─────────────────────── state ────────────────────────────────
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState<string>("");
  const [viewingFragment, setViewingFragment] = useState<string | null>(null);
  const [showGraph, setShowGraph] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─────────────────────── helpers ───────────────────────────────
  const fetchFragments = async (reset = false) => {
    try {
      setLoading(true);
      const offset = reset ? 0 : fragments.length;
      const res = await fetch(
        `/agents/chat/default/list-fragments?limit=${PAGE_SIZE}&offset=${offset}` +
          (search ? `&q=${encodeURIComponent(search)}` : "")
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const json = (await res.json()) as { total: number; items: Fragment[] };

      setTotal(json.total);
      setFragments((prev) => (reset ? json.items : [...prev, ...json.items]));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // initial load + possible stored fragment
  useEffect(() => {
    fetchFragments(true);

    const storedSlug = sessionStorage.getItem("openFragmentSlug");
    if (storedSlug) {
      setViewingFragment(storedSlug);
      sessionStorage.removeItem("openFragmentSlug");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced search reload
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchFragments(true);
    }, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const hasMore = total !== null && fragments.length < total;

  // ─────────────────────── render switches ───────────────────────
  if (viewingFragment) {
    return (
      <FragmentViewer
        slug={viewingFragment}
        onClose={() => setViewingFragment(null)}
        onNavigateToFragment={(slug) => setViewingFragment(slug)}
      />
    );
  }

  if (showGraph) {
    return (
      <FragmentGraph
        onClose={() => setShowGraph(false)}
        onNavigateToFragment={(slug) => {
          setShowGraph(false);
          setViewingFragment(slug);
        }}
      />
    );
  }

  if (loading && fragments.length === 0) {
    return (
      <Card className="m-4 p-4 flex items-center gap-2">
        <ArrowClockwise className="animate-spin" size={16} /> Loading
        fragments…
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="m-4 p-4 text-red-500">Error: {error}</Card>
    );
  }

  // ─────────────────────── main list UI ──────────────────────────
  return (
    <div className="fixed inset-0 z-20 bg-white dark:bg-neutral-950 overflow-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between p-3 border-b border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <div className="flex items-center gap-3">
          <h2 className="font-semibold">
            Fragments ({fragments.length}
            {total !== null ? ` / ${total}` : ""})
          </h2>
          {/* Graph toggle */}
          <Button variant="secondary" size="sm" onClick={() => setShowGraph(true)}>
            Graph
          </Button>
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

      {/* Search bar */}
      <div className="p-3 flex items-center gap-2">
        <div className="relative flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search fragments…"
            className="w-full px-8 py-2 rounded-md border border-neutral-300 dark:border-neutral-800 bg-transparent outline-none"
          />
          <MagnifyingGlass
            size={16}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
        </div>
      </div>

      {/* Table */}
      <div className="p-4 max-w-6xl mx-auto overflow-x-auto">
        <table className="min-w-full text-sm border rounded-md">
          <thead>
            <tr className="bg-neutral-100 dark:bg-neutral-900">
              <th className="px-3 py-2 text-left">Slug</th>
              <th className="px-3 py-2 text-left">Speaker</th>
              <th className="px-3 py-2 text-center">Links</th>
              <th className="px-3 py-2 text-left">Content</th>
              <th className="px-3 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            {fragments.map((f) => (
              <tr
                key={f.id}
                className="border-t border-neutral-200 dark:border-neutral-800"
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  <button
                    onClick={() => setViewingFragment(f.slug)}
                    className="text-[#F48120] hover:underline font-medium"
                  >
                    {f.slug}
                  </button>
                </td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {f.speaker ?? "-"}
                </td>
                <td className="px-3 py-2 text-center">{f.link_count}</td>
                <td className="px-3 py-2 max-w-[400px] truncate">{f.content}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  {new Date(f.created).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Load more */}
        {hasMore && (
          <div className="flex justify-center my-6">
            <Button disabled={loading} onClick={() => fetchFragments(false)}>
              {loading ? (
                <>
                  <ArrowClockwise size={16} className="animate-spin mr-1" />
                  Loading…
                </>
              ) : (
                "Load more"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
