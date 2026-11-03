import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { Children, isValidElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
}));
vi.mock("../../hooks/useStableCallback", () => ({
  useStableCallback: (callback: unknown) => callback,
}));
vi.mock("./CustomModelEditor", () => ({ CustomModelEditor: () => null }));
vi.mock("../../modelSelection", () => ({ MAX_CUSTOM_MODEL_LENGTH: 256 }));
vi.mock("@legendapp/list/react", () => ({ LegendList: () => null }));

import { ProviderModelsSection } from "./ProviderModelsSection";

function findAction(node: ReactNode, label: string): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
  if (node.props.children === label) return node.props.onClick;
  for (const child of Children.toArray(node.props.children)) {
    const action = findAction(child, label);
    if (action) return action;
  }
}

it("does not change model visibility without preference write access", () => {
  const changeVisibility = vi.fn();
  const render = (canWritePreferences: boolean) =>
    ProviderModelsSection({
      instanceId: ProviderInstanceId.make("provider"),
      driverKind: ProviderDriverKind.make("codex"),
      models: [{ slug: "model", name: "Model", isCustom: false, capabilities: null }],
      customModels: [],
      canManageCustomModels: false,
      canWritePreferences,
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onChange: vi.fn(),
      onHiddenModelsChange: changeVisibility,
      onFavoriteModelsChange: vi.fn(),
      onToggleFavorite: vi.fn(),
      onModelOrderChange: vi.fn(),
    });
  findAction(render(false), "Disable all")!();
  expect(changeVisibility).not.toHaveBeenCalled();
  findAction(render(true), "Disable all")!();
  expect(changeVisibility).toHaveBeenCalledWith(["model"], ["model"]);
});
