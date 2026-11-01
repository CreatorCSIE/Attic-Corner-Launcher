/**
 * fetch 桥（Node16 代宿主缺口补齐）：Electron 22 主进程 = Node 16.17，无全局 fetch
 * （Node 17+/Electron 25+ 才有），而 @attic/runtime 的 fetchImpl 默认引用全局 fetch。
 * 本模块以 electron.net 实现最小 duck-type 面（ok/status/headers.get/text/json/arrayBuffer/
 * body.getReader），在 import 时一次性安装；真实宿主若有全局 fetch（开发机误跑新版
 * Electron）则让位不装。
 *
 * 语义差异：
 *  - 响应体全量缓冲后再交付（无背压流式）；jar/资产级大文件的内存峰值 = 文件本体大小。
 *  - AbortSignal 未接（runtime 网络路径当前不传 signal）。
 */
import { net } from 'electron';

interface MinimalInit {
  method?: string;
  headers?: Record<string, string> | [string, string][];
  body?: string | Uint8Array;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function makeReader(buf: Uint8Array) {
  let offset = 0;
  return {
    read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
      if (offset >= buf.length) return { done: true };
      const chunk = buf.subarray(offset, Math.min(offset + 65536, buf.length));
      offset += chunk.length;
      return { done: false, value: chunk };
    },
    releaseLock: (): void => undefined,
    cancel: async (): Promise<void> => undefined,
  };
}

function netFetch(input: string | URL, init?: MinimalInit): Promise<unknown> {
  const url = typeof input === 'string' ? input : input.toString();
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers;
  if (Array.isArray(rawHeaders)) {
    for (const [k, v] of rawHeaders) headers[k.toLowerCase()] = v;
  } else if (rawHeaders) {
    for (const [k, v] of Object.entries(rawHeaders)) headers[k.toLowerCase()] = v as string;
  }
  return new Promise((resolve, reject) => {
    const request = net.request({ method: init?.method ?? 'GET', url });
    for (const [k, v] of Object.entries(headers)) request.setHeader(k, v);
    request.on('error', (e: Error) => reject(e));
    request.on('response', (response) => {
      const chunks: Uint8Array[] = [];
      const status = response.statusCode;
      const resHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers as Record<string, string | string[]>)) {
        resHeaders[k.toLowerCase()] = Array.isArray(v) ? (v[0] as string) : v;
      }
      response.on('data', (c: Buffer) => chunks.push(new Uint8Array(c)));
      response.on('error', (e: Error) => reject(e));
      response.on('end', () => {
        const buf = concatBytes(chunks);
        const decode = (): string => new TextDecoder('utf-8').decode(buf);
        resolve({
          ok: status >= 200 && status < 300,
          status,
          statusText: '',
          headers: { get: (name: string) => resHeaders[name.toLowerCase()] ?? null },
          text: async () => decode(),
          json: async () => JSON.parse(decode()) as unknown,
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          body: { getReader: () => makeReader(buf) },
        });
      });
    });
    const body = init?.body;
    if (typeof body === 'string') request.write(body);
    else if (body) request.write(Buffer.from(body));
    request.end();
  });
}

const g = globalThis as unknown as { fetch?: unknown };
if (typeof g['fetch'] !== 'function') {
  g['fetch'] = netFetch;
}

export {};
