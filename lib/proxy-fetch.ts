/**
 * HTTP(S) proxy fetch for the Codex plugin.
 *
 * Why this exists: Alma's host fetch honors the app's proxy settings, but
 * plugin code runs in a context where `globalThis.fetch` does NOT route
 * through the configured proxy. We tunnel manually via HTTP CONNECT.
 *
 * Critical correctness notes for any future editor:
 *   - We MUST send `Connection: close` so the server FINs after the body.
 *   - We MUST honor `Content-Length` / `Transfer-Encoding: chunked` to know
 *     when the body is done. Earlier versions only listened to socket `end`,
 *     which never fired for HTTP/1.1 keep-alive responses and caused the
 *     "loading forever" bug during OAuth token exchange.
 *   - We force `Accept-Encoding: identity` so we never have to gunzip.
 */

interface Logger {
    warn?: (msg: string, err?: unknown) => void;
    info?: (msg: string) => void;
    error?: (msg: string, err?: unknown) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;

let currentProxyUrl: string | null = null;
let originalFetch: typeof globalThis.fetch | null = null;
let pluginLogger: Logger | undefined;

export function setProxyUrl(url: string | null | undefined): void {
    const trimmed = url?.trim();
    currentProxyUrl = trimmed && trimmed.length > 0 ? trimmed : null;
}

export function getProxyUrl(): string | null {
    return currentProxyUrl;
}

export function enableProxyFetch(proxyUrl: string | null | undefined, logger?: Logger): boolean {
    setProxyUrl(proxyUrl);
    pluginLogger = logger;

    if (!originalFetch) {
        originalFetch = globalThis.fetch.bind(globalThis);
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = inputToUrlString(input);
            if (!currentProxyUrl || shouldBypassProxy(url)) {
                return originalFetch!(input, init);
            }
            try {
                return await proxiedFetchWithRedirects(currentProxyUrl, input, init);
            } catch (err) {
                pluginLogger?.warn?.(
                    `Proxied fetch failed for ${url}, falling back to direct: ${err instanceof Error ? err.message : String(err)}`,
                );
                return originalFetch!(input, init);
            }
        }) as typeof globalThis.fetch;
    }

    if (currentProxyUrl) {
        pluginLogger?.info?.(`HTTP proxy enabled for Codex plugin: ${currentProxyUrl}`);
    } else {
        pluginLogger?.info?.('HTTP proxy disabled (no URL); using direct connection.');
    }
    return true;
}

export function disableProxyFetch(): void {
    if (originalFetch) {
        globalThis.fetch = originalFetch;
        originalFetch = null;
    }
    currentProxyUrl = null;
}

/**
 * Direct proxy fetch — bypasses globalThis replacement. Use this from
 * critical code paths (OAuth token exchange, refresh) so we are certain
 * the request goes through the proxy and not whatever fetch is global.
 *
 * If no proxy is configured, falls back to the original fetch.
 */
export async function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = inputToUrlString(input);
    if (!currentProxyUrl || shouldBypassProxy(url)) {
        const f = originalFetch ?? globalThis.fetch.bind(globalThis);
        return f(input, init);
    }
    return proxiedFetchWithRedirects(currentProxyUrl, input, init);
}

/**
 * One round of redirect handling on top of proxiedRequest.
 *
 * Standard Fetch follows 3xx redirects automatically (default `redirect: 'follow'`).
 * Our raw HTTP/1.1 transport doesn't, so wrap it. Without this, GitHub's
 * /releases/latest 302 → /releases/tag/<v> chain breaks getCodexInstructions.
 *
 * Honors `init.redirect`: 'follow' (default), 'manual' (return 3xx as-is),
 * 'error' (throw).
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

async function proxiedFetchWithRedirects(
    proxyUrl: string,
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    const mode: RequestRedirect = (init?.redirect ?? 'follow');
    let currentUrl = inputToUrlString(input);
    let currentInit: RequestInit | undefined = init;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await proxiedRequest(proxyUrl, currentUrl, currentInit);

        if (!REDIRECT_STATUSES.has(response.status)) return response;
        if (mode === 'manual') return response;
        if (mode === 'error') throw new Error(`Unexpected redirect: ${response.status}`);

        const location = response.headers.get('location');
        if (!location) return response;
        if (hop === MAX_REDIRECTS) {
            throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${inputToUrlString(input)}`);
        }

        // Drain the redirect response body to release the socket cleanly.
        try { await response.body?.cancel(); } catch { /* noop */ }

        const nextUrl = new URL(location, currentUrl).toString();
        const method = (currentInit?.method || 'GET').toUpperCase();
        // Per RFC 7231/7538: 301/302/303 may change method to GET and drop body.
        // 307/308 must preserve method and body.
        const preserveMethod = response.status === 307 || response.status === 308;
        if (preserveMethod) {
            currentInit = { ...currentInit, method };
        } else {
            currentInit = { ...currentInit, method: 'GET', body: undefined };
        }
        currentUrl = nextUrl;
    }
    throw new Error('redirect loop'); // unreachable
}

