"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { Icon, type IconName } from "./Icons";

export type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  leaving: boolean;
}

type PushToast = (message: string, type?: ToastType) => void;

const ToastContext = createContext<PushToast>(() => undefined);

const styles: Record<ToastType, { icon: IconName; ring: string; iconClass: string }> = {
  success: { icon: "check", ring: "border-emerald-500/40", iconClass: "text-emerald-300" },
  error: { icon: "alert", ring: "border-rose-500/40", iconClass: "text-rose-300" },
  warning: { icon: "alert", ring: "border-amber-500/40", iconClass: "text-amber-300" },
  info: { icon: "info", ring: "border-sky-500/40", iconClass: "text-sky-300" },
};

export function useToast(): PushToast {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id));
    }, 280);
  }, []);

  const push = useCallback((message: string, type: ToastType = "info") => {
    const id = crypto.randomUUID();
    setToasts((current) => [...current.slice(-4), { id, type, message, leaving: false }]);
    window.setTimeout(() => dismiss(id), 4000);
  }, [dismiss]);

  const value = useMemo(() => push, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onClose={dismiss} />
    </ToastContext.Provider>
  );
}

export function ToastContainer({ toasts, onClose }: { toasts: ToastItem[]; onClose: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
      {toasts.map((toast) => {
        const style = styles[toast.type];
        return (
          <article key={toast.id} className={`toast-card pointer-events-auto flex items-start gap-3 rounded-xl border bg-slate-900/95 px-3 py-3 shadow-xl shadow-black/30 backdrop-blur ${style.ring} ${toast.leaving ? "toast-leave" : "toast-enter"}`}>
            <span className={`mt-0.5 ${style.iconClass}`}><Icon name={style.icon} /></span>
            <p className="flex-1 text-sm text-slate-100">{toast.message}</p>
            <button type="button" className="rounded p-1 text-slate-400 transition hover:bg-slate-800 hover:text-white" aria-label="Dismiss notification" onClick={() => onClose(toast.id)}>
              <Icon name="x" />
            </button>
          </article>
        );
      })}
    </div>
  );
}
