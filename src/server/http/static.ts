// 静态资源：托管仓库 dist/（Vite 构建产物），未命中的路径 SPA fallback 到 index.html。
import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

export interface StaticFileResult {
  status: number;
  body: Buffer;
  contentType: string;
}

interface StaticHandler {
  /** 解析 pathname 对应的响应内容；dist 缺失或文件不存在时回落 index.html / 404。 */
  resolve(pathname: string): StaticFileResult | null;
}

export function createStaticHandler(distDir: string): StaticHandler {
  const distRoot = resolve(distDir);

  const readFileOrNull = (absolutePath: string): Buffer | null => {
    try {
      const stat = statSync(absolutePath);
      return stat.isFile() ? readFileSync(absolutePath) : null;
    } catch {
      return null;
    }
  };

  return {
    resolve(pathname: string): StaticFileResult | null {
      let relative = "";
      try {
        relative = decodeURIComponent(pathname).replace(/^\/+/, "");
      } catch {
        relative = "";
      }
      const absolute = resolve(distRoot, relative);
      // 防路径穿越：解析结果必须仍在 dist 内。
      const insideDist = absolute === distRoot || absolute.startsWith(distRoot + sep);
      const content = insideDist && relative ? readFileOrNull(absolute) : null;
      if (content) {
        return {
          status: 200,
          body: content,
          contentType: MIME_TYPES[extname(absolute).toLowerCase()] ?? "application/octet-stream",
        };
      }
      // SPA fallback：未命中（含目录、缺失、越界路径）一律回落 index.html。
      const index = readFileOrNull(resolve(distRoot, "index.html"));
      if (!index) return null;
      return { status: 200, body: index, contentType: MIME_TYPES[".html"] };
    },
  };
}

export function sendStaticResult(res: ServerResponse, result: StaticFileResult, includeBody: boolean): void {
  res.writeHead(result.status, {
    "content-type": result.contentType,
    "content-length": result.body.length,
    "cache-control": "no-cache",
  });
  res.end(includeBody ? result.body : undefined);
}
