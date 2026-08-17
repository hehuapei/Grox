export function projectPreviewUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的本机 HTTP 预览地址");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "http:" || !loopback) {
    throw new Error("项目预览仅允许 localhost 或 127.0.0.1 的 HTTP 地址");
  }
  return url.toString();
}
