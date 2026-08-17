import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { useDesktop } from "../../state/store";
import { AccountSetup } from "./AccountSetup";
import { SettingsModal } from "./SettingsModal";

const initialState = useDesktop.getState();

afterEach(() => {
  useDesktop.setState(initialState, true);
  window.location.hash = "#/";
  document.body.replaceChildren();
});

const render = async (node: React.ReactNode) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container, root };
};

const officialButton = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>("button")]
  .find((button) => {
    const label = button.textContent?.trim().toLocaleLowerCase() ?? "";
    return (label.includes("官方 api") || label.includes("official api") || label.includes("xai api"))
      && !label.includes("compatible")
      && !label.includes("兼容");
  });

describe("provider credentials", () => {
  it("首次账户设置中的 API Key 默认隐藏", async () => {
    useDesktop.setState({
      accountSetupOpen: true,
      runtime: null,
      auth: { required: true, inProgress: false },
    });
    const { container, root } = await render(<AccountSetup />);

    await act(async () => {
      officialButton(container)?.click();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLInputElement>('input[placeholder="xai-…"]')?.type).toBe("password");
    await act(async () => root.unmount());
  });

  it("设置页新建 API 服务时 API Key 默认隐藏", async () => {
    window.location.hash = "#/settings/account";
    useDesktop.setState({
      settingsOpen: true,
      provider: { kind: "oauth", hasApiKey: false, secretBackend: "missing" },
      account: { authenticated: false },
    });
    const { container, root } = await render(<SettingsModal />);

    await act(async () => {
      officialButton(container)?.click();
      await Promise.resolve();
    });

    expect(container.querySelector<HTMLInputElement>('input[placeholder="xai-…"]')?.type).toBe("password");
    await act(async () => root.unmount());
  });
});