function inputToUrlString(input: RequestInfo | URL): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.toString();
    return (input as Request).url;
}

function shouldBypassProxy(urlStr: string): boolean {
    try {
        const host = new URL(urlStr).hostname.toLowerCase();
        return (
            host === 'localhost' ||
            host === '127.0.0.1' ||
            host === '::1' ||
            host.endsWith('.localhost')
        );
    } catch {
        return false;
    }
}

async function proxiedRequest(
    proxyUrl: string,
    input: RequestInfo | URL,
    init?: RequestInit,
): Promise<Response> {
    // @ts-ignore
    const http = require('http') as typeof import('http');
    // @ts-ignore
    const tls = require('tls') as typeof import('tls');

    const proxy = new URL(proxyUrl);
    const target = new URL(inputToUrlString(input));
    const isHttps = target.protocol === 'https:';
    const targetPort = target.port ? parseInt(target.port, 10) : (isHttps ? 443 : 80);

    const headers = new Headers(init?.headers ?? {});
    if (!headers.has('host')) {
        const defaultPort = isHttps ? 443 : 80;
        headers.set(
            'host',
            targetPort === defaultPort ? target.hostname : `${target.hostname}:${targetPort}`,
        );
    }
    headers.set('connection', 'close');
    if (!headers.has('accept-encoding')) {
        headers.set('accept-encoding', 'identity');
    }

    const method = (init?.method || 'GET').toUpperCase();

    let bodyBuf: Buffer | null = null;
    if (init?.body !== undefined && init?.body !== null) {
        if (typeof init.body === 'string') bodyBuf = Buffer.from(init.body, 'utf-8');
        else if (init.body instanceof Uint8Array) bodyBuf = Buffer.from(init.body);
        else if (init.body instanceof ArrayBuffer) bodyBuf = Buffer.from(new Uint8Array(init.body));
        else bodyBuf = Buffer.from(String(init.body), 'utf-8');
    }

    if (bodyBuf && !headers.has('content-length')) {
        headers.set('content-length', String(bodyBuf.length));
    }

    return new Promise<Response>((resolve, reject) => {
        let resolved = false;
        let bodyClosed = false;
        let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
        let underlyingSocket: { destroy(): void } | null = null;

        let timeoutTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            const err = new Error(`Proxy request timed out after ${REQUEST_TIMEOUT_MS}ms`);
            if (!resolved) {
                resolved = true;
                cleanup();
                reject(err);
            } else if (!bodyClosed) {
                bodyClosed = true;
                try { streamController?.error(err); } catch { /* noop */ }
                cleanup();
            }
        }, REQUEST_TIMEOUT_MS);

        const cleanup = () => {
            if (timeoutTimer) {
                clearTimeout(timeoutTimer);
                timeoutTimer = null;
            }
            try { underlyingSocket?.destroy(); } catch { /* noop */ }
        };

        const failConnect = (err: Error) => {
            if (resolved) return;
            resolved = true;
            cleanup();
            reject(err);
        };

        const closeBody = () => {
            if (bodyClosed) return;
            bodyClosed = true;
            try { streamController?.close(); } catch { /* noop */ }
            cleanup();
        };

        const errorBody = (err: Error) => {
            if (bodyClosed) return;
            bodyClosed = true;
            try { streamController?.error(err); } catch { /* noop */ }
            cleanup();
        };

        const connectHeaders: Record<string, string> = {
            host: `${target.hostname}:${targetPort}`,
        };
        if (proxy.username) {
            const user = decodeURIComponent(proxy.username);
            const pass = decodeURIComponent(proxy.password || '');
            connectHeaders['Proxy-Authorization'] =
                `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
        }

        const connectReq = http.request({
            host: proxy.hostname,
            port: proxy.port ? parseInt(proxy.port, 10) : 80,
            method: 'CONNECT',
            path: `${target.hostname}:${targetPort}`,
            headers: connectHeaders,
            timeout: REQUEST_TIMEOUT_MS,
        });

        connectReq.on('connect', (connectRes, socket) => {
            if (connectRes.statusCode !== 200) {
                socket.destroy();
                failConnect(new Error(
                    `Proxy CONNECT failed: ${connectRes.statusCode} ${connectRes.statusMessage || ''}`,
                ));
                return;
            }
            underlyingSocket = socket;

            const transport: NodeJS.ReadWriteStream = isHttps
                ? tls.connect({ socket, servername: target.hostname, minVersion: 'TLSv1.2' })
                : socket;

            const path = `${target.pathname || '/'}${target.search || ''}`;
            const headerLines: string[] = [`${method} ${path} HTTP/1.1`];
            headers.forEach((value, key) => {
                headerLines.push(`${key}: ${value}`);
            });

            // ===== response parsing state =====
            let buffer = Buffer.alloc(0);
            let headersParsed = false;
            let bodyMode: 'length' | 'chunked' | 'eof' = 'eof';
            let bodyRemaining = 0;
            // chunked-encoding sub-state
            let chunkPhase: 'size' | 'data' | 'crlf-after-data' = 'size';
            let chunkRemaining = 0;

            const bodyStream = new ReadableStream<Uint8Array>({
                start(controller) {
                    streamController = controller;
                },
                cancel() {
                    closeBody();
                },
            });

            const feedChunked = (data: Buffer): void => {
                let cursor = 0;
                while (cursor < data.length && !bodyClosed) {
                    if (chunkPhase === 'size') {
                        buffer = Buffer.concat([buffer, data.slice(cursor)]);
                        cursor = data.length;
                        const idx = buffer.indexOf('\r\n');
                        if (idx === -1) return;
                        const sizeLine = buffer.slice(0, idx).toString('ascii');
                        const semi = sizeLine.indexOf(';');
                        const sizeHex = (semi === -1 ? sizeLine : sizeLine.slice(0, semi)).trim();
                        const size = parseInt(sizeHex, 16);
                        if (isNaN(size) || size < 0) {
                            errorBody(new Error(`Invalid chunk size: ${sizeLine}`));
                            return;
                        }
                        const remaining = buffer.slice(idx + 2);
                        buffer = Buffer.alloc(0);
                        if (size === 0) {
                            // Last chunk; ignore any trailers and end.
                            closeBody();
                            return;
                        }
                        chunkRemaining = size;
                        chunkPhase = 'data';
                        if (remaining.length > 0) {
                            feedChunked(remaining);
                            return;
                        }
                        return;
                    }
                    if (chunkPhase === 'data') {
                        const take = Math.min(chunkRemaining, data.length - cursor);
                        const part = data.slice(cursor, cursor + take);
                        if (part.length > 0 && streamController) {
                            streamController.enqueue(new Uint8Array(part));
                        }
                        cursor += take;
                        chunkRemaining -= take;
                        if (chunkRemaining === 0) {
                            chunkPhase = 'crlf-after-data';
                        }
                        continue;
                    }
                    if (chunkPhase === 'crlf-after-data') {
                        buffer = Buffer.concat([buffer, data.slice(cursor)]);
                        cursor = data.length;
                        if (buffer.length < 2) return;
                        if (buffer[0] !== 0x0d || buffer[1] !== 0x0a) {
                            errorBody(new Error('Malformed chunked encoding (missing CRLF)'));
                            return;
                        }
                        const remaining = buffer.slice(2);
                        buffer = Buffer.alloc(0);
                        chunkPhase = 'size';
                        if (remaining.length > 0) {
                            feedChunked(remaining);
                            return;
                        }
                        return;
                    }
                }
            };

            const feedBody = (data: Buffer): void => {
                if (bodyClosed) return;
                if (bodyMode === 'length') {
                    if (data.length >= bodyRemaining) {
                        const part = data.slice(0, bodyRemaining);
                        if (part.length > 0 && streamController) {
                            streamController.enqueue(new Uint8Array(part));
                        }
                        bodyRemaining = 0;
                        closeBody();
                    } else {
                        if (streamController) {
                            streamController.enqueue(new Uint8Array(data));
                        }
                        bodyRemaining -= data.length;
                    }
                    return;
                }
                if (bodyMode === 'chunked') {
                    feedChunked(data);
                    return;
                }
                if (streamController) {
                    streamController.enqueue(new Uint8Array(data));
                }
            };

            // Fetch spec: Response constructor throws if status is one of the
            // null-body statuses AND body is non-null. We must pass `null` body
            // for these (304 is the most common one — getCodexInstructions's
            // ETag conditional GET hits it routinely).
            const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

            transport.on('data', (chunk: Buffer) => {
                if (bodyClosed) return;
                try {
                    if (!headersParsed) {
                        buffer = Buffer.concat([buffer, chunk]);
                        const sep = buffer.indexOf(Buffer.from('\r\n\r\n', 'ascii'));
                        if (sep === -1) return;
                        headersParsed = true;
                        const headerBlock = buffer.slice(0, sep).toString('utf-8');
                        const initialBody = buffer.slice(sep + 4);
                        buffer = Buffer.alloc(0);

                        let statusCode = 0;
                        let statusText = '';
                        const responseHeaders = new Headers();
                        const lines = headerBlock.split('\r\n');
                        const statusMatch = lines[0]?.match(/^HTTP\/\d\.\d\s+(\d+)\s*(.*)$/);
                        if (statusMatch) {
                            statusCode = parseInt(statusMatch[1], 10);
                            statusText = statusMatch[2] || '';
                        }
                        for (let i = 1; i < lines.length; i++) {
                            const idx = lines[i].indexOf(':');
                            if (idx > 0) {
                                responseHeaders.append(
                                    lines[i].slice(0, idx).trim(),
                                    lines[i].slice(idx + 1).trim(),
                                );
                            }
                        }

                        const te = responseHeaders.get('transfer-encoding');
                        const cl = responseHeaders.get('content-length');
                        if (te && te.toLowerCase().includes('chunked')) {
                            bodyMode = 'chunked';
                            chunkPhase = 'size';
                        } else if (cl !== null) {
                            const n = parseInt(cl, 10);
                            if (!isNaN(n) && n >= 0) {
                                bodyMode = 'length';
                                bodyRemaining = n;
                            }
                        }

                        const nullBody = NULL_BODY_STATUSES.has(statusCode);
                        if (nullBody) {
                            // No body allowed — close the stream we built and
                            // hand a null body to Response.
                            try { streamController?.close(); } catch { /* noop */ }
                            bodyClosed = true;
                        }

                        if (!resolved) {
                            resolved = true;
                            resolve(new Response(nullBody ? null : bodyStream, {
                                status: statusCode,
                                statusText,
                                headers: responseHeaders,
                            }));
                        }

                        if (nullBody) {
                            cleanup();
                            return;
                        }

                        if (bodyMode === 'length' && bodyRemaining === 0) {
                            closeBody();
                            return;
                        }

                        if (initialBody.length > 0) {
                            feedBody(initialBody);
                        }
                        return;
                    }
                    feedBody(chunk);
                } catch (err) {
                    // Never let an exception escape into Node's
                    // uncaughtException — that would crash the plugin host.
                    if (!resolved) failConnect(err as Error);
                    else errorBody(err as Error);
                }
            });

            transport.on('end', () => {
                if (bodyClosed) return;
                if (bodyMode === 'eof') {
                    closeBody();
                } else {
                    errorBody(new Error('Connection closed before response body completed'));
                }
            });

            transport.on('error', (err: Error) => {
                if (!resolved) failConnect(err);
                else errorBody(err);
            });

            socket.on('error', (err: Error) => {
                if (!resolved) failConnect(err);
                else errorBody(err);
            });

            transport.write(headerLines.join('\r\n') + '\r\n\r\n', 'utf-8');
            if (bodyBuf) {
                transport.write(bodyBuf);
            }
        });

        connectReq.on('timeout', () => {
            connectReq.destroy();
            failConnect(new Error('Proxy CONNECT timed out'));
        });

        connectReq.on('error', (err: Error) => {
            failConnect(new Error(`Proxy connection error: ${err.message}`));
        });

        connectReq.end();
    });
}
