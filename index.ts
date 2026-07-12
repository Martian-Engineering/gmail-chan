import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { gmailPlugin } from "./src/channel.js";

export default defineChannelPluginEntry({
  id: "gmail",
  name: "Gmail",
  description: "OpenClaw communication channel backed by Gmail threads",
  plugin: gmailPlugin,
});
