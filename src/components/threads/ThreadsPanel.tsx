import { useState, useEffect } from "react";
import { Button } from "@/components/button/Button";
import { TextArea } from "@/components/input/TextArea";
import { useRealtimeSession } from "@/hooks/useRealtimeSession";
import { X, Plus, ChatCircle, User, Robot, ArrowLeft, PaperPlaneTilt, PencilSimple, Trash, Check, XCircle } from "@phosphor-icons/react";

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

interface ThreadsPanelProps {
  onClose: () => void;
}

export function ThreadsPanel({ onClose }: ThreadsPanelProps) {
  // Navigation state
  const [currentMemo, setCurrentMemo] = useState<Memo | null>(null);
  const [breadcrumb, setBreadcrumb] = useState<Memo[]>([]);

  // Data state
  const [rootMemos, setRootMemos] = useState<Memo[]>([]);
  const [replies, setReplies] = useState<Memo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer state
  const [showComposer, setShowComposer] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [composerParent, setComposerParent] = useState<Memo | null>(null);
  const [creatingReply, setCreatingReply] = useState(false);

  // Edit/Delete state
  const [editingMemoId, setEditingMemoId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingMemoId, setDeletingMemoId] = useState<string | null>(null);

  // Reply counts state
  const [replyCounts, setReplyCounts] = useState<Map<string, number>>(new Map());

  // Voice transcription
  const { startSession, stopSession, isSessionActive, transcription } = useRealtimeSession();

  // Handle voice transcription updates
  useEffect(() => {
    if (transcription.length > 0 && isSessionActive) {
      const transcribedText = transcription.join(' ');
      setReplyContent(transcribedText);
    }
  }, [transcription, isSessionActive]);

  // Load root memos on mount
  useEffect(() => {
    loadRootMemos();
  }, []);

  // Load replies when currentMemo changes
  useEffect(() => {
    if (currentMemo) {
      loadReplies(currentMemo);
    }
  }, [currentMemo]);

  const loadRootMemos = async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch("/agents/chat/default/list-memos?sortBy=modified&sortOrder=desc&limit=50");
      if (!response.ok) {
        throw new Error(`Failed to fetch memos: ${response.status}`);
      }

      const allMemos = await response.json() as Memo[];
      const rootMemos = allMemos.filter((memo: Memo) => !memo.parent_id);
      setRootMemos(rootMemos);

      // Load reply counts for root memos
      await loadReplyCounts(rootMemos, allMemos);
    } catch (err) {
      console.error('Error fetching root memos:', err);
      setError(err instanceof Error ? err.message : 'Failed to load memos');
    } finally {
      setLoading(false);
    }
  };

  const loadReplies = async (memo: Memo) => {
    try {
      const response = await fetch("/agents/chat/default/list-memos?sortBy=created&sortOrder=asc&limit=100");
      if (!response.ok) {
        throw new Error(`Failed to fetch replies: ${response.status}`);
      }

      const allMemos = await response.json() as Memo[];
      const directReplies = allMemos.filter((m: Memo) => m.parent_id === memo.id);
      setReplies(directReplies);

      // Load reply counts for the current replies
      await loadReplyCounts(directReplies, allMemos);
    } catch (err) {
      console.error('Error fetching replies:', err);
      setError(err instanceof Error ? err.message : 'Failed to load replies');
    }
  };

  const navigateToMemo = (memo: Memo) => {
    // Add current memo to breadcrumb if we're not at root
    if (currentMemo) {
      setBreadcrumb(prev => [...prev, currentMemo]);
    }
    setCurrentMemo(memo);
  };

  const navigateBack = () => {
    if (breadcrumb.length > 0) {
      const previous = breadcrumb[breadcrumb.length - 1];
      setBreadcrumb(prev => prev.slice(0, -1));
      setCurrentMemo(previous);
    } else {
      // Go back to root
      setCurrentMemo(null);
      setReplies([]);
    }
  };

  const navigateToRoot = () => {
    setCurrentMemo(null);
    setBreadcrumb([]);
    setReplies([]);
  };

  const openComposer = (parentMemo: Memo | null = null) => {
    setComposerParent(parentMemo || currentMemo);
    setShowComposer(true);
    setReplyContent('');
  };

  const closeComposer = () => {
    setShowComposer(false);
    setReplyContent('');
    setComposerParent(null);
  };

  const createReply = async () => {
    if (!replyContent.trim() || !composerParent) return;

    try {
      setCreatingReply(true);
      setError(null);

      const response = await fetch("/agents/chat/default/create-reply", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent_slug: composerParent.slug,
          content: replyContent,
          author: "user"
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create reply: ${response.status} - ${errorText}`);
      }

      const result = await response.json();
      console.log('Reply created:', result);

      // Close composer
      closeComposer();

      // Refresh current view
      if (currentMemo) {
        await loadReplies(currentMemo);
      } else {
        await loadRootMemos();
      }

      // Handle AI mentions
      if (replyContent.includes('@sam') || replyContent.includes('@agent')) {
        const userReplySlugMatch = result.message?.match(/slug: ([^\s]+)/);
        const userReplySlug = userReplySlugMatch ? userReplySlugMatch[1] : composerParent.slug;

        setTimeout(async () => {
          try {
            const assistantResponse = await fetch("/agents/chat/default/create-reply", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                parent_slug: userReplySlug,
                content: "Thinking...",
                author: "assistant"
              }),
            });

            if (assistantResponse.ok) {
              const assistantResult = await assistantResponse.json();
              const memoIdMatch = assistantResult.message?.match(/ID: ([a-f0-9-]+)/);

              if (memoIdMatch) {
                const assistantMemoId = memoIdMatch[1];
                await fetch("/agents/chat/default/generate-response", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    memo_id: assistantMemoId
                  }),
                });

                // Refresh view after AI response
                setTimeout(async () => {
                  if (currentMemo) {
                    await loadReplies(currentMemo);
                  } else {
                    await loadRootMemos();
                  }
                }, 1000);
              }
            }
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

  // Edit and delete functions
  const startEditMemo = (memo: Memo) => {
    setEditingMemoId(memo.id);
    setEditingContent(memo.content);
  };

  const cancelEdit = () => {
    setEditingMemoId(null);
    setEditingContent('');
  };

  const saveEditMemo = async () => {
    if (!editingMemoId) return;

    try {
      setSavingEdit(true);
      setError(null);

      // Find the memo being edited
      const memoToEdit = currentMemo?.id === editingMemoId ? currentMemo :
        replies.find(r => r.id === editingMemoId) ||
        rootMemos.find(r => r.id === editingMemoId);

      if (!memoToEdit) {
        throw new Error('Memo not found');
      }

      const response = await fetch("/agents/chat/default/edit-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: editingMemoId,
          slug: memoToEdit.slug,
          content: editingContent,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to edit memo: ${response.status} - ${errorText}`);
      }

      // Reset editing state
      setEditingMemoId(null);
      setEditingContent('');

      // Refresh current view
      if (currentMemo) {
        await loadReplies(currentMemo);
      } else {
        await loadRootMemos();
      }
    } catch (err) {
      console.error('Error editing memo:', err);
      setError(err instanceof Error ? err.message : 'Failed to edit memo');
    } finally {
      setSavingEdit(false);
    }
  };

  const deleteMemo = async (memo: Memo) => {
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

      // Refresh current view
      if (currentMemo) {
        await loadReplies(currentMemo);
      } else {
        await loadRootMemos();
      }
    } catch (err) {
      console.error('Error deleting memo:', err);
      setError(err instanceof Error ? err.message : 'Failed to delete memo');
    } finally {
      setDeletingMemoId(null);
    }
  };

  // Function to load reply counts for a set of memos
  const loadReplyCounts = async (memos: Memo[], allMemos: Memo[]) => {
    const counts = new Map<string, number>();

    memos.forEach(memo => {
      // Count direct replies for this memo
      const directReplies = allMemos.filter(m => m.parent_id === memo.id);
      counts.set(memo.id, directReplies.length);
    });

    setReplyCounts(prevCounts => {
      const newCounts = new Map(prevCounts);
      counts.forEach((count, id) => {
        newCounts.set(id, count);
      });
      return newCounts;
    });
  };

  const formatTime = (dateString: string) => {
    return new Date(dateString).toLocaleString();
  };

  const getAuthorIcon = (author?: string) => {
    if (author === 'assistant') {
      return <Robot size={20} className="text-[#F48120]" />;
    }
    return <User size={20} className="text-neutral-600 dark:text-neutral-400" />;
  };

  const truncateContent = (content: string, maxLength: number = 280) => {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + "...";
  };

  const renderMemo = (memo: Memo, isMain = false, showRepliesCount = true) => {
    const isEditing = editingMemoId === memo.id;

    return (
      <div
        key={memo.id}
        className={`group border-b border-neutral-200 dark:border-neutral-800 p-4 ${!isMain ? 'cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50' : 'bg-neutral-50 dark:bg-neutral-900/30'
          } transition-colors`}
        onClick={!isMain && !isEditing ? () => navigateToMemo(memo) : undefined}
      >
        <div className="flex gap-3">
          {getAuthorIcon(memo.author)}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="font-medium text-sm">
                {memo.author === 'assistant' ? 'Assistant' : 'You'}
              </span>
              <span className="text-xs text-neutral-500">
                {formatTime(memo.created)}
              </span>

              {/* Edit/Delete buttons */}
              {!isEditing && memo.author !== 'assistant' && (
                <div className="ml-auto opacity-0 group-hover:opacity-100 flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditMemo(memo);
                    }}
                    className="h-7 w-7 p-0 text-neutral-400 hover:text-neutral-600"
                  >
                    <PencilSimple size={16} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMemo(memo);
                    }}
                    disabled={deletingMemoId === memo.id}
                    className="h-7 w-7 p-0 text-neutral-400 hover:text-red-500"
                  >
                    {deletingMemoId === memo.id ? (
                      <div className="animate-spin h-3 w-3 border border-current border-t-transparent rounded-full" />
                    ) : (
                      <Trash size={16} />
                    )}
                  </Button>
                </div>
              )}
            </div>

            {isEditing ? (
              <div className="space-y-3">
                <TextArea
                  value={editingContent}
                  onChange={(e) => setEditingContent(e.target.value)}
                  onValueChange={(value) => setEditingContent(value)}
                  rows={3}
                  className="w-full text-sm"
                />
                <div className="flex items-center gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={saveEditMemo}
                    disabled={!editingContent.trim() || savingEdit}
                    className="flex items-center gap-1 h-7 px-3 text-xs"
                  >
                    {savingEdit ? (
                      <div className="animate-spin h-2 w-2 border border-current border-t-transparent rounded-full" />
                    ) : (
                      <Check size={12} />
                    )}
                    {savingEdit ? 'Saving...' : 'Save'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={cancelEdit}
                    disabled={savingEdit}
                    className="flex items-center gap-1 h-7 px-3 text-xs"
                  >
                    <XCircle size={12} />
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <p className={`text-sm leading-relaxed whitespace-pre-wrap ${isMain ? 'text-base text-neutral-900 dark:text-neutral-100' : 'text-neutral-800 dark:text-neutral-200'
                  }`}>
                  {isMain ? memo.content : truncateContent(memo.content)}
                </p>

                <div className="flex items-center justify-between mt-3">
                  {showRepliesCount && (
                    <div className="flex items-center gap-4 text-xs text-neutral-500">
                      <div className="flex items-center gap-1">
                        <ChatCircle size={14} />
                        <span>
                          {(() => {
                            const replyCount = replyCounts.get(memo.id) || 0;
                            if (replyCount === 0) {
                              return 'Thread';
                            } else if (replyCount === 1) {
                              return '1 reply';
                            } else {
                              return `${replyCount} replies`;
                            }
                          })()}
                        </span>
                      </div>
                    </div>
                  )}

                  {isMain && (
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => openComposer(memo)}
                      className="ml-auto"
                    >
                      <Plus size={14} className="mr-1" />
                      Reply
                    </Button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <>
      <div className="flex flex-col h-full max-h-screen bg-neutral-50 dark:bg-neutral-950">
        {/* Header with Navigation */}
        <div className="flex-shrink-0 p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {(currentMemo || breadcrumb.length > 0) && (
              <Button
                variant="ghost"
                size="sm"
                onClick={navigateBack}
                className="mr-2"
              >
                <ArrowLeft size={16} />
              </Button>
            )}

            <div className="flex items-center gap-2">
              <h2 className="font-semibold text-lg">
                {currentMemo ? 'Thread' : 'Memos'}
              </h2>

              {/* Breadcrumb */}
              {breadcrumb.length > 0 && (
                <div className="flex items-center gap-1 text-sm text-neutral-500">
                  <button onClick={navigateToRoot} className="hover:text-neutral-700 dark:hover:text-neutral-300">
                    Home
                  </button>
                  {breadcrumb.map((memo, index) => (
                    <span key={memo.id}>
                      <span className="mx-1">›</span>
                      <button
                        onClick={() => {
                          setBreadcrumb(prev => prev.slice(0, index + 1));
                          setCurrentMemo(memo);
                        }}
                        className="hover:text-neutral-700 dark:hover:text-neutral-300"
                      >
                        {truncateContent(memo.content, 30)}
                      </button>
                    </span>
                  ))}
                  {currentMemo && (
                    <>
                      <span className="mx-1">›</span>
                      <span className="text-neutral-700 dark:text-neutral-300">
                        {truncateContent(currentMemo.content, 30)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            {!currentMemo && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => openComposer(null)}
              >
                <Plus size={16} className="mr-1" />
                New Memo
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onClose}>
              <X size={20} />
            </Button>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <div className="flex-shrink-0 p-4 bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {loading ? (
            <div className="p-8 text-center">
              <div className="animate-spin w-8 h-8 border-2 border-[#F48120] border-t-transparent rounded-full mx-auto mb-4"></div>
              <p className="text-neutral-600 dark:text-neutral-400">Loading...</p>
            </div>
          ) : currentMemo ? (
            // Thread view: Show current memo + its replies
            <div>
              {/* Current memo prominently displayed */}
              {renderMemo(currentMemo, true, false)}

              {/* Replies section */}
              <div className="border-b-4 border-neutral-300 dark:border-neutral-700">
                <div className="p-4 bg-neutral-100 dark:bg-neutral-800">
                  <h3 className="text-sm font-medium text-neutral-600 dark:text-neutral-400">
                    {replies.length > 0
                      ? `${replies.length} ${replies.length === 1 ? 'Reply' : 'Replies'}`
                      : 'No replies yet'
                    }
                  </h3>
                </div>
              </div>

              {replies.length > 0 ? (
                replies.map(reply => renderMemo(reply, false, true))
              ) : (
                <div className="p-8 text-center">
                  <ChatCircle size={48} className="mx-auto mb-4 text-neutral-400" />
                  <p className="text-sm text-neutral-500 mb-2">No replies yet</p>
                  <p className="text-xs text-neutral-400 mb-4">Be the first to reply</p>
                  <Button
                    variant="primary"
                    onClick={() => openComposer(currentMemo)}
                  >
                    <Plus size={16} className="mr-1" />
                    Add Reply
                  </Button>
                </div>
              )}
            </div>
          ) : (
            // Root view: Show all root memos
            <div>
              {rootMemos.length === 0 ? (
                <div className="p-8 text-center">
                  <ChatCircle size={48} className="mx-auto mb-4 text-neutral-400" />
                  <h3 className="font-semibold text-lg mb-2">No memos yet</h3>
                  <p className="text-neutral-600 dark:text-neutral-400 mb-4">
                    Start your first conversation
                  </p>
                  <Button
                    variant="primary"
                    onClick={() => openComposer(null)}
                  >
                    <Plus size={16} className="mr-1" />
                    Create Memo
                  </Button>
                </div>
              ) : (
                rootMemos.map(memo => renderMemo(memo, false, true))
              )}
            </div>
          )}
        </div>
      </div>

      {/* Modal Composer */}
      {showComposer && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800">
              <h3 className="font-semibold">
                {composerParent ? 'Reply' : 'New Memo'}
              </h3>
              <Button variant="ghost" size="sm" onClick={closeComposer}>
                <X size={20} />
              </Button>
            </div>

            <div className="p-4">
              {composerParent && (
                <div className="mb-4 p-3 bg-neutral-50 dark:bg-neutral-800 rounded border-l-4 border-neutral-300 dark:border-neutral-600">
                  <div className="flex items-center gap-2 mb-1">
                    {getAuthorIcon(composerParent.author)}
                    <span className="text-xs font-medium">
                      {composerParent.author === 'assistant' ? 'Assistant' : 'You'}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-600 dark:text-neutral-400">
                    {truncateContent(composerParent.content, 120)}
                  </p>
                </div>
              )}

              <div className="space-y-4">
                <div className="flex gap-2">
                  <TextArea
                    placeholder={
                      composerParent
                        ? "Write your reply... (use @sam to mention the assistant)"
                        : "What's on your mind?"
                    }
                    value={replyContent}
                    onChange={(e) => setReplyContent(e.target.value)}
                    onValueChange={(value) => setReplyContent(value)}
                    rows={4}
                    className="w-full resize-none"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    shape="square"
                    className="rounded-full h-10 w-10 flex-shrink-0 self-end mb-1"
                    onClick={isSessionActive ? stopSession : startSession}
                    aria-label={isSessionActive ? "Stop voice session" : "Start voice session"}
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
                      {isSessionActive ? (
                        <circle cx="12" cy="12" r="10" fill="currentColor" />
                      ) : (
                        <>
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                          <line x1="12" y1="19" x2="12" y2="22" />
                        </>
                      )}
                    </svg>
                  </Button>
                </div>

                <div className="flex items-center justify-between">
                  <span className={`text-xs ${replyContent.length > 500 ? 'text-red-500' : 'text-neutral-500'
                    }`}>
                    {replyContent.length}/500
                  </span>

                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={closeComposer}
                      disabled={creatingReply}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={createReply}
                      disabled={!replyContent.trim() || creatingReply || replyContent.length > 500}
                    >
                      {creatingReply ? (
                        'Posting...'
                      ) : (
                        <>
                          <PaperPlaneTilt size={14} className="mr-1" />
                          {composerParent ? 'Reply' : 'Post'}
                        </>
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
