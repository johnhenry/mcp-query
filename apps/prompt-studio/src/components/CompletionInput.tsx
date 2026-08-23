// The marquee control: a text input whose suggestions come from the SERVER via
// completion/complete (MCP's argument-autocompletion capability). Works for both
// prompt arguments (ref/prompt) and resource-template variables (ref/resource).
import { useEffect, useRef, useState } from "react";
import { useMCPClient } from "@johnhenry/mcp-query/react";

export type CompletionRef = { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };

export interface CompletionInputProps {
  server: string;
  refFor: CompletionRef;
  argName: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  /** Values already filled in — lets the server narrow dependent completions. */
  contextArgs?: Record<string, string>;
}

export function CompletionInput({ server, refFor, argName, value, onChange, placeholder, required, contextArgs }: CompletionInputProps) {
  const client = useMCPClient();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const blurTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const values = await client.complete(refFor, { name: argName, value }, server, {
          context: contextArgs && Object.keys(contextArgs).length ? { arguments: contextArgs } : undefined,
        });
        setSuggestions(values);
      } catch {
        setSuggestions([]); // server may not support completions for this ref
      }
    }, 150);
    return () => {
      clearTimeout(timer.current);
      clearTimeout(blurTimer.current);
    };
  }, [client, server, argName, value, JSON.stringify(refFor), JSON.stringify(contextArgs)]);

  return (
    <div className="completion-input">
      <input
        type="text"
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          clearTimeout(blurTimer.current);
          setOpen(true);
        }}
        onBlur={() => {
          clearTimeout(blurTimer.current);
          blurTimer.current = setTimeout(() => setOpen(false), 150);
        }}
      />
      {open && suggestions.length > 0 && (
        <ul className="suggestions" role="listbox">
          {suggestions.map((s) => (
            <li key={s}>
              <button type="button" role="option" onMouseDown={() => onChange(s)}>
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
