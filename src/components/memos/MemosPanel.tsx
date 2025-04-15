import { useEffect, useState } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import { MemoViewer } from "./MemoViewer";
import { X } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";

interface Memo {
  id: string;
  slug: string;
  content: string;
  headers: string;
  links: string;
  created: string;
  modified: string;
}

interface MemosPanelProps {
  onClose: () => void;
}

export function MemosPanel({ onClose }: MemosPanelProps) {
  const [memos, setMemos] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedMemo, setSelectedMemo] = useState<Memo | null>(null);

  useEffect(() => {
    const fetchMemos = async () => {
      try {
        setLoading(true);
        const response = await fetch("/agents/chat/default/list-memos");
        if (!response.ok) {
          throw new Error(`Failed to fetch memos: ${response.status}`);
        }
        const data = await response.json();
        setMemos(data as Memo[]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load memos");
      } finally {
        setLoading(false);
      }
    };

    fetchMemos();
  }, []);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  };

  // Function to truncate content for display
  const truncateContent = (content: string, maxLength: number = 100) => {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + "...";
  };

  if (loading) {
    return (
      <Card className="p-4 m-4">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#F48120]"></div>
          <span className="ml-2">Loading memos...</span>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="p-4 m-4 border-red-500">
        <div className="text-red-500">Error: {error}</div>
      </Card>
    );
  }

  // Parse headers to get topic and keywords if available
  const parseHeaders = (headersString: string) => {
    try {
      const headers = JSON.parse(headersString);
      return headers;
    } catch {
      return {};
    }
  };

  if (selectedMemo) {
    return <MemoViewer memo={selectedMemo} onClose={() => setSelectedMemo(null)} />;
  }

  return (
    <div className="fixed inset-0 z-20 bg-white dark:bg-neutral-950 overflow-auto">
      <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex justify-between items-center">
        <h2 className="font-semibold">Memos ({memos.length})</h2>
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
      
      <div className="p-4">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[#F48120]"></div>
            <span className="ml-2">Loading memos...</span>
          </div>
        )}

        {error && !loading && (
          <Card className="p-4 border-red-500">
            <div className="text-red-500">Error: {error}</div>
          </Card>
        )}
        
        {!loading && !error && memos.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">No memos found</div>
        )}
        
        {!loading && !error && memos.length > 0 && (
          <div className="grid grid-cols-2 gap-4 max-w-5xl mx-auto">
            {memos.map((memo) => {
              const headers = parseHeaders(memo.headers);
              return (
                <div 
                  key={memo.id} 
                  className="overflow-hidden flex flex-col hover:shadow-md transition-shadow duration-200 border border-neutral-200 dark:border-neutral-800 cursor-pointer rounded-lg"
                  onClick={() => setSelectedMemo(memo)}
                >
                  <div className="p-4 flex-1">
                    <div className="flex justify-between items-start mb-2">
                      {headers.topic ? (
                        <div className="text-xs text-[#F48120] font-medium">{headers.topic}</div>
                      ) : (
                        <div></div>
                      )}
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {new Date(memo.modified).toLocaleDateString()}
                      </div>
                    </div>
                    <h3 className="font-medium mb-2 truncate">{memo.slug}</h3>
                    <div className="text-sm mb-3 max-h-16 overflow-hidden text-neutral-700 dark:text-neutral-300 prose-sm dark:prose-invert prose">
                      <ReactMarkdown>
                        {memo.content.length > 150 
                          ? `${memo.content.slice(0, 150)}...` 
                          : memo.content
                        }
                      </ReactMarkdown>
                    </div>
                    {headers.keywords && headers.keywords.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {headers.keywords.map((keyword: string, index: number) => (
                          <span 
                            key={index}
                            className="text-xs bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded-full"
                          >
                            {keyword}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}