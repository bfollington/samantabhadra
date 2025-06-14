import { useState, useEffect } from "react";
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { TextArea } from "@/components/input/TextArea";
import { X, Plus, ChatCircle, User, Robot, PencilSimple, Trash, Check, XCircle } from "@phosphor-icons/react";

interface Memo {
  id: string;
  slug: string;
  content: string;
  headers: string;
  links: string;
  created: string;
  modified: string;
  parent_id?: string | null;
  author?: string;
}

interface Thread {
  root: Memo;
  memos: Memo[];
  total: number;
}

interface ThreadsPanelProps {
  onClose: () => void;
}

export function ThreadsPanel({ onClose }: ThreadsPanelProps) {
  const [threads, setThreads] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<Thread | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);
  const [newThreadContent, setNewThreadContent] = useState('');
  const [creatingThread, setCreatingThread] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [creatingReply, setCreatingReply] = useState(false);
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingMemoId, setDeletingMemoId] = useState<string | null>(null);


  // Function to refresh threads list
  const refreshThreads = async () => {
    try {
      setError(null);
      const response = await fetch("/agents/chat/default/list-memos?sortBy=modified&sortOrder=desc&limit=50");

      if (!response.ok) {
        throw new Error(`Failed to fetch threads: ${response.status}`);
      }

      const allMemos = await response.json() as Memo[];

      // Filter to only root memos (threads)
      const rootMemos = allMemos.filter((memo: Memo) => !memo.parent_id);
      setThreads(rootMemos);
    } catch (err) {
      console.error('Error fetching threads:', err);
      setError(err instanceof Error ? err.message : 'Failed to load threads');
    } finally {
      setLoading(false);
    }
  };

  // Load threads on mount
  useEffect(() => {
    refreshThreads();
  }, []);

  // Function to load a full thread
  const loadThread = async (slug: string) => {
    try {
      console.log('Loading thread with slug:', slug);
      const response = await fetch(`/agents/chat/default/thread?slug=${encodeURIComponent(slug)}`);
      console.log('Thread response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.log('Thread response error:', errorText);
        throw new Error(`Failed to fetch thread: ${response.status} - ${errorText}`);
      }

      const thread = await response.json() as Thread;
      console.log('Thread data received:', thread);
      setSelectedThread(thread);
    } catch (err) {
      console.error('Error loading thread:', err);
      setError(err instanceof Error ? err.message : 'Failed to load thread');
    }
  };

  // Function to create a new thread
  const createThread = async () => {
    if (!newThreadContent.trim()) return;

    try {
      setCreatingThread(true);
      setError(null);

      // Generate a slug from content
      const slug = newThreadContent
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .trim()
        .split(/\s+/)
        .slice(0, 6)
        .join("-") || `thread-${Date.now()}`;

      const response = await fetch("/agents/chat/default/create-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          slug,
          content: newThreadContent,
          author: "user",
          headers: JSON.stringify({})
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create thread: ${response.status}`);
      }

      // Reset form and refresh
      setNewThreadContent('');
      setIsCreatingThread(false);
      await refreshThreads();
    } catch (err) {
      console.error('Error creating thread:', err);
      setError(err instanceof Error ? err.message : 'Failed to create thread');
    } finally {
      setCreatingThread(false);
    }
  };

  // Function to create a reply
  const createReply = async () => {
    if (!replyContent.trim() || !selectedThread) return;

    try {
      setCreatingReply(true);
      setError(null);

      console.log('Creating reply:', {
        parent_slug: selectedThread.root.slug,
        content: replyContent,
        author: "user"
      });

      const response = await fetch("/agents/chat/default/create-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent_slug: selectedThread.root.slug,
          content: replyContent,
          author: "user"
        }),
      });

      console.log('Reply response status:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        console.log('Reply response error:', errorText);
        throw new Error(`Failed to create reply: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('Reply created successfully:', result);

      // Reset form and reload thread
      setReplyContent('');
      await loadThread(selectedThread.root.slug);

      // Check if reply mentions the agent
      if (replyContent.includes('@sam') || replyContent.includes('@agent')) {
        console.log('Reply mentions agent, creating assistant reply');
        // Create an assistant reply placeholder
        setTimeout(async () => {
          try {
            const assistantResponse = await fetch("/agents/chat/default/create-reply", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                parent_slug: selectedThread.root.slug,
                content: "Thinking...",
                author: "assistant"
              }),
            });

            console.log('Assistant reply response status:', assistantResponse.status);

            if (assistantResponse.ok) {
              const assistantResult = await assistantResponse.json();
              console.log('Assistant placeholder created:', assistantResult);

              // Extract the memo ID from the result message
              const memoIdMatch = assistantResult.message?.match(/ID: ([a-f0-9-]+)/);
              if (memoIdMatch) {
                const assistantMemoId = memoIdMatch[1];
                console.log('Triggering AI response generation for memo:', assistantMemoId);

                // Trigger actual AI response generation
                const generateResponse = await fetch("/agents/chat/default/generate-response", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    memo_id: assistantMemoId
                  }),
                });

                console.log('Generate response status:', generateResponse.status);

                // Wait a moment then reload thread to show the response
                setTimeout(async () => {
                  await loadThread(selectedThread.root.slug);
                }, 1000);
              }
            }

            // Reload thread to show pending reply
            await loadThread(selectedThread.root.slug);
          } catch (err) {
            console.error('Error creating assistant reply:', err);
          }
        }, 100);
      }
    } catch (err) {
      console.error('Error creating reply:', err);
      setError(err instanceof Error ? err.message : 'Failed to create reply');
    } finally {
      setCreatingReply(false);
    }
  };

  // Function to start editing a memo
  const startEditMemo = (memo: Memo) => {
    setEditingMemoId(memo.id);
    setEditingContent(memo.content);
  };

  // Function to cancel editing
  const cancelEdit = () => {
    setEditingMemoId(null);
    setEditingContent('');
  };

  // Function to save edited memo
  const saveEditMemo = async () => {
    if (!editingMemoId || !selectedThread) return;

    try {
      setSavingEdit(true);
      setError(null);

      const response = await fetch("/agents/chat/default/edit-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: editingMemoId,
          slug: selectedThread.memos.find(m => m.id === editingMemoId)?.slug,
          content: editingContent,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to edit memo: ${response.status} - ${errorText}`);
      }

      // Reset editing state and reload thread
      setEditingMemoId(null);
      setEditingContent('');
      await loadThread(selectedThread.root.slug);
    } catch (err) {
      console.error('Error editing memo:', err);
      setError(err instanceof Error ? err.message : 'Failed to edit memo');
    } finally {
      setSavingEdit(false);
    }
  };

  // Function to delete a memo
  const deleteMemo = async (memo: Memo) => {
    if (!selectedThread) return;

    try {
      setDeletingMemoId(memo.id);
      setError(null);

      const response = await fetch(`/agents/chat/default/delete-memo?id=${encodeURIComponent(memo.id)}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to delete memo: ${response.status} - ${errorText}`);
      }

      // Reload thread to reflect the deletion
      await loadThread(selectedThread.root.slug);
    } catch (err) {
      console.error('Error deleting memo:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete memo');
    } finally {
      setDeletingMemoId(null);
    }
  };



  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getAuthorIcon = (author?: string) => {
    if (author === 'assistant') {
      return <Robot size={16} className="text-[#F48120]" />;
    }
    return <User size={16} className="text-neutral-600 dark:text-neutral-400" />;
  };

  if (selectedThread) {
    return (
      <div className="flex flex-col h-full bg-neutral-50 dark:bg-neutral-950">
        {/* Thread Header */}
        <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedThread(null)}
            >
              ← Back
            </Button>
            <h2 className="font-semibold text-lg">Thread</h2>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={20} />
          </Button>
        </div>

        {/* Thread Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {selectedThread.memos.map((memo, index) => (
            <Card key={memo.id} className="p-4">
              <div className="flex items-start gap-3">
                {getAuthorIcon(memo.author)}
                <div className="flex-1">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        {memo.author === 'assistant' ? 'Assistant' : 'You'}
                      </span>
                      <span className="text-xs text-neutral-500">
                        {formatTime(memo.created)}
                      </span>
                    </div>

                    {/* Edit/Delete buttons - edit only for user's own memos, delete for all */}
                    {editingMemoId !== memo.id && (
                      <div className="flex items-center gap-1">
                        {/* Edit button - only for user memos */}
                        {memo.author !== 'assistant' && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => startEditMemo(memo)}
                            className="h-6 w-6 p-0"
                            aria-label="Edit memo"
                          >
                            <PencilSimple size={14} />
                          </Button>
                        )}
                        {/* Delete button - for all memos */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteMemo(memo)}
                          disabled={deletingMemoId === memo.id}
                          className="h-6 w-6 p-0 text-red-500 hover:text-red-700"
                          aria-label="Delete memo"
                        >
                          {deletingMemoId === memo.id ? (
                            <div className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
                          ) : (
                            <Trash size={14} />
                          )}
                        </Button>
                      </div>
                    )}
                  </div>

                  {/* Memo content - show editor if editing */}
                  {editingMemoId === memo.id ? (
                    <div className="space-y-3">
                      <TextArea
                        value={editingContent}
                        onChange={(e) => setEditingContent(e.target.value)}
                        onValueChange={(value) => setEditingContent(value)}
                        rows={4}
                        className="w-full"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={saveEditMemo}
                          disabled={!editingContent.trim() || savingEdit}
                          className="flex items-center gap-1"
                        >
                          {savingEdit ? (
                            <div className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
                          ) : (
                            <Check size={14} />
                          )}
                          {savingEdit ? 'Saving...' : 'Save'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={cancelEdit}
                          disabled={savingEdit}
                          className="flex items-center gap-1"
                        >
                          <XCircle size={14} />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="prose prose-sm dark:prose-invert max-w-none">
                      <p className="whitespace-pre-wrap">{memo.content}</p>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>

        {/* Reply Input */}
        <div className="p-4 border-t border-neutral-200 dark:border-neutral-800">
          <div className="space-y-3">
            <TextArea
              placeholder="Write a reply... (use @sam to mention the assistant)"
              value={replyContent}
              onChange={(e) => setReplyContent(e.target.value)}
              onValueChange={(value) => setReplyContent(value)}
              rows={3}
              className="w-full"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="primary"
                onClick={createReply}
                disabled={!replyContent.trim() || creatingReply}
              >
                {creatingReply ? 'Posting...' : 'Reply'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-neutral-950">
      {/* Header */}
      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
        <h2 className="font-semibold text-lg">Threads</h2>
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsCreatingThread(true)}
          >
            <Plus size={16} className="mr-1" />
            New Thread
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={20} />
          </Button>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-4 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Create Thread Form */}
      {isCreatingThread && (
        <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900">
          <div className="space-y-3">
            <TextArea
              placeholder="Start a new thread..."
              value={newThreadContent}
              onChange={(e) => setNewThreadContent(e.target.value)}
              onValueChange={(value) => setNewThreadContent(value)}
              rows={3}
              className="w-full"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsCreatingThread(false);
                  setNewThreadContent('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={createThread}
                disabled={!newThreadContent.trim() || creatingThread}
              >
                {creatingThread ? 'Creating...' : 'Create Thread'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Threads List */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-spin w-8 h-8 border-2 border-[#F48120] border-t-transparent rounded-full mx-auto mb-4"></div>
            <p className="text-neutral-600 dark:text-neutral-400">Loading threads...</p>
          </div>
        ) : threads.length === 0 ? (
          <div className="p-8 text-center">
            <ChatCircle size={48} className="mx-auto mb-4 text-neutral-400" />
            <h3 className="font-semibold text-lg mb-2">No threads yet</h3>
            <p className="text-neutral-600 dark:text-neutral-400 mb-4">
              Start your first conversation thread
            </p>
            <Button
              variant="primary"
              onClick={() => setIsCreatingThread(true)}
            >
              <Plus size={16} className="mr-1" />
              Create Thread
            </Button>
          </div>
        ) : (
          <div className="p-2">
            {threads.map((thread) => (
              <div
                key={thread.id}
                className="cursor-pointer"
                onClick={() => {
                  console.log('Thread card clicked, slug:', thread.slug);
                  loadThread(thread.slug);
                }}
              >
                <Card className="p-4 mb-3 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors">
                  <div className="flex items-start gap-3">
                    {getAuthorIcon(thread.author)}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm">
                          {thread.author === 'assistant' ? 'Assistant' : 'You'}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {formatTime(thread.created)}
                        </span>
                      </div>
                      <p className="text-sm text-neutral-600 dark:text-neutral-400 line-clamp-2">
                        {thread.content}
                      </p>
                    </div>
                    <ChatCircle size={16} className="text-neutral-400 flex-shrink-0" />
                  </div>
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
