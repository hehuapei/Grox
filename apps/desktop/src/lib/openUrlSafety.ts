/**
 * Dual-gate with Rust `open_external` / `is_blocked_ssrf_host` (R13–R22).
 * Kept free of markdown/mermaid deps so store + UI can share it.
 */

/** Node/Chromium may serialize IPv4-mapped as `::ffff:a9fe:a9fe` (hex). */
function decodeIpv4Mapped(host: string): string | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1];
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const hi = Number.parseInt(hex[1], 16);
  const lo = Number.parseInt(hex[2], 16);
  if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function isBlockedSsrfV4(ip: string): boolean {
  if (ip === "0.0.0.0" || ip === "255.255.255.255") return true;
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return false;
  }
  // 169.254.0.0/16 link-local IMDS
  if (parts[0] === 169 && parts[1] === 254) return true;
  // Aliyun IMDS
  if (parts[0] === 100 && parts[1] === 100 && parts[2] === 100 && parts[3] === 200) {
    return true;
  }
  return false;
}

function isLoopbackV4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  return parts[0] === 127;
}

export function isSafeMarkdownOpenUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  // R22: strip brackets + trailing-dot FQDN so denylist matches Rust.
  let host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  while (host.endsWith(".")) host = host.slice(0, -1);
  if (!host) return false;

  const mappedV4 = decodeIpv4Mapped(host);
  const v4 = mappedV4 ?? (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ? host : null);

  if (v4 && isBlockedSsrfV4(v4)) return false;
  if (host.startsWith("fe80:")) return false;

  if (
    host === "metadata"
    || host === "metadata.google.internal"
    || host.endsWith(".metadata.google.internal")
    || host === "instance-data"
    || host === "instance-data.ec2.internal"
    || (host.endsWith(".ec2.internal") && host.includes("instance-data"))
    || host === "kubernetes.default"
    || host === "kubernetes.default.svc"
    || host.endsWith(".kubernetes.default.svc")
    || host === "metadata.azure.com"
    || host.endsWith(".metadata.azure.com")
  ) {
    return false;
  }

  const loopback =
    host === "localhost"
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || (v4 != null && isLoopbackV4(v4));
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && loopback) return true;
  return false;
}
