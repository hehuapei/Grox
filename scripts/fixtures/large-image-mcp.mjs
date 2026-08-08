import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";

const lines = createInterface({ input: process.stdin });

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function createLargePng() {
  const width = 768;
  const height = 768;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height);
  let random = 0x6d2b79f5;

  for (let y = 0; y < height; y += 1) {
    pixels[y * stride] = 0;
    for (let offset = 1; offset < stride; offset += 1) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      pixels[y * stride + offset] = random & 0xff;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(pixels, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const imageData = createLargePng().toString("base64");

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "grox-large-image-fixture", version: "1.0.0" },
    });
  } else if (message.method === "tools/list") {
    respond(message.id, {
      tools: [{
        name: "large_image",
        description: "Return the deterministic large image used by Grox integration verification.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
  } else if (message.method === "tools/call") {
    respond(message.id, {
      content: [
        { type: "image", data: imageData, mimeType: "image/png" },
        { type: "text", text: "GROX_LARGE_IMAGE_OK" },
      ],
      isError: false,
    });
  } else if (message.method === "ping") {
    respond(message.id, {});
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })}\n`);
  }
});
