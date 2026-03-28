import * as React from "react";
import type { ToastActionElement, ToastProps } from "@/components/ui/toast";
const TOAST_LIMIT = 1, TOAST_REMOVE_DELAY = 1000000;
type ToasterToast = ToastProps & { id: string; title?: React.ReactNode; description?: React.ReactNode; action?: ToastActionElement; };
const actionTypes = { ADD_TOAST: "ADD_TOAST", UPDATE_TOAST: "UPDATE_TOAST", DISMISS_TOAST: "DISMISS_TOAST", REMOVE_TOAST: "REMOVE_TOAST" } as const;
let count = 0;
function genId() { count = (count + 1) % Number.MAX_SAFE_INTEGER; return count.toString(); }
type ActionType = typeof actionTypes;
type Action = { type: ActionType["ADD_TOAST"]; toast: ToasterToast } | { type: ActionType["UPDATE_TOAST"]; toast: Partial<ToasterToast> } | { type: ActionType["DISMISS_TOAST"]; toastId?: string } | { type: ActionType["REMOVE_TOAST"]; toastId?: string };
interface State { toasts: ToasterToast[]; }
const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const addToRemoveQueue = (id: string) => { if (toastTimeouts.has(id)) return; toastTimeouts.set(id, setTimeout(() => { toastTimeouts.delete(id); dispatch({ type: "REMOVE_TOAST", toastId: id }); }, TOAST_REMOVE_DELAY)); };
export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST": return { ...state, toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT) };
    case "UPDATE_TOAST": return { ...state, toasts: state.toasts.map(t => t.id === action.toast.id ? { ...t, ...action.toast } : t) };
    case "DISMISS_TOAST": { const { toastId } = action; if (toastId) addToRemoveQueue(toastId); else state.toasts.forEach(t => addToRemoveQueue(t.id)); return { ...state, toasts: state.toasts.map(t => t.id === toastId || toastId === undefined ? { ...t, open: false } : t) }; }
    case "REMOVE_TOAST": return action.toastId === undefined ? { ...state, toasts: [] } : { ...state, toasts: state.toasts.filter(t => t.id !== action.toastId) };
  }
};
const listeners: Array<(s: State) => void> = [];
let memoryState: State = { toasts: [] };
function dispatch(action: Action) { memoryState = reducer(memoryState, action); listeners.forEach(l => l(memoryState)); }
type Toast = Omit<ToasterToast, "id">;
function toast({ ...props }: Toast) {
  const id = genId();
  dispatch({ type: "ADD_TOAST", toast: { ...props, id, open: true, onOpenChange: (open) => { if (!open) dispatch({ type: "DISMISS_TOAST", toastId: id }); } } });
  return { id, dismiss: () => dispatch({ type: "DISMISS_TOAST", toastId: id }), update: (p: ToasterToast) => dispatch({ type: "UPDATE_TOAST", toast: { ...p, id } }) };
}
function useToast() {
  const [state, setState] = React.useState<State>(memoryState);
  React.useEffect(() => { listeners.push(setState); return () => { const i = listeners.indexOf(setState); if (i > -1) listeners.splice(i, 1); }; }, [state]);
  return { ...state, toast, dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }) };
}
export { useToast, toast };
