import { useEffect, useState } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import { ArrowClockwise, X } from "@phosphor-icons/react";

interface Fragment {
  id: string;
  slug: string;
  content: string;
  speaker?: string | null;
  ts: string;
  created: string;
  modified: string;
}

interface Props {
  onClose: () => void;
}

export function FragmentsPanel({ onClose }: Props) {
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchFragments = async () => {
    try {
      setLoading(true);
      const res = await fetch("/agents/chat/default/list-fragments");
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      setFragments(data as Fragment[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFragments();
  }, []);

  if (loading) {
    return (
      <Card className="m-4 p-4 flex items-center gap-2">
        <ArrowClockwise className="animate-spin" size={16} /> Loading fragments…
      </Card>
    );
  }
  if (error) {
    return (
      <Card className="m-4 p-4 text-red-500">Error loading fragments: {error}</Card>
    );
  }

  return (
    <div className="fixed inset-0 z-20 bg-white dark:bg-neutral-950 overflow-auto">
      <div className="sticky top-0 z-10 flex items-center justify-between p-3 border-b border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-950">
        <h2 className="font-semibold">Fragments ({fragments.length})</h2>
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

      <div className="p-4 max-w-5xl mx-auto overflow-x-auto">
        <table className="min-w-full text-sm border rounded-md">
          <thead>
            <tr className="bg-neutral-100 dark:bg-neutral-900">
              <th className="px-3 py-2 text-left">Slug</th>
              <th className="px-3 py-2 text-left">Speaker</th>
              <th className="px-3 py-2 text-left">Content</th>
              <th className="px-3 py-2 text-left">Created</th>
            </tr>
          </thead>
          <tbody>
            {fragments.map((f) => (
              <tr key={f.id} className="border-t border-neutral-200 dark:border-neutral-800">
                <td className="px-3 py-2 whitespace-nowrap text-[#F48120] font-medium">{f.slug}</td>
                <td className="px-3 py-2 whitespace-nowrap">{f.speaker ?? "-"}</td>
                <td className="px-3 py-2 max-w-[400px] truncate">{f.content}</td>
                <td className="px-3 py-2 whitespace-nowrap">{new Date(f.created).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
