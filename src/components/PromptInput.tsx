'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  onInterrupt: () => void;
  isRunning: boolean;
  isInterrupting: boolean;
  disabled: boolean;
}

export function PromptInput({
  onSubmit,
  onInterrupt,
  isRunning,
  isInterrupting,
  disabled,
}: PromptInputProps) {
  const [prompt, setPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [prompt]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (prompt.trim() && !disabled && !isRunning) {
      onSubmit(prompt.trim());
      setPrompt('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="border-t bg-background p-4">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <Textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              disabled
                ? 'Session is not running'
                : isRunning
                  ? 'Claude is thinking...'
                  : 'Type your message... (Enter to send, Shift+Enter for new line)'
            }
            disabled={disabled || isRunning}
            rows={1}
            className="min-h-[44px] resize-none"
          />
        </div>

        {isRunning ? (
          <Button
            type="button"
            variant="destructive"
            onClick={onInterrupt}
            disabled={isInterrupting}
          >
            {isInterrupting ? 'Stopping...' : 'Stop'}
          </Button>
        ) : (
          <Button type="submit" disabled={!prompt.trim() || disabled}>
            Send
          </Button>
        )}
      </div>
    </form>
  );
}
