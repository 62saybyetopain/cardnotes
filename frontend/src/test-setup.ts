import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// React Flow 在 jsdom 需要這些瀏覽器 API
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? RO;
(globalThis as any).DOMMatrixReadOnly =
  (globalThis as any).DOMMatrixReadOnly ??
  class {
    m22 = 1;
    constructor(_t?: string) {}
  };
