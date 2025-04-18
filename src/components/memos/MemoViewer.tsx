import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { TextArea } from "@/components/input/TextArea";
import { Toggle } from "@/components/toggle/Toggle";
import { X, PencilSimple, ArrowClockwise, Check, FlowArrow, Play, ArrowRight, Trash } from "@phosphor-icons/react";
import { useState, useEffect, useCallback } from "react";
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

interface MemoViewerProps {
  memo: Memo;
  onClose: () => void;
  // Optional list of all memos (will be populated by MemosPanel)
  allMemos?: Memo[];
  // Optional callback to refresh the memo list after deletion
  onDelete?: () => void;
}

// Define the header structure
interface MemoHeaders {
  type?: string;
  title?: string;
  description?: string;
  topic?: string;
  keywords?: string[];
}

export function MemoViewer({ memo, onClose, onDelete, allMemos = [] }: MemoViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(memo.content);
  const [saving, setSaving] = useState(false);
  const [currentMemo, setCurrentMemo] = useState<Memo>(memo);
  const [backlinks, setBacklinks] = useState<Memo[]>([]);
  const [loadingBacklinks, setLoadingBacklinks] = useState(false);
  const [executingWorkflow, setExecutingWorkflow] = useState(false);
  const [isWorkflow, setIsWorkflow] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Parse headers to get topic and keywords if available
  const parseHeaders = (headersString: string): MemoHeaders => {
    try {
      const parsedHeaders = JSON.parse(headersString);
      return parsedHeaders;
    } catch {
      return {};
    }
  };

  const headers = parseHeaders(currentMemo.headers);
  // Update isWorkflow state based on headers
  useEffect(() => {
    setIsWorkflow(headers.type === 'workflow');
  }, [headers]);

  // Now we can set up editing state
  const [editIsWorkflow, setEditIsWorkflow] = useState(isWorkflow);
  const [editWorkflowTitle, setEditWorkflowTitle] = useState(
    headers.title || currentMemo.slug
  );
  const [editWorkflowDescription, setEditWorkflowDescription] = useState(
    headers.description || ""
  );

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  };

  // Function to parse the links JSON string
  const parseLinks = (linksString: string) => {
    try {
      return JSON.parse(linksString);
    } catch {
      return { incoming: [], outgoing: [] };
    }
  };

  const links = parseLinks(currentMemo.links);

  // Load backlinks for the current memo
  const loadBacklinks = useCallback(async () => {
    try {
      setLoadingBacklinks(true);
      const response = await fetch(`/agents/chat/default/find-backlinks?slug=${currentMemo.slug}&includeContent=true`);

      if (!response.ok) {
        throw new Error(`Failed to fetch backlinks: ${response.status}`);
      }

      const data = await response.json();
      if (Array.isArray(data)) {
        setBacklinks(data as Memo[]);
      }
    } catch (error) {
      console.error("Error loading backlinks:", error);
    } finally {
      setLoadingBacklinks(false);
    }
  }, [currentMemo.slug]);

  // Load backlinks when component mounts or memo changes
  useEffect(() => {
    loadBacklinks();
  }, [loadBacklinks]);

  // Save the edited content
  const saveMemo = async () => {
    try {
      setSaving(true);

      // Prepare headers based on workflow status
      let updatedHeaders: MemoHeaders = {};
      if (editIsWorkflow) {
        updatedHeaders = {
          type: 'workflow',
          title: editWorkflowTitle || currentMemo.slug,
          description: editWorkflowDescription || ''
        };
      } else {
        // Preserve other header fields but remove workflow type
        updatedHeaders = { ...headers };
        delete updatedHeaders.type;
        delete updatedHeaders.title;
        delete updatedHeaders.description;
      }

      const response = await fetch("/agents/chat/default/edit-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: currentMemo.id,
          slug: currentMemo.slug,
          content: editedContent,
          headers: JSON.stringify(updatedHeaders)
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save memo: ${response.status}`);
      }

      // Update the current memo with the edited content and headers
      const newHeaders = JSON.stringify(updatedHeaders);
      setCurrentMemo({
        ...currentMemo,
        content: editedContent,
        headers: newHeaders,
        modified: new Date().toISOString()
      });

      // Update isWorkflow state based on the new headers
      const newHeadersParsed = parseHeaders(newHeaders);
      const newIsWorkflow = newHeadersParsed.type === 'workflow';
      setIsWorkflow(newIsWorkflow);
      setEditIsWorkflow(newIsWorkflow);
      setEditWorkflowTitle(newHeadersParsed.title || currentMemo.slug);
      setEditWorkflowDescription(newHeadersParsed.description || "");
      setIsEditing(false);

      // Reload backlinks in case they changed
      loadBacklinks();
    } catch (error) {
      console.error("Error saving memo:", error);
    } finally {
      setSaving(false);
    }
  };

  // Execute the current workflow
  const executeWorkflow = async () => {
    if (!isWorkflow) return;

    try {
      setExecutingWorkflow(true);

      // Call the API to execute the workflow - use the agent tool directly
      const response = await fetch("/agents/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: `Execute the workflow called ${currentMemo.slug}`,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to execute workflow: ${response.status}`);
      }

      // Return to the chat after executing
      onClose();
    } catch (error) {
      console.error("Error executing workflow:", error);
    } finally {
      setExecutingWorkflow(false);
    }
  };

  // Handle checkbox toggles in the markdown
  const handleCheckboxToggle = async (index: number, checked: boolean) => {
    const lines = editedContent.split('\n');
    let checkboxCount = 0;

    const updatedLines = lines.map(line => {
      if (line.match(/^\s*-\s*\[[ x]\]/i)) {
        if (checkboxCount === index) {
          return line.replace(/\[[ x]\]/i, checked ? '[x]' : '[ ]');
        }
        checkboxCount++;
      }
      return line;
    });

    const updatedContent = updatedLines.join('\n');
    setEditedContent(updatedContent);

    // If not in edit mode, save the changes immediately
    if (!isEditing) {
      try {
        setSaving(true);
        const response = await fetch("/agents/chat/default/edit-memo", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            id: currentMemo.id,
            slug: currentMemo.slug,
            content: updatedContent,
          }),
        });

        if (!response.ok) {
          throw new Error(`Failed to save memo: ${response.status}`);
        }

        // Update the current memo with the edited content
        setCurrentMemo({ ...currentMemo, content: updatedContent, modified: new Date().toISOString() });
      } catch (error) {
        console.error("Error saving memo:", error);
      } finally {
        setSaving(false);
      }
    }
  };

  // Navigate to a linked memo (client-side only)
  const navigateToMemo = (slug: string) => {
    // First look in allMemos (from the parent component)
    let targetMemo = allMemos.find(memo => memo.slug === slug);

    // If not found in allMemos, check in backlinks
    if (!targetMemo) {
      targetMemo = backlinks.find(memo => memo.slug === slug);
    }

    if (targetMemo) {
      // Use the memo we already have without making a server request
      setCurrentMemo(targetMemo);
      setEditedContent(targetMemo.content);

      // Update workflow state
      const newHeaders = parseHeaders(targetMemo.headers);
      const newIsWorkflow = newHeaders.type === 'workflow';
      setIsWorkflow(newIsWorkflow);
      setEditIsWorkflow(newIsWorkflow);
      setEditWorkflowTitle(newHeaders.title || targetMemo.slug);
      setEditWorkflowDescription(newHeaders.description || "");

      // Load backlinks for the new memo
      loadBacklinks();
    } else {
      // If the memo isn't in our cache, we'll just show the link as is
      console.log(`Note with slug "${slug}" not found in available memos`);
      // Optionally, could show a notification to the user that the linked note doesn't exist
    }
  };

  // End of navigateToMemo function

  // Function to delete the current memo
  const deleteMemo = async () => {
    try {
      setDeleting(true);
      const response = await fetch(`/agents/chat/default/delete-memo?id=${currentMemo.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        throw new Error(`Failed to delete memo: ${response.status}`);
      }

      // Call onDelete callback if provided to refresh the memo list
      if (onDelete) {
        onDelete();
      }

      // Close the memo viewer after successful deletion
      onClose();
    } catch (error) {
      console.error("Error deleting memo:", error);
    } finally {
      setDeleting(false);
      setShowDeleteConfirm(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-white dark:bg-neutral-950 z-50 overflow-auto flex flex-col">
      <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold">{currentMemo.slug}</h2>
          {isWorkflow && (
            <span className="text-xs bg-[#F48120]/20 text-[#F48120] px-2 py-1 rounded-full flex items-center">
              <FlowArrow size={12} className="mr-1" />
              Workflow
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isWorkflow && !isEditing && (
            <Button
              variant="primary"
              size="sm"
              onClick={executeWorkflow}
              disabled={executingWorkflow}
              className="flex items-center gap-1 mr-2"
            >
              {executingWorkflow ? (
                <>
                  <ArrowClockwise size={16} className="animate-spin" />
                  Executing...
                </>
              ) : (
                <>
                  <Play size={16} />
                  Execute Workflow
                </>
              )}
            </Button>
          )}
          {isEditing ? (
            <>
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="rounded-full h-9 w-9"
                onClick={() => {
                  setIsEditing(false);
                  setEditedContent(currentMemo.content); // Revert to original content
                  setEditIsWorkflow(isWorkflow); // Reset workflow state
                  setEditWorkflowTitle(headers.title || currentMemo.slug);
                  setEditWorkflowDescription(headers.description || "");
                }}
              >
                <X size={20} />
              </Button>
              <Button
                variant="primary"
                size="md"
                shape="square"
                className="rounded-full h-9 w-9"
                onClick={saveMemo}
                disabled={saving}
              >
                {saving ? <ArrowClockwise size={20} className="animate-spin" /> : <Check size={20} />}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="rounded-full h-9 w-9"
                onClick={() => setShowDeleteConfirm(true)}
                aria-label="Delete memo"
              >
                <Trash size={20} />
              </Button>
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="rounded-full h-9 w-9"
                onClick={() => setIsEditing(true)}
              >
                <PencilSimple size={20} />
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
            </>
          )}
        </div>
      </div>

      <div className="flex-1 p-4 max-w-3xl mx-auto w-full">
        {isWorkflow && headers.title && (
          <div className="text-lg text-[#F48120] mb-2 font-medium">{headers.title}</div>
        )}
        {isWorkflow && headers.description && (
          <div className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">{headers.description}</div>
        )}
        {!isWorkflow && headers.topic && (
          <div className="text-sm text-[#F48120] mb-4 font-medium">{headers.topic}</div>
        )}

        <Card className={`p-6 mb-6 ${isWorkflow && !isEditing ? 'border-[#F48120]/30' : ''}`}>
          {isEditing ? (
            <div className="space-y-4">
              <div className="flex items-center mb-4">
                <input
                  type="checkbox"
                  id="editWorkflowToggle"
                  className="mr-2"
                  checked={editIsWorkflow}
                  onChange={(e) => setEditIsWorkflow(e.target.checked)}
                />
                <label htmlFor="editWorkflowToggle" className="text-sm flex items-center cursor-pointer">
                  <FlowArrow size={14} className="mr-1 text-[#F48120]" />
                  This is a workflow
                </label>
              </div>

              {editIsWorkflow && (
                <div className="space-y-3 mb-4 p-3 bg-[#F48120]/10 dark:bg-[#F48120]/5 rounded-md">
                  <div>
                    <label className="block text-sm font-medium mb-1">Workflow Title</label>
                    <input
                      type="text"
                      value={editWorkflowTitle}
                      onChange={(e) => setEditWorkflowTitle(e.target.value)}
                      placeholder="Give your workflow a title"
                      className="w-full px-3 py-2 border rounded-md bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium mb-1">Workflow Description</label>
                    <input
                      type="text"
                      value={editWorkflowDescription}
                      onChange={(e) => setEditWorkflowDescription(e.target.value)}
                      placeholder="Briefly describe what this workflow does"
                      className="w-full px-3 py-2 border rounded-md bg-neutral-100 dark:bg-neutral-800 border-neutral-300 dark:border-neutral-700"
                    />
                  </div>
                </div>
              )}

              <TextArea
                className="w-full min-h-[200px] font-mono text-sm"
                value={editedContent}
                onChange={(e) => setEditedContent(e.target.value)}
                onValueChange={undefined}
              />
            </div>
          ) : (
            <div className={`prose dark:prose-invert max-w-none ${isWorkflow ? 'workflow-content' : ''}`}>
              {isWorkflow && !isEditing && (
                <div className="mb-4 p-3 bg-[#F48120]/10 dark:bg-[#F48120]/5 rounded-md text-sm">
                  <div className="flex items-center">
                    <FlowArrow size={16} className="text-[#F48120] mr-2" />
                    <span className="font-medium text-[#F48120]">Workflow Steps</span>
                  </div>
                  <p className="mt-1 text-neutral-600 dark:text-neutral-400">This is a workflow memo. Click "Execute Workflow" to run these steps.</p>
                </div>
              )}
              {/* Process the content for standalone backlinks first */}
              {currentMemo.content.split('\n').map((line, lineIndex) => {
                // Check if line is just a backlink
                const standaloneMatch = line.trim().match(/^\[\[(.*?)\]\]$/);
                if (standaloneMatch) {
                  const slug = standaloneMatch[1];
                  return (
                    <p key={`line-${lineIndex}`} className="my-1">
                      <button
                        className="text-[#F48120] hover:underline font-medium"
                        onClick={() => navigateToMemo(slug)}
                      >
                        {slug}
                      </button>
                    </p>
                  );
                }

                // Check if the line contains any backlinks
                const backlinkRegex = /\[\[(.*?)\]\]/g;
                let match;
                let containsBacklinks = false;
                const matches = [];

                // Reset regex
                backlinkRegex.lastIndex = 0;

                // Check for backlinks in this line
                while ((match = backlinkRegex.exec(line)) !== null) {
                  containsBacklinks = true;
                  matches.push({
                    fullMatch: match[0],
                    slug: match[1],
                    index: match.index
                  });
                }

                // If line contains backlinks, process them directly
                if (containsBacklinks) {
                  const parts = [];
                  let lastIndex = 0;

                  // Build elements with clickable backlinks
                  matches.forEach((m, i) => {
                    if (m.index > lastIndex) {
                      parts.push(line.substring(lastIndex, m.index));
                    }

                    parts.push(
                      <button
                        key={`backlink-${lineIndex}-${i}`}
                        className="text-[#F48120] hover:underline font-medium"
                        onClick={() => navigateToMemo(m.slug)}
                      >
                        {m.slug}
                      </button>
                    );

                    lastIndex = m.index + m.fullMatch.length;
                  });

                  if (lastIndex < line.length) {
                    parts.push(line.substring(lastIndex));
                  }

                  return <p key={`line-${lineIndex}`} className="my-1">{parts}</p>;
                }

                // For lines without backlinks, use ReactMarkdown
                return (
                  <div key={`line-${lineIndex}`}>
                    <ReactMarkdown components={{
                      // Custom renderer for text to handle backlinks
                      text: ({ children }) => {
                        // Process backlinks
                        const text = String(children);
                        const backlinkPattern = /\[\[(.*?)\]\]/g;
                        const parts: React.ReactNode[] = [];
                        let lastIndex = 0;
                        let match;
                        let matchFound = false;

                        while ((match = backlinkPattern.exec(text)) !== null) {
                          matchFound = true;
                          if (match.index > lastIndex) {
                            parts.push(text.substring(lastIndex, match.index));
                          }

                          const slug = match[1];
                          parts.push(
                            <button
                              key={`${slug}-${match.index}`}
                              className="text-[#F48120] hover:underline font-medium"
                              onClick={() => navigateToMemo(slug)}
                            >
                              {slug}
                            </button>
                          );

                          lastIndex = match.index + match[0].length;
                        }

                        if (lastIndex < text.length) {
                          parts.push(text.substring(lastIndex));
                        }

                        return matchFound ? <>{parts}</> : <>{text}</>;
                      },

                      // Custom renderer for list items to handle checkboxes
                      li: (props: any) => {
                        // Check if this is a checkbox item
                        const liContent = props.children?.toString() || '';
                        const checkboxMatch = liContent.match(/^\[([x ])\]\s*(.*)$/i);

                        if (checkboxMatch) {
                          const checked = checkboxMatch[1].toLowerCase() === 'x';
                          const index = document.querySelectorAll('input[type="checkbox"]').length;

                          return (
                            <li className="flex items-start gap-2 my-1">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={(e) => handleCheckboxToggle(index, e.target.checked)}
                                className="mt-1"
                              />
                              <span>{checkboxMatch[2]}</span>
                            </li>
                          );
                        }

                        return <li>{props.children}</li>;
                      },

                      // Handle paragraphs to ensure they work with our backlink rendering
                      p: ({ children }) => {
                        return <p>{children}</p>;
                      }
                    }}>
                      {line}
                    </ReactMarkdown>
                  </div>
                );
              })}

            </div>
          )}
        </Card>

        {!isEditing && backlinks.length > 0 && (
          <Card className="p-6 mb-6">
            <h3 className="text-sm font-medium mb-3">Referenced by</h3>
            <div className="space-y-2">
              {backlinks.map((link) => (
                <div
                  key={link.id}
                  className="p-2 border border-neutral-200 dark:border-neutral-800 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900 cursor-pointer"
                  onClick={() => navigateToMemo(link.slug)}
                >
                  <div className="font-medium">{link.slug}</div>
                  <div className="text-xs text-neutral-500 dark:text-neutral-400">
                    {formatDate(link.modified)}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {headers.keywords && headers.keywords.length > 0 && (
          <div className="mb-6">
            <h3 className="text-sm font-medium mb-2">Keywords</h3>
            <div className="flex flex-wrap gap-2">
              {headers.keywords.map((keyword: string, index: number) => (
                <span
                  key={index}
                  className="text-sm bg-neutral-100 dark:bg-neutral-800 px-3 py-1 rounded-full"
                >
                  {keyword}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="text-sm text-neutral-500 dark:text-neutral-400">
          <div>Created: {formatDate(currentMemo.created)}</div>
          <div>Modified: {formatDate(currentMemo.modified)}</div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
          <div className="bg-white dark:bg-neutral-900 rounded-lg p-5 max-w-md w-full">
            <h3 className="text-lg font-semibold mb-3">Delete Memo</h3>
            <p className="mb-4">Are you sure you want to delete "{currentMemo.slug}"? This action cannot be undone.</p>
            
            <div className="flex justify-end gap-3">
              <Button 
                variant="ghost" 
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button 
                variant="destructive" 
                onClick={deleteMemo}
                disabled={deleting}
              >
                {deleting ? (
                  <>
                    <ArrowClockwise size={16} className="animate-spin mr-2" />
                    Deleting...
                  </>
                ) : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
