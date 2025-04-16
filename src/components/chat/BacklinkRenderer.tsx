import { useState, useEffect } from 'react';

interface BacklinkRendererProps {
  text: string;
  onNavigateToMemo: (slug: string) => void;
}

/**
 * Component that renders text with [[backlinks]] as clickable links
 */
export function BacklinkRenderer({ text, onNavigateToMemo }: BacklinkRendererProps) {
  const [elements, setElements] = useState<React.ReactNode[]>([]);

  useEffect(() => {
    if (!text) {
      setElements([]);
      return;
    }

    // Process the text to find backlinks
    const backlinkPattern = /\[\[(.*?)\]\]/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match;
    let matchFound = false;

    // Clone the text
    const textStr = String(text);

    // Find all backlinks
    while ((match = backlinkPattern.exec(textStr)) !== null) {
      matchFound = true;
      if (match.index > lastIndex) {
        parts.push(textStr.substring(lastIndex, match.index));
      }
      
      const slug = match[1];
      parts.push(
        <button 
          key={`${slug}-${match.index}`}
          className="text-[#F48120] hover:underline font-medium"
          onClick={() => onNavigateToMemo(slug)}
        >
          {slug}
        </button>
      );
      
      lastIndex = match.index + match[0].length;
    }
    
    // Add any remaining text
    if (lastIndex < textStr.length) {
      parts.push(textStr.substring(lastIndex));
    }
    
    // If no matches were found, just return the original text
    if (!matchFound) {
      setElements([textStr]);
    } else {
      setElements(parts);
    }
  }, [text, onNavigateToMemo]);

  return <>{elements}</>;
}