"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions extends ConfirmOptions {
  placeholder?: string;
  defaultValue?: string;
  /** Defaults to true — set false for a note that's fine to leave blank. */
  required?: boolean;
}

interface NotifyOptions {
  title: string;
  description?: string;
  okLabel?: string;
}

type DialogState =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void }
  | { kind: "notify"; options: NotifyOptions; resolve: () => void }
  | null;

interface DialogContextValue {
  /** Replaces window.confirm — resolves true/false. */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Replaces window.prompt — resolves the typed text, or null if cancelled. */
  prompt: (options: PromptOptions) => Promise<string | null>;
  /** Replaces window.alert — resolves once dismissed. */
  notify: (options: NotifyOptions) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialog must be used within a DialogProvider");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DialogState>(null);
  const [inputValue, setInputValue] = useState("");

  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ kind: "confirm", options, resolve });
    });
  }, []);

  const prompt = useCallback((options: PromptOptions) => {
    return new Promise<string | null>((resolve) => {
      setInputValue(options.defaultValue ?? "");
      setState({ kind: "prompt", options, resolve });
    });
  }, []);

  const notify = useCallback((options: NotifyOptions) => {
    return new Promise<void>((resolve) => {
      setState({ kind: "notify", options, resolve });
    });
  }, []);

  const cancel = useCallback(() => {
    if (!state) return;
    if (state.kind === "confirm") state.resolve(false);
    else if (state.kind === "prompt") state.resolve(null);
    else state.resolve();
    setState(null);
    setInputValue("");
  }, [state]);

  const required = state?.kind === "prompt" && state.options.required !== false;
  const blocked = required && !inputValue.trim();

  const submit = useCallback(() => {
    if (!state || blocked) return;
    if (state.kind === "confirm") state.resolve(true);
    else if (state.kind === "prompt") state.resolve(inputValue.trim());
    else state.resolve();
    setState(null);
    setInputValue("");
  }, [state, blocked, inputValue]);

  // Escape-to-cancel, everywhere a dialog is open — native confirm/prompt/alert all
  // supported this and losing it would be a regression, not just a style change.
  useEffect(() => {
    if (!state) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") cancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state, cancel]);

  return (
    <DialogContext.Provider value={{ confirm, prompt, notify }}>
      {children}
      {state && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={cancel}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-white rounded-md shadow-lg max-w-sm w-full p-5 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-sm font-semibold text-zinc-900">{state.options.title}</h2>
            {state.options.description && (
              <p className="text-sm text-zinc-600 whitespace-pre-wrap">
                {state.options.description}
              </p>
            )}
            {state.kind === "prompt" && (
              <input
                autoFocus
                className="input"
                value={inputValue}
                placeholder={state.options.placeholder}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            )}
            <div className="flex justify-end gap-2 pt-1">
              {state.kind !== "notify" && (
                <button onClick={cancel} className="btn-outline text-xs px-2 py-1">
                  {state.options.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                autoFocus={state.kind !== "prompt"}
                onClick={submit}
                disabled={blocked}
                className={
                  state.kind !== "notify" && state.options.danger
                    ? "btn-danger-outline text-xs px-2 py-1"
                    : "btn-primary text-xs px-2 py-1"
                }
              >
                {state.kind === "notify"
                  ? state.options.okLabel ?? "OK"
                  : state.options.confirmLabel ?? "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  );
}
