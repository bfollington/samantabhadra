import { useState, useEffect } from 'react';
import { X, ArrowLeft, ArrowClockwise, ArrowUpRight, ArrowDownRight } from '@phosphor-icons/react';
import { Card } from '@/components/card/Card';
import { Button } from '@/components/button/Button';
import ReactMarkdown from 'react-markdown';
import { BacklinkRenderer } from '@/components/chat/BacklinkRenderer';

interface FragmentLink {
  rel: string;
  to_id?: string;
  to_slug?: string;
  from_id?: string;
  from_slug?: string;
}

interface Fragment {
  id: string;
  slug: string;
  content: string;
  speaker?: string | null;
  ts: string;
  convo_id?: string | null;
  metadata: string;
  created: string;
  modified: string;
}

interface FragmentViewerProps {
  slug: string;
  onClose: () => void;
  onNavigateToFragment?: (slug: string) => void;
}

export function FragmentViewer({ slug, onClose, onNavigateToFragment }: FragmentViewerProps) {
  const [fragment, setFragment] = useState<Fragment | null>(null);
  const [outgoingLinks, setOutgoingLinks] = useState<FragmentLink[]>([]);
  const [incomingLinks, setIncomingLinks] = useState<FragmentLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchFragment() {
      try {
        setLoading(true);
        setError(null);
        setFragment(null);
        setOutgoingLinks([]);
        setIncomingLinks([]);

        const response = await fetch(`/agents/chat/default/fragment?slug=${encodeURIComponent(slug)}`);
        
        if (!response.ok) {
          throw new Error(`Failed to fetch fragment: ${response.status} ${response.statusText}`);
        }
        
        const data = await response.json();
        
        setFragment(data.fragment);
        setOutgoingLinks(data.outgoing || []);
        setIncomingLinks(data.incoming || []);
      } catch (err) {
        console.error('Error fetching fragment:', err);
        setError((err as Error).message || 'Failed to load fragment');
      } finally {
        setLoading(false);
      }
    }

    if (slug) {
      fetchFragment();
    }
  }, [slug]);

  const handleLinkClick = (targetSlug: string) => {
    if (onNavigateToFragment) {
      onNavigateToFragment(targetSlug);
    }
  };

  const formatDateTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleString();
    } catch (e) {
      return isoString;
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-30 bg-white/90 dark:bg-neutral-950/90 flex items-center justify-center">
        <Card className="max-w-2xl w-full p-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <ArrowClockwise size={16} className="animate-spin" />
            <span>Loading fragment...</span>
          </div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-30 bg-white/90 dark:bg-neutral-950/90 flex items-center justify-center">
        <Card className="max-w-2xl w-full p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-lg font-semibold">Error</h2>
            <Button variant="ghost" size="sm" shape="square" onClick={onClose}>
              <X size={18} />
            </Button>
          </div>
          <p className="text-red-500">{error}</p>
          <div className="mt-4 flex justify-end">
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
          </div>
        </Card>
      </div>
    );
  }

  if (!fragment) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-30 bg-white/90 dark:bg-neutral-950/90 flex items-center justify-center overflow-auto py-8">
      <Card className="max-w-3xl w-full p-6 mx-4 relative">
        {/* Header */}
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2">
            <Button 
              variant="ghost" 
              size="sm" 
              shape="square" 
              onClick={onClose}
              className="mr-1"
            >
              <ArrowLeft size={18} />
            </Button>
            <h2 className="text-lg font-semibold text-[#F48120]">{fragment.slug}</h2>
          </div>
          <Button variant="ghost" size="sm" shape="square" onClick={onClose}>
            <X size={18} />
          </Button>
        </div>

        {/* Content */}
        <div className="mb-6 prose dark:prose-invert max-w-none prose-sm">
          <BacklinkRenderer 
            text={fragment.content} 
            onNavigateToMemo={(memoSlug) => {
              // Handle memo navigation
              onClose();
              // Signal that a memo should be opened
              sessionStorage.setItem('openMemoSlug', memoSlug);
            }} 
          />
        </div>

        {/* Metadata */}
        <div className="mb-6 grid grid-cols-2 gap-4 text-sm text-muted-foreground">
          <div>
            {fragment.speaker && (
              <p><span className="font-medium">Speaker:</span> {fragment.speaker}</p>
            )}
            {fragment.ts && (
              <p><span className="font-medium">Time:</span> {formatDateTime(fragment.ts)}</p>
            )}
          </div>
          <div>
            <p><span className="font-medium">Created:</span> {formatDateTime(fragment.created)}</p>
            <p><span className="font-medium">Modified:</span> {formatDateTime(fragment.modified)}</p>
          </div>
        </div>

        {/* Links */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Outgoing Links */}
          <div>
            <h3 className="text-md font-semibold mb-2 flex items-center gap-1">
              <ArrowUpRight size={16} />
              Outgoing Links ({outgoingLinks.length})
            </h3>
            {outgoingLinks.length > 0 ? (
              <ul className="space-y-2">
                {outgoingLinks.map((link, i) => (
                  <li key={`out-${i}`} className="border border-neutral-200 dark:border-neutral-800 rounded p-2">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-xs bg-neutral-100 dark:bg-neutral-900 px-1.5 py-0.5 rounded">
                        {link.rel}
                      </span>
                    </div>
                    <button 
                      className="text-[#F48120] hover:underline font-medium flex items-center gap-0.5"
                      onClick={() => handleLinkClick(link.to_slug!)}
                    >
                      [[{link.to_slug}]]
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No outgoing links</p>
            )}
          </div>

          {/* Incoming Links */}
          <div>
            <h3 className="text-md font-semibold mb-2 flex items-center gap-1">
              <ArrowDownRight size={16} />
              Incoming Links ({incomingLinks.length})
            </h3>
            {incomingLinks.length > 0 ? (
              <ul className="space-y-2">
                {incomingLinks.map((link, i) => (
                  <li key={`in-${i}`} className="border border-neutral-200 dark:border-neutral-800 rounded p-2">
                    <div className="flex items-center gap-1 mb-1">
                      <span className="text-xs bg-neutral-100 dark:bg-neutral-900 px-1.5 py-0.5 rounded">
                        {link.rel}
                      </span>
                    </div>
                    <button 
                      className="text-[#F48120] hover:underline font-medium flex items-center gap-0.5"
                      onClick={() => handleLinkClick(link.from_slug!)}
                    >
                      [[{link.from_slug}]]
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No incoming links</p>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}