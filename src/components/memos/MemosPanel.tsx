import { useEffect, useState } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import { TextArea } from "@/components/input/TextArea";
import { MemoViewer } from "./MemoViewer";
import { X, Plus, Check, ArrowClockwise } from "@phosphor-icons/react";
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
  const [isCreatingMemo, setIsCreatingMemo] = useState(false);
  const [newMemoSlug, setNewMemoSlug] = useState('');
  const [newMemoContent, setNewMemoContent] = useState('');
  const [creatingMemo, setCreatingMemo] = useState(false);

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
  
  // Create a new memo
  const createMemo = async () => {
    if (!newMemoSlug.trim()) {
      return;
    }
    
    try {
      setCreatingMemo(true);
      const response = await fetch("/agents/chat/default/create-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug: newMemoSlug.trim(),
          content: newMemoContent,
          headers: JSON.stringify({}),
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create memo: ${response.status}`);
      }

      // Refresh the memos list
      const refreshResponse = await fetch("/agents/chat/default/list-memos");
      if (!refreshResponse.ok) {
        throw new Error(`Failed to refresh memos: ${refreshResponse.status}`);
      }
      const refreshData = await refreshResponse.json();
      setMemos(refreshData as Memo[]);
      
      // Find the newly created memo
      const newMemo = (refreshData as Memo[]).find((memo) => memo.slug === newMemoSlug.trim());
      if (newMemo) {
        setSelectedMemo(newMemo);
      }
      
      // Reset the form
      setNewMemoSlug('');
      setNewMemoContent('');
      setIsCreatingMemo(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create memo");
    } finally {
      setCreatingMemo(false);
    }
  };

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
    return <MemoViewer 
      memo={selectedMemo} 
      onClose={() => setSelectedMemo(null)}
      allMemos={memos} 
    />;
  }

  return (
    <div className="fixed inset-0 z-20 bg-white dark:bg-neutral-950 overflow-auto">
      <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex justify-between items-center">
        <h2 className="font-semibold">Memos ({memos.length})</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={() => setIsCreatingMemo(true)}
            title="Create new memo"
          >
            <Plus size={20} />
          </Button>
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
      </div>
      
      {/* Create New Memo Dialog */}
      {isCreatingMemo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-30">
          <Card className="w-full max-w-md m-4 p-6">
            <h3 className="font-semibold text-lg mb-4">Create New Memo</h3>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Slug (identifier)</label>
                <input
                  type="text"
                  value={newMemoSlug}
                  onChange={(e) => setNewMemoSlug(e.target.value)}
                  placeholder="e.g., todo, meeting-notes, ideas"
                  className="w-full px-3 py-2 border rounded-md bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium mb-1">Content</label>
                <TextArea
                  className="w-full min-h-[200px] bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700 p-3 rounded-md font-mono text-sm"
                  value={newMemoContent}
                  onChange={(e) => setNewMemoContent(e.target.value)}
                  placeholder="Memo content..."
                  onValueChange={undefined}
                />
              </div>
              
              <div className="flex justify-end gap-2 mt-6">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setIsCreatingMemo(false);
                    setNewMemoSlug('');
                    setNewMemoContent('');
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={createMemo}
                  disabled={!newMemoSlug.trim() || creatingMemo}
                >
                  {creatingMemo ? 
                    <><ArrowClockwise size={16} className="animate-spin mr-2" /> Creating...</> : 
                    <><Check size={16} className="mr-2" /> Create Memo</>}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
      
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