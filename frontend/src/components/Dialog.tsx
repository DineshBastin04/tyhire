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

type ToastVariant = "error" | "success" | "info";

interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Auto-dismiss delay in ms. Defaults to 4500; pass 0 to require manual dismissal. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
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
  /** Non-blocking transient notification (e.g. an error after a failed action). */
  toast: (options: ToastOptions) => void;
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
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((options: ToastOptions) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, ...options }]);
    const duration = options.duration ?? 4500;
    if (duration > 0 && typeof window !== "undefined") {
      window.setTimeout(() => dismissToast(id), duration);
    }
  }, [dismissToast]);

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
    <DialogContext.Provider value={{ confirm, prompt, notify, toast }}>
      {children}
      {toasts.length > 0 && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 w-80 max-w-[calc(100vw-2rem)]">
          {toasts.map((t) => {
            const variant = t.variant ?? "info";
            const tone =
              variant === "error"
                ? "bg-red-50 border-red-300 text-red-800"
                : variant === "success"
                ? "bg-emerald-50 border-emerald-300 text-emerald-800"
                : "bg-zinc-50 border-zinc-300 text-zinc-800";
            return (
              <div
                key={t.id}
                role="alert"
                className={`flex items-start gap-2 rounded-md border shadow-sm p-3 text-sm ${tone}`}
              >
                <span className="flex-1 whitespace-pre-wrap break-words">{t.message}</span>
                <button
                  onClick={() => dismissToast(t.id)}
                  aria-label="Dismiss"
                  className="shrink-0 leading-none text-base opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      {state && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={cancel}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="bg-surface rounded-md shadow-lg max-w-sm w-full p-5 space-y-3"
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
