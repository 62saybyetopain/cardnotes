import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("元件渲染失敗", error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
