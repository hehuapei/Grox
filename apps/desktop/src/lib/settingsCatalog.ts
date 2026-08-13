export const SETTINGS_SECTION_IDS = [
  "general",
  "account",
  "archives",
  "appearance",
  "mcp",
  "skills",
  "plugins",
  "hooks",
] as const;

export type SettingsSection = typeof SETTINGS_SECTION_IDS[number];

export interface SettingsSearchEntry {
  id: string;
  section: SettingsSection;
  label: string;
  description: string;
  keywords: string[];
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && SETTINGS_SECTION_IDS.includes(value as SettingsSection);
}

export function settingsSectionFromHash(hash: string): SettingsSection | null {
  const match = hash.match(/^#\/settings\/([^/?#]+)/);
  return match && isSettingsSection(match[1]) ? match[1] : null;
}

export function settingsHash(section: SettingsSection): string {
  return `#/settings/${section}`;
}

export function getSettingsCatalog(zh: boolean): SettingsSearchEntry[] {
  return [
    { id: "runtime", section: "general", label: zh ? "Grok Build 运行时" : "Grok Build runtime", description: zh ? "检测、安装或更新官方 CLI" : "Detect, install, or update the official CLI", keywords: ["cli", "runtime", "运行时", "安装", "更新"] },
    { id: "execution", section: "general", label: zh ? "执行策略" : "Execution defaults", description: zh ? "推理强度、权限、Computer Use 与通知" : "Effort, permissions, Computer Use, and notifications", keywords: ["effort", "permission", "权限", "通知", "browser"] },
    { id: "provider", section: "account", label: zh ? "账户与服务" : "Account and providers", description: zh ? "OAuth、官方 API 与兼容服务" : "OAuth, official API, and compatible providers", keywords: ["oauth", "api", "key", "base url", "账户", "登录", "供应商"] },
    { id: "models", section: "account", label: zh ? "模型" : "Models", description: zh ? "发现模型并选择默认模型" : "Discover models and choose a default", keywords: ["model", "模型", "grok"] },
    { id: "archives", section: "archives", label: zh ? "归档会话" : "Archived conversations", description: zh ? "恢复或永久删除已归档会话" : "Restore or permanently delete archived conversations", keywords: ["archive", "delete", "归档", "删除", "恢复"] },
    { id: "theme", section: "appearance", label: zh ? "主题与语言" : "Theme and language", description: zh ? "深浅主题、界面语言与内容密度" : "Theme, language, and content density", keywords: ["theme", "language", "主题", "语言", "密度"] },
    { id: "type", section: "appearance", label: zh ? "阅读排版" : "Reading typography", description: zh ? "字号、字重与阅读宽度" : "Font size, weight, and reading width", keywords: ["font", "字体", "字号", "字重", "宽度"] },
    { id: "mcp", section: "mcp", label: "MCP", description: zh ? "配置和管理工具服务器" : "Configure and manage tool servers", keywords: ["server", "tools", "服务器", "工具"] },
    { id: "skills", section: "skills", label: zh ? "技能" : "Skills", description: zh ? "查看、启用和管理本机技能" : "View, enable, and manage local skills", keywords: ["skill", "skills", "技能"] },
    { id: "plugins", section: "plugins", label: zh ? "插件与市场" : "Plugins and marketplace", description: zh ? "安装和管理扩展插件" : "Install and manage extensions", keywords: ["plugin", "marketplace", "插件", "市场", "扩展"] },
    { id: "hooks", section: "hooks", label: "Hooks", description: zh ? "管理任务生命周期钩子" : "Manage task lifecycle hooks", keywords: ["hook", "lifecycle", "生命周期", "钩子"] },
  ];
}

export function searchSettings(entries: SettingsSearchEntry[], query: string): SettingsSearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return entries.filter((entry) => {
    const haystack = [entry.label, entry.description, ...entry.keywords].join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
