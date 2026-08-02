import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const LOG = '/tmp/npm-req-dump.log';
const STATE = '/tmp/npm-req-recorder-ok';

const REDACTED = new Set(['authorization', 'proxy-authorization', 'npm-session']);
const SENSITIVE_PATTERNS = [
  /(IAM_TOKEN|ACTIONS_ID_TOKEN_REQUEST_TOKEN|Authorization|Bearer)\s*=?\s*["']?[A-Za-z0-9._~\-\/+=%]{16,}/g,
];

function redact(value) {
  const str = String(value);
  return str.replace(SENSITIVE_PATTERNS, '$1=***');
}

function redactHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = REDACTED.has(key.toLowerCase()) ? '***' : redact(Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

function decodeBody(headers, buf) {
  const encoding = String(headers['content-encoding'] || headers['Content-Encoding'] || '').toLowerCase();
  if (encoding.includes('gzip')) return gunzipSync(buf);
  if (encoding.includes('deflate')) return inflateSync(buf);
  if (encoding.includes('br')) {
    try {
      return brotliDecompressSync(buf);
    } catch {
      return gunzipSync(buf);
    }
  }
  return buf;
}

function line(entry) {
  fs.appendFileSync(LOG, JSON.stringify(entry) + '\n');
}

function patch(mod) {
  const orig = mod.request;
  mod.request = function (...args) {
    const req = orig.apply(this, args);

    const chunks = [];
    const origWrite = req.write.bind(req);
    const origEnd = req.end.bind(req);

    req.write = (data, ...rest) => {
      if (data != null) chunks.push(Buffer.from(data));
      return origWrite(data, ...rest);
    };
    req.end = (data, ...rest) => {
      if (data != null) chunks.push(Buffer.from(data));
      const headers = req.getHeaders ? req.getHeaders() : {};
      const host = headers.host || headers.Host || '';
      req._rpcRecorded = req._rpcRecorded || { chunks: [], headers, path: req.path, method: req.method, host };
      req._rpcRecorded.chunks = chunks.map((b) => b.slice(0));
      const all = Buffer.concat(req._rpcRecorded.chunks);
      line({
        t: new Date().toISOString(),
        kind: 'request',
        method: req.method,
        host,
        url: `https://${host}${req.path || '/'}`,
        headers: redactHeaders(headers),
        body: all.toString('utf8'),
      });
      fs.writeFileSync(STATE, 'recorded');
      return origEnd(data, ...rest);
    };

    req.on('response', (res) => {
      const out = [];
      res.on('data', (d) => out.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(out);
        const body = decodeBody(res.headers, raw).toString('utf8');
        line({
          kind: 'response',
          statusCode: res.statusCode,
          headers: redactHeaders(res.headers),
          body: body.slice(0, 4000),
        });
      });
    });

    return req;
  };
}

patch(http);
patch(https);