import { useState, useEffect } from "react";
import { Button } from "@/components/button/Button";
import { TextArea } from "@/components/input/TextArea";
import { useRealtimeSession } from "@/hooks/useRealtimeSession";
import { X, Plus, ChatCircle, User, Robot, ArrowLeft, PaperPlaneTilt, PencilSimple, Trash, Check, XCircle, Smiley } from "@phosphor-icons/react";

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
  reactions?: { [emoji: string]: string[] }; // emoji -> array of user IDs
}

interface ThreadsPanelProps {
  onClose: () => void;
}

export function ThreadsPanel({ onClose }: ThreadsPanelProps) {
  // Navigation state
  const [currentMemo, setCurrentMemo] = useState<Memo | null>(null);

  // Data state
  const [rootMemos, setRootMemos] = useState<Memo[]>([]);
  const [replies, setReplies] = useState<Memo[]>([]);
  const [allThreadMemos, setAllThreadMemos] = useState<Memo[]>([]);
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

  // Reactions state
  const [showReactionPicker, setShowReactionPicker] = useState<string | null>(null);
  const [addingReaction, setAddingReaction] = useState<string | null>(null);
  const [fallbackReactions, setFallbackReactions] = useState<Map<string, { [emoji: string]: string[] }>>(new Map());

  // Fragment extraction state
  const [extractingFragments, setExtractingFragments] = useState<string | null>(null);

  // Voice transcription
  const { startSession, stopSession, isSessionActive, transcription } = useRealtimeSession();

  // Handle voice transcription updates
  useEffect(() => {
    if (transcription.length > 0 && isSessionActive) {
      const transcribedText = transcription.join(' ');
      setReplyContent(transcribedText);
    }
  }, [transcription, isSessionActive]);

  // Click outside handler for reaction picker
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (showReactionPicker && !(event.target as Element).closest('.reaction-picker-container')) {
        setShowReactionPicker(null);
      }
    };

    if (showReactionPicker) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showReactionPicker]);

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

  const navigateToMemo = async (memo: Memo) => {
    // Load full thread context to ensure we have all parent memos
    try {
      const threadResponse = await fetch(`/agents/chat/default/thread?slug=${encodeURIComponent(memo.slug)}`);
      if (threadResponse.ok) {
        const thread = await threadResponse.json();
        setAllThreadMemos(thread.memos || []);
      }
    } catch (error) {
      console.error('Error loading full thread context:', error);
    }

    setCurrentMemo(memo);
  };

  // Build thread history leading to a focused memo
  const buildThreadHistory = (focusedMemo: Memo): Memo[] => {
    const history: Memo[] = [];
    let current = focusedMemo;

    // Walk up the parent chain to build history using full thread context
    while (current.parent_id) {
      const parent = allThreadMemos.find(m => m.id === current.parent_id);
      if (parent) {
        history.unshift(parent);
        current = parent;
      } else {
        break;
      }
    }

    return history;
  };

  const navigateBack = () => {
    // Always go back to root view
    setCurrentMemo(null);
    setReplies([]);
    setAllThreadMemos([]);
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
    if (!replyContent.trim()) return;

    try {
      setCreatingReply(true);
      setError(null);

      let response, result;

      if (composerParent) {
        // Creating a reply to an existing memo
        response = await fetch("/agents/chat/default/create-reply", {
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

        result = await response.json();
        console.log('Reply created:', result);

        // Extract reply ID from result for fragment extraction
        const replyIdMatch = result.message?.match(/ID: ([a-f0-9-]+)/);
        if (replyIdMatch) {
          const replyId = replyIdMatch[1];
          // Trigger fragment extraction asynchronously
          extractFragmentsFromReply(replyId, composerParent);
        }

        // Auto-trigger agent response when replying to assistant OR if mentions agent
        const shouldTriggerAgent = composerParent.author === 'assistant' ||
          replyContent.includes('@sam') ||
          replyContent.includes('@agent');

        if (shouldTriggerAgent) {
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
      } else {
        // Creating a new root memo
        const slug = replyContent
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, "")
          .trim()
          .split(/\s+/)
          .slice(0, 6)
          .join("-") || `memo-${Date.now()}`;

        response = await fetch("/agents/chat/default/create-memo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            slug,
            content: replyContent,
            author: "user",
            headers: JSON.stringify({})
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Failed to create memo: ${response.status} - ${errorText}`);
        }

        result = await response.json();
        console.log('New memo created:', result);
      }

      // Close composer
      closeComposer();

      // Refresh current view
      if (currentMemo) {
        await loadReplies(currentMemo);
      } else {
        await loadRootMemos();
      }
    } catch (err) {
      console.error('Error creating memo/reply:', err);
      setError(err instanceof Error ? err.message : 'Failed to create memo/reply');
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

  // Reaction functions
  const addReaction = async (memoId: string, emoji: string) => {
    try {
      setAddingReaction(memoId);

      // Optimistic update - add reaction immediately
      setFallbackReactions(prev => {
        const newReactions = new Map(prev);
        const memoReactions = newReactions.get(memoId) || {};
        const existingUsers = memoReactions[emoji] || [];

        if (!existingUsers.includes("user")) {
          memoReactions[emoji] = [...existingUsers, "user"];
          newReactions.set(memoId, memoReactions);
        }

        return newReactions;
      });

      try {
        const response = await fetch("/agents/chat/default/add-reaction", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            memo_id: memoId,
            emoji: emoji,
            user_id: "user" // In a real app, this would be the current user's ID
          }),
        });

        if (!response.ok) {
          throw new Error(`API failed: ${response.status}`);
        }

        // Refresh current view if API succeeded to get server state
        if (currentMemo) {
          await loadReplies(currentMemo);
        } else {
          await loadRootMemos();
        }
      } catch (apiError) {
        console.log('API not available, keeping optimistic update');
        // Keep the optimistic update since API isn't available
      }

      // If it's the bot emoji (🤖), trigger agent response
      if (emoji === '🤖') {
        const memo = currentMemo?.id === memoId ? currentMemo :
          replies.find(r => r.id === memoId) ||
          rootMemos.find(r => r.id === memoId);

        if (memo) {
          setTimeout(async () => {
            try {
              const assistantResponse = await fetch("/agents/chat/default/create-reply", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  parent_slug: memo.slug,
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
              console.error('Error creating bot reaction response:', err);
            }
          }, 100);
        }
      }
    } catch (err) {
      console.error('Error adding reaction:', err);
      setError(err instanceof Error ? err.message : 'Failed to add reaction');
    } finally {
      setAddingReaction(null);
      setShowReactionPicker(null);
    }
  };

  const removeReaction = async (memoId: string, emoji: string) => {
    try {
      // Optimistic update - remove reaction immediately
      setFallbackReactions(prev => {
        const newReactions = new Map(prev);
        const memoReactions = newReactions.get(memoId) || {};
        const existingUsers = memoReactions[emoji] || [];

        memoReactions[emoji] = existingUsers.filter(user => user !== "user");
        if (memoReactions[emoji].length === 0) {
          delete memoReactions[emoji];
        }

        newReactions.set(memoId, memoReactions);
        return newReactions;
      });

      try {
        const response = await fetch("/agents/chat/default/remove-reaction", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            memo_id: memoId,
            emoji: emoji,
            user_id: "user"
          }),
        });

        if (!response.ok) {
          throw new Error(`API failed: ${response.status}`);
        }

        // Refresh current view if API succeeded to get server state
        if (currentMemo) {
          await loadReplies(currentMemo);
        } else {
          await loadRootMemos();
        }
      } catch (apiError) {
        console.log('API not available, keeping optimistic update');
        // Keep the optimistic update since API isn't available
      }
    } catch (err) {
      console.error('Error removing reaction:', err);
      setError(err instanceof Error ? err.message : 'Failed to remove reaction');
    }
  };

  const hasUserReacted = (memo: Memo, emoji: string) => {
    // Check API data first, then fallback data
    const apiReaction = memo.reactions?.[emoji]?.includes("user") || false;
    const fallbackReaction = fallbackReactions.get(memo.id)?.[emoji]?.includes("user") || false;
    return apiReaction || fallbackReaction;
  };

  const getMemoReactions = (memo: Memo) => {
    // Combine API reactions with fallback reactions
    const apiReactions = memo.reactions || {};
    const fallbackMemoReactions = fallbackReactions.get(memo.id) || {};

    const combined: { [emoji: string]: string[] } = { ...apiReactions };

    // Merge fallback reactions
    Object.entries(fallbackMemoReactions).forEach(([emoji, users]) => {
      if (combined[emoji]) {
        // Merge users, avoiding duplicates
        const allUsers = [...combined[emoji], ...users];
        combined[emoji] = [...new Set(allUsers)];
      } else {
        combined[emoji] = users;
      }
    });

    return combined;
  };

  // Fragment extraction for threaded memos
  const extractFragmentsFromReply = async (replyId: string, parentMemo: Memo) => {
    try {
      console.log('Starting fragment extraction for reply:', replyId);
      setExtractingFragments(replyId);

      // Get the full thread context
      const threadResponse = await fetch(`/agents/chat/default/thread?slug=${encodeURIComponent(parentMemo.slug)}`);
      if (!threadResponse.ok) {
        throw new Error('Failed to fetch thread for fragment extraction');
      }

      const thread = await threadResponse.json();

      // Build conversation context
      const conversationContext = thread.memos
        .filter((memo: Memo) => memo.content !== "Thinking...")
        .map((memo: Memo) => `${memo.author === 'assistant' ? 'Assistant' : 'User'}: ${memo.content}`)
        .join('\n\n');

      // Find the specific reply we just created
      const newReply = thread.memos.find((memo: Memo) => memo.id === replyId);
      if (!newReply) {
        console.warn('Could not find new reply in thread for fragment extraction');
        return;
      }

      // Call fragment extraction API
      const extractionResponse = await fetch('/agents/chat/default/extract-fragments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          memo_id: replyId,
          memo_content: newReply.content,
          thread_context: conversationContext,
          parent_memo_id: parentMemo.id
        })
      });

      if (extractionResponse.ok) {
        const extractionResult = await extractionResponse.json();
        console.log('Fragment extraction completed:', extractionResult);
      } else {
        console.warn('Fragment extraction failed:', extractionResponse.status);
      }
    } catch (error) {
      console.error('Error in fragment extraction:', error);
      // Don't throw - fragment extraction is optional
    } finally {
      setExtractingFragments(null);
    }
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
        className={`group border-b border-neutral-200 dark:border-neutral-800 transition-colors ${isMain
          ? 'p-6 bg-neutral-50 dark:bg-neutral-900/30 border-l-2 border-[#F48120]'
          : 'p-4 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-900/50'
          }`}
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
              {extractingFragments === memo.id && (
                <span className="flex items-center gap-1 text-xs text-[#F48120]">
                  <div className="animate-spin h-2 w-2 border border-current border-t-transparent rounded-full" />
                  Extracting insights...
                </span>
              )}

              {/* Edit/Delete buttons */}
              {!isEditing && (
                <div className="ml-auto opacity-0 group-hover:opacity-100 flex items-center gap-1">
                  {memo.author !== 'assistant' && (
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
                  )}
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
                <p className={`leading-relaxed whitespace-pre-wrap ${isMain
                  ? 'text-base text-neutral-900 dark:text-neutral-100'
                  : 'text-sm text-neutral-800 dark:text-neutral-200'
                  }`}>
                  {isMain ? memo.content : truncateContent(memo.content)}
                </p>

                <div className="flex items-center justify-between mt-3">
                  <div className="flex items-center gap-4">
                    {showRepliesCount && (
                      <div className="flex items-center gap-1 text-xs text-neutral-500">
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
                    )}

                    {/* Reactions */}
                    <div className="flex items-center gap-1">
                      {Object.entries(getMemoReactions(memo)).map(([emoji, users]) => (
                        <button
                          key={emoji}
                          onClick={() => {
                            if (hasUserReacted(memo, emoji)) {
                              removeReaction(memo.id, emoji);
                            } else {
                              addReaction(memo.id, emoji);
                            }
                          }}
                          className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs transition-colors ${hasUserReacted(memo, emoji)
                            ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                            : 'bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700'
                            }`}
                        >
                          <span>{emoji}</span>
                          <span>{users.length}</span>
                        </button>
                      ))}

                      <div className="relative reaction-picker-container">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowReactionPicker(showReactionPicker === memo.id ? null : memo.id);
                          }}
                          className="h-6 w-6 p-0 text-neutral-400 hover:text-neutral-600"
                        >
                          <Smiley size={14} />
                        </Button>

                        {showReactionPicker === memo.id && (
                          <div className="absolute bottom-full mb-2 left-0 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-xl p-2 flex gap-1 z-50 min-w-max">
                            {['👍', '❤️', '😂', '😮', '😢', '🤖'].map((emoji) => (
                              <button
                                key={emoji}
                                onClick={() => addReaction(memo.id, emoji)}
                                disabled={addingReaction === memo.id}
                                className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded text-lg transition-colors disabled:opacity-50"
                                title={emoji === '🤖' ? 'Ask assistant to respond' : undefined}
                              >
                                {emoji}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

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
            {currentMemo && (
              <Button
                variant="ghost"
                size="sm"
                onClick={navigateBack}
                className="mr-2"
              >
                <ArrowLeft size={16} />
              </Button>
            )}
            <h2 className="font-semibold text-lg">
              {currentMemo ? 'Thread' : 'Memos'}
            </h2>
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
            // Thread view: Show full thread linearly like Twitter/X
            <div>
              {(() => {
                const threadHistory = buildThreadHistory(currentMemo);
                const allThreadMemos = [...threadHistory, currentMemo, ...replies];

                return (
                  <div>
                    {allThreadMemos.map((memo) => {
                      const isFocused = memo.id === currentMemo.id;
                      return renderMemo(memo, isFocused, true);
                    })}

                    {replies.length === 0 && (
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
                );
              })()}
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
                  <span className="text-xs text-neutral-500">
                    {replyContent.length} characters
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
                      disabled={!replyContent.trim() || creatingReply}
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
