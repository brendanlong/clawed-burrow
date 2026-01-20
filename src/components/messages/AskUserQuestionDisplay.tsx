'use client';

import { useState, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import type { ToolCall } from './types';

interface QuestionOption {
  label: string;
  description: string;
}

interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface AskUserQuestionInput {
  questions: Question[];
}

// Question mark icon
function QuestionIcon() {
  return (
    <svg
      className="w-5 h-5 text-purple-600 dark:text-purple-400 flex-shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
}

// Checkbox icon for multi-select options
function CheckboxIcon({ checked }: { checked?: boolean }) {
  return (
    <svg
      className={cn(
        'w-4 h-4 flex-shrink-0 mt-0.5',
        checked ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
      )}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      {checked ? (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      ) : (
        <circle cx="12" cy="12" r="9" />
      )}
    </svg>
  );
}

// Radio icon for single-select options
function RadioIcon({ selected }: { selected?: boolean }) {
  return (
    <svg
      className={cn(
        'w-4 h-4 flex-shrink-0 mt-0.5',
        selected ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'
      )}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
      {selected && <circle cx="12" cy="12" r="4" fill="currentColor" />}
    </svg>
  );
}

interface AskUserQuestionDisplayProps {
  tool: ToolCall;
  /** Callback to send a response to Claude */
  onSendResponse?: (response: string) => void;
  /** Whether Claude is currently running (disables clicking options) */
  isClaudeRunning?: boolean;
}

/**
 * Specialized display for AskUserQuestion tool calls.
 * Shows a nicely formatted question with clickable options.
 */
export function AskUserQuestionDisplay({
  tool,
  onSendResponse,
  isClaudeRunning,
}: AskUserQuestionDisplayProps) {
  const [expanded, setExpanded] = useState(true);
  const [selectedOptions, setSelectedOptions] = useState<Map<number, Set<number>>>(new Map());

  const hasOutput = tool.output !== undefined;

  // Check if this is a "real" error vs just waiting for input
  // Claude Code returns is_error: true with "Answer questions?" when waiting for input
  const isWaitingForInput =
    tool.is_error && typeof tool.output === 'string' && tool.output.includes('Answer questions');
  const isRealError = tool.is_error && !isWaitingForInput;
  const isPending = !hasOutput || isWaitingForInput;

  const questions = useMemo(() => {
    const inputObj = tool.input as AskUserQuestionInput | undefined;
    return inputObj?.questions ?? [];
  }, [tool.input]);

  // Handle clicking an option
  const handleOptionClick = (questionIndex: number, optionIndex: number, multiSelect: boolean) => {
    if (!isPending || isClaudeRunning || !onSendResponse) return;

    const question = questions[questionIndex];
    if (!question) return;

    if (multiSelect) {
      // Toggle selection for multi-select
      setSelectedOptions((prev) => {
        const newMap = new Map(prev);
        const currentSet = newMap.get(questionIndex) ?? new Set();
        const newSet = new Set(currentSet);
        if (newSet.has(optionIndex)) {
          newSet.delete(optionIndex);
        } else {
          newSet.add(optionIndex);
        }
        newMap.set(questionIndex, newSet);
        return newMap;
      });
    } else {
      // For single select, immediately send the response
      const option = question.options[optionIndex];
      if (option) {
        onSendResponse(option.label);
      }
    }
  };

  // Handle submitting multi-select responses
  const handleSubmitMultiSelect = (questionIndex: number) => {
    if (!onSendResponse) return;

    const question = questions[questionIndex];
    const selected = selectedOptions.get(questionIndex);
    if (!question || !selected || selected.size === 0) return;

    const selectedLabels = Array.from(selected)
      .map((idx) => question.options[idx]?.label)
      .filter(Boolean);

    onSendResponse(selectedLabels.join(', '));
  };

  // Check if an option is selected (for multi-select)
  const isOptionSelected = (questionIndex: number, optionIndex: number) => {
    return selectedOptions.get(questionIndex)?.has(optionIndex) ?? false;
  };

  return (
    <div className="group">
      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <Card
          className={cn(
            'mt-2',
            isPending &&
              'border-purple-300 dark:border-purple-700 bg-purple-50/50 dark:bg-purple-950/30',
            isRealError && 'border-red-300 dark:border-red-700',
            !isPending && !isRealError && 'border-green-300 dark:border-green-700'
          )}
        >
          <CollapsibleTrigger className="w-full px-3 py-2 text-left flex items-center justify-between text-sm hover:bg-muted/50 rounded-t-xl">
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <QuestionIcon />
              <span className="font-mono text-primary">AskUserQuestion</span>
              {isPending && (
                <Badge
                  variant="outline"
                  className="text-xs border-purple-500 text-purple-700 dark:text-purple-400 animate-pulse"
                >
                  Waiting for input
                </Badge>
              )}
              {isRealError && (
                <Badge variant="destructive" className="text-xs">
                  Error
                </Badge>
              )}
              {!isPending && !isRealError && (
                <Badge
                  variant="outline"
                  className="text-xs border-green-500 text-green-700 dark:text-green-400"
                >
                  Answered
                </Badge>
              )}
            </div>
            <span className="text-muted-foreground ml-2 flex-shrink-0">{expanded ? '−' : '+'}</span>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="p-3 space-y-4">
              {questions.map((question, qIndex) => (
                <div key={qIndex} className="space-y-2">
                  {/* Question header badge */}
                  {question.header && (
                    <Badge variant="secondary" className="text-xs">
                      {question.header}
                    </Badge>
                  )}

                  {/* Question text */}
                  <p className="text-sm font-medium text-foreground">{question.question}</p>

                  {/* Options */}
                  <div className="space-y-1.5 ml-1">
                    {question.options.map((option, oIndex) => {
                      const isSelected = isOptionSelected(qIndex, oIndex);
                      const canClick = isPending && !isClaudeRunning && onSendResponse;

                      return (
                        <button
                          key={oIndex}
                          type="button"
                          disabled={!canClick}
                          onClick={() => handleOptionClick(qIndex, oIndex, question.multiSelect)}
                          className={cn(
                            'flex items-start gap-2 py-1.5 px-2 rounded text-sm w-full text-left',
                            'transition-colors',
                            canClick
                              ? 'bg-muted/50 hover:bg-purple-100 dark:hover:bg-purple-900/50 cursor-pointer'
                              : 'bg-muted/50',
                            isSelected &&
                              'bg-purple-100 dark:bg-purple-900/50 ring-1 ring-purple-400'
                          )}
                        >
                          {question.multiSelect ? (
                            <CheckboxIcon checked={isSelected} />
                          ) : (
                            <RadioIcon selected={isSelected} />
                          )}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium text-foreground">{option.label}</div>
                            {option.description && (
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {option.description}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {/* Submit button for multi-select */}
                  {question.multiSelect &&
                    isPending &&
                    !isClaudeRunning &&
                    onSendResponse &&
                    (selectedOptions.get(qIndex)?.size ?? 0) > 0 && (
                      <button
                        type="button"
                        onClick={() => handleSubmitMultiSelect(qIndex)}
                        className="mt-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white text-sm rounded transition-colors"
                      >
                        Submit Selected
                      </button>
                    )}
                </div>
              ))}

              {/* Show the response if answered (but not the "Answer questions?" error) */}
              {hasOutput && !isWaitingForInput && (
                <div className="pt-2 border-t">
                  <div className="text-xs text-muted-foreground mb-1">Response:</div>
                  <pre
                    className={cn(
                      'text-xs p-2 rounded overflow-x-auto',
                      isRealError
                        ? 'bg-red-50 dark:bg-red-950 text-red-800 dark:text-red-200'
                        : 'bg-muted'
                    )}
                  >
                    {typeof tool.output === 'string'
                      ? tool.output
                      : JSON.stringify(tool.output, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
