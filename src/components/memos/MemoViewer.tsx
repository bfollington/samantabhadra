import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { TextArea } from "@/components/input/TextArea";
import { Toggle } from "@/components/toggle/Toggle";
import { X, PencilSimple, ArrowClockwise, Check } from "@phosphor-icons/react";
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
}

export function MemoViewer({ memo, onClose, allMemos = [] }: MemoViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(memo.content);
  const [saving, setSaving] = useState(false);
  const [currentMemo, setCurrentMemo] = useState<Memo>(memo);
  const [backlinks, setBacklinks] = useState<Memo[]>([]);
  const [loadingBacklinks, setLoadingBacklinks] = useState(false);

  // Parse headers to get topic and keywords if available
  const parseHeaders = (headersString: string) => {
    try {
      const headers = JSON.parse(headersString);
      return headers;
    } catch {
      return {};
    }
  };

  const headers = parseHeaders(currentMemo.headers);

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
      const response = await fetch(`/agents/chat/default/list-backlinks?slug=${currentMemo.slug}&includeContent=true`);

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
      const response = await fetch("/agents/chat/default/edit-memo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id: currentMemo.id,
          slug: currentMemo.slug,
          content: editedContent,
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to save memo: ${response.status}`);
      }

      // Update the current memo with the edited content
      setCurrentMemo({ ...currentMemo, content: editedContent, modified: new Date().toISOString() });
      setIsEditing(false);

      // Reload backlinks in case they changed
      loadBacklinks();
    } catch (error) {
      console.error("Error saving memo:", error);
    } finally {
      setSaving(false);
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
      // Load backlinks for the new memo
      loadBacklinks();
    } else {
      // If the memo isn't in our cache, we'll just show the link as is
      console.log(`Note with slug "${slug}" not found in available memos`);
      // Optionally, could show a notification to the user that the linked note doesn't exist
    }
  };

  // Function to process text and make backlinks clickable
  const renderBacklinks = (text: string) => {
    if (!text) return text;
    
    const backlinkPattern = /\[\[(.*?)\]\]/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;

    while ((match = backlinkPattern.exec(text)) !== null) {
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
    
    return parts.length > 1 ? <>{parts}</> : text;
  };

  // Custom renderer for ReactMarkdown
  const customRenderers: Record<string, React.ComponentType<any>> = {
    text: ({ children }: { children: any }) => {
      // Use the renderBacklinks function for all text nodes
      return renderBacklinks(String(children));
    },

    // Add handlers for other elements to ensure backlinks work everywhere
    strong: ({ children }: { children: any }) => {
      return <strong>{children}</strong>;
    },

    em: ({ children }: { children: any }) => {
      return <em>{children}</em>;
    },

    h1: ({ children }: { children: any }) => {
      return <h1>{children}</h1>;
    },

    h2: ({ children }: { children: any }) => {
      return <h2>{children}</h2>;
    },

    h3: ({ children }: { children: any }) => {
      return <h3>{children}</h3>;
    },
    li: (props: any) => {
      // Check if this is a checkbox item (look at the first child's text content)
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
    }
  };

  return (
    <div className="fixed inset-0 bg-white dark:bg-neutral-950 z-50 overflow-auto flex flex-col">
      <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex justify-between items-center">
        <h2 className="font-semibold">{currentMemo.slug}</h2>
        <div className="flex items-center gap-2">
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
        {headers.topic && (
          <div className="text-sm text-[#F48120] mb-4 font-medium">{headers.topic}</div>
        )}

        <Card className="p-6 mb-6">
          {isEditing ? (
            <TextArea
              className="w-full min-h-[200px] font-mono text-sm"
              value={editedContent}
              onChange={(e) => setEditedContent(e.target.value)}
              onValueChange={undefined}
            />
          ) : (
            <div className="prose dark:prose-invert max-w-none">
              {/* Process the content first to handle standalone backlinks */}
              {currentMemo.content.split('\n').map((line, i) => {
                // Check if the line consists only of a backlink
                if (line.trim().match(/^\[\[(.*?)\]\]$/)) {
                  const slug = line.trim().match(/^\[\[(.*?)\]\]$/)?.[1] || '';
                  return (
                    <p key={i}>
                      <button 
                        className="text-[#F48120] hover:underline font-medium"
                        onClick={() => navigateToMemo(slug)}
                      >
                        {slug}
                      </button>
                    </p>
                  );
                }
                // Otherwise render with ReactMarkdown
                return <ReactMarkdown key={i} components={customRenderers}>{line}</ReactMarkdown>;
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
    </div>
  );
}
