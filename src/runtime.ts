import {
  createPluginRuntimeStore,
  type PluginRuntime,
} from "openclaw/plugin-sdk/runtime-store";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "gmail",
  errorMessage: "Gmail runtime is not initialized",
});

export const setGmailRuntime = runtimeStore.setRuntime;
export const getGmailRuntime = runtimeStore.getRuntime;
