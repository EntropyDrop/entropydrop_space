import React, { useEffect, useRef } from 'react';

interface ThoughtBoxProps {
  className?: string;
  isStreaming?: boolean;
  reasoning?: string;
  title?: string;
}

/**
 * Collapsible thought/reasoning box with smart auto-scrolling:
 * Auto-scrolls to the bottom as new chunks stream in, unless the user
 * actively scrolls up to read earlier parts of the thought.
 */
export function ThoughtBox({
  className = '',
  isStreaming = false,
  reasoning = '',
  title = 'Reasoning & Architecture'
}: ThoughtBoxProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);

  const handleScroll = () => {
    const el = contentRef.current;
    if (!el) return;
    // If within 30px of bottom, consider user as "at bottom" (auto-scroll enabled)
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    userScrolledUpRef.current = !isAtBottom;
  };

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    if (!userScrolledUpRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [reasoning]);

  useEffect(() => {
    if (isStreaming) {
      userScrolledUpRef.current = false;
    }
  }, [isStreaming]);

  if (!reasoning) return null;

  return (
    <details className={`agent-thought-details ${className}`} open={isStreaming || true}>
      <summary className="agent-thought-summary">
        <span className="thought-icon">💭</span>{' '}
        <span className="thought-title">{isStreaming ? 'Thinking…' : title}</span>
      </summary>
      <div
        ref={contentRef}
        className="agent-thought-content"
        onScroll={handleScroll}
      >
        {reasoning}
      </div>
    </details>
  );
}
