import { useEffect, useState } from "react";
import { Card } from "@/components/card/Card";
import { Button } from "@/components/button/Button";
import { TextArea } from "@/components/input/TextArea";
import { MemoViewer } from "./MemoViewer";
import { X, Plus, Check, ArrowClockwise, FlowArrow } from "@phosphor-icons/react";
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
  const [isWorkflow, setIsWorkflow] = useState(false);
  const [workflowTitle, setWorkflowTitle] = useState('');
  const [workflowDescription, setWorkflowDescription] = useState('');

  // Function to refresh memos list
  const refreshMemos = async () => {
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

  useEffect(() => {
    const fetchInitialMemos = async () => {
      try {
        setLoading(true);
        const response = await fetch("/agents/chat/default/list-memos");
        if (!response.ok) {
          throw new Error(`Failed to fetch memos: ${response.status}`);
        }
        const data = await response.json();
        setMemos(data as Memo[]);

        // Check if we need to open a specific memo
        const openMemoSlug = sessionStorage.getItem('openMemoSlug');
        if (openMemoSlug) {
          // Find the memo with this slug
          const memoToOpen = (data as Memo[]).find(memo => memo.slug === openMemoSlug);
          if (memoToOpen) {
            setSelectedMemo(memoToOpen);
          }
          // Clear the sessionStorage item so it doesn't persist
          sessionStorage.removeItem('openMemoSlug');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load memos");
      } finally {
        setLoading(false);
      }
    };

    fetchInitialMemos();
  }, []);

  // Create a new memo
  const createMemo = async () => {
    if (!newMemoSlug.trim()) {
      return;
    }

    try {
      setCreatingMemo(true);

      // Prepare headers based on whether this is a workflow
      const headers = isWorkflow
        ? JSON.stringify({
          type: 'workflow',
          title: workflowTitle || newMemoSlug,
          description: workflowDescription || ''
        })
        : JSON.stringify({});

      const response = await fetch("/agents/chat/default/create-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug: newMemoSlug.trim(),
          content: newMemoContent,
          headers,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create memo: ${response.status}`);
      }

      // Refresh the memos list
      await refreshMemos();
      
      // Directly fetch the newly created memo
      const memoResponse = await fetch(`/agents/chat/default/get-memo?slug=${newMemoSlug.trim()}`);
      if (memoResponse.ok) {
        const newMemo = await memoResponse.json() as Memo;
        if (newMemo && newMemo.id) {
          setSelectedMemo(newMemo);
        }
      }

      // Reset the form
      setNewMemoSlug('');
      setNewMemoContent('');
      setIsWorkflow(false);
      setWorkflowTitle('');
      setWorkflowDescription('');
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
      onDelete={refreshMemos}
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
          <Card className="w-full bg-black max-w-md m-4 p-6">
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

              <div className="flex items-center mt-2">
                <input
                  type="checkbox"
                  id="workflowToggle"
                  className="mr-2"
                  onChange={(e) => {
                    setIsWorkflow(e.target.checked);
                  }}
                />
                <label htmlFor="workflowToggle" className="text-sm flex items-center cursor-pointer">
                  <FlowArrow size={14} className="mr-1 text-[#F48120]" />
                  Create as a workflow
                </label>
              </div>

              {isWorkflow && (
                <div className="mt-3">
                  <label className="block text-sm font-medium mb-1">Workflow Title</label>
                  <input
                    type="text"
                    value={workflowTitle}
                    onChange={(e) => setWorkflowTitle(e.target.value)}
                    placeholder="Give your workflow a title"
                    className="w-full px-3 py-2 border rounded-md bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700"
                  />

                  <label className="block text-sm font-medium mb-1 mt-3">Workflow Description</label>
                  <input
                    type="text"
                    value={workflowDescription}
                    onChange={(e) => setWorkflowDescription(e.target.value)}
                    placeholder="Briefly describe what this workflow does"
                    className="w-full px-3 py-2 border rounded-md bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700"
                  />
                </div>
              )}

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
                    setIsWorkflow(false);
                    setWorkflowTitle('');
                    setWorkflowDescription('');
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
                    <><Plus size={16} className="mr-2" /> Create Memo</>}
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
              const isWorkflow = headers.type === 'workflow';
              return (
                <div
                  key={memo.id}
                  className={`overflow-hidden flex flex-col hover:shadow-md transition-shadow duration-200 border cursor-pointer rounded-lg ${isWorkflow ? 'border-[#F48120]/50 bg-[#F48120]/5 dark:bg-[#F48120]/10' : 'border-neutral-200 dark:border-neutral-800'}`}
                  onClick={() => setSelectedMemo(memo)}
                >
                  <div className="p-4 flex-1">
                    <div className="flex justify-between items-start mb-2">
                      {isWorkflow ? (
                        <div className="text-xs text-[#F48120] font-medium flex items-center">
                          <FlowArrow size={14} className="mr-1" />
                          Workflow
                        </div>
                      ) : headers.topic ? (
                        <div className="text-xs text-[#F48120] font-medium">{headers.topic}</div>
                      ) : (
                        <div></div>
                      )}
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {new Date(memo.modified).toLocaleDateString()}
                      </div>
                    </div>
                    <h3 className="font-medium mb-2 truncate">
                      {isWorkflow && headers.title ? headers.title : memo.slug}
                    </h3>
                    {isWorkflow && headers.description && (
                      <div className="text-sm mb-2 text-[#F48120]/80">{headers.description}</div>
                    )}
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
