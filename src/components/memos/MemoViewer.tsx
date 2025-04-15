import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { X } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";

interface MemoViewerProps {
  memo: {
    id: string;
    slug: string;
    content: string;
    headers: string;
    links: string;
    created: string;
    modified: string;
  };
  onClose: () => void;
}

export function MemoViewer({ memo, onClose }: MemoViewerProps) {
  // Parse headers to get topic and keywords if available
  const parseHeaders = (headersString: string) => {
    try {
      const headers = JSON.parse(headersString);
      return headers;
    } catch {
      return {};
    }
  };

  const headers = parseHeaders(memo.headers);
  
  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString() + " " + date.toLocaleTimeString();
  };

  return (
    <div className="fixed inset-0 bg-white dark:bg-neutral-950 z-50 overflow-auto flex flex-col">
      <div className="sticky top-0 z-10 bg-white dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800 px-4 py-3 flex justify-between items-center">
        <h2 className="font-semibold">{memo.slug}</h2>
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
      
      <div className="flex-1 p-4 max-w-3xl mx-auto w-full">
        {headers.topic && (
          <div className="text-sm text-[#F48120] mb-4 font-medium">{headers.topic}</div>
        )}
        
        <Card className="p-6 mb-6">
          <div className="prose dark:prose-invert max-w-none">
            <ReactMarkdown>{memo.content}</ReactMarkdown>
          </div>
        </Card>
        
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
          <div>Created: {formatDate(memo.created)}</div>
          <div>Modified: {formatDate(memo.modified)}</div>
        </div>
      </div>
    </div>
  );
}