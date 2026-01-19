'use client';

import { useState } from 'react';

interface ToolCall {
  name: string;
  input: unknown;
  output?: unknown;
}

interface MessageContent {
  type?: string;
  content?: string | unknown[];
  tool_calls?: ToolCall[];
  result?: unknown;
  [key: string]: unknown;
}

function ToolCallDisplay({ tool }: { tool: ToolCall }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="mt-2 border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 bg-gray-50 text-left flex items-center justify-between text-sm hover:bg-gray-100"
      >
        <span className="font-mono text-blue-600">{tool.name}</span>
        <span className="text-gray-400">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="p-3 space-y-2 text-xs">
          <div>
            <div className="text-gray-500 mb-1">Input:</div>
            <pre className="bg-gray-50 p-2 rounded overflow-x-auto">
              {JSON.stringify(tool.input, null, 2)}
            </pre>
          </div>
          {tool.output !== undefined && (
            <div>
              <div className="text-gray-500 mb-1">Output:</div>
              <pre className="bg-gray-50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto">
                {typeof tool.output === 'string'
                  ? tool.output
                  : JSON.stringify(tool.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function renderContent(content: unknown): React.ReactNode {
  if (typeof content === 'string') {
    return <p className="whitespace-pre-wrap">{content}</p>;
  }

  if (Array.isArray(content)) {
    return content.map((item, index) => {
      if (typeof item === 'string') {
        return (
          <p key={index} className="whitespace-pre-wrap">
            {item}
          </p>
        );
      }
      if (item && typeof item === 'object' && 'text' in item) {
        return (
          <p key={index} className="whitespace-pre-wrap">
            {String(item.text)}
          </p>
        );
      }
      return null;
    });
  }

  return null;
}

export function MessageBubble({ message }: { message: { type: string; content: unknown } }) {
  const { type } = message;
  const content = (message.content || {}) as MessageContent;

  const isUser = type === 'user';
  const isAssistant = type === 'assistant';
  const isSystem = type === 'system';
  const isResult = type === 'result';

  const bubbleClass = isUser
    ? 'bg-blue-600 text-white ml-auto'
    : isAssistant
      ? 'bg-white border border-gray-200'
      : isSystem
        ? 'bg-gray-100 text-gray-600 text-sm'
        : isResult
          ? 'bg-green-50 border border-green-200 text-green-800 text-sm'
          : 'bg-gray-100';

  return (
    <div className={`max-w-[85%] rounded-lg p-4 ${bubbleClass}`}>
      {isSystem && <div className="text-xs font-medium text-gray-500 mb-1">System</div>}
      {isResult && <div className="text-xs font-medium text-green-600 mb-1">Result</div>}

      {renderContent(content.content)}

      {content.tool_calls && content.tool_calls.length > 0 && (
        <div className="mt-2 space-y-2">
          {content.tool_calls.map((tool, index) => (
            <ToolCallDisplay key={index} tool={tool} />
          ))}
        </div>
      )}

      {isResult && content.result !== undefined && (
        <pre className="mt-2 bg-white p-2 rounded text-xs overflow-x-auto">
          {String(
            typeof content.result === 'string'
              ? content.result
              : JSON.stringify(content.result, null, 2)
          )}
        </pre>
      )}
    </div>
  );
}
