import React, { Component, ReactNode, ErrorInfo } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center p-8 bg-black/50 border border-rose-500/30 rounded text-rose-400 font-mono text-[11px] gap-3">
          <AlertCircle className="w-5 h-5 text-rose-500 shrink-0" />
          <div className="flex flex-col">
             <strong className="text-white text-xs mb-1">Dashboard Render Error</strong>
             <span>{this.state.error?.message || "An unknown error crashed the UI component."}</span>
          </div>
        </div>
      );
    }

    return (this as any).props.children;
  }
}
