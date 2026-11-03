import { expect, it, vi } from "vite-plus/test";

const typeset = vi.hoisted(() => vi.fn(() => "<math>x</math>"));
vi.mock("katex", () => ({ default: { renderToString: typeset } }));

import { loadMath } from "./MermaidDiagram";

it("bounds math renders with LRU eviction while caching unsupported expressions", async () => {
  const expression = {
    outerHTML: "<math>x</math>",
    querySelector: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 20 }),
  };
  vi.stubGlobal("document", {
    createElement: () => ({ style: {}, querySelector: () => expression }),
    body: { append: vi.fn() },
  });
  try {
    const math = await loadMath();
    expect(math).not.toBeNull();
    for (let index = 0; index < 128; index++) math!(`x_${index}`, 16);
    math!("x_0", 16);
    expect(typeset).toHaveBeenCalledTimes(128);
    math!("x_128", 16);
    math!("x_0", 16);
    expect(typeset).toHaveBeenCalledTimes(129);
    math!("x_1", 16);
    expect(typeset).toHaveBeenCalledTimes(130);

    typeset.mockImplementationOnce(() => {
      throw new Error("unsupported");
    });
    expect(math!("unsupported", 16)).toBeNull();
    expect(math!("unsupported", 16)).toBeNull();
    expect(typeset).toHaveBeenCalledTimes(131);
    math!("x_0", 20);
    expect(typeset).toHaveBeenCalledTimes(132);
  } finally {
    vi.unstubAllGlobals();
  }
});
