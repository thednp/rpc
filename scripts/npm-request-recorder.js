import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const LOG = '/tmp/npm-req-dump.log';
const STATE = '/tmp/npm-req-recorder-ok';

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
        headers,
        body: all.toString('utf8'),
      });
      fs.writeFileSync(STATE, 'recorded');
      return origEnd(data, ...rest);
    };

    req.on('response', (res) => {
      const out = [];
      res.on('data', (d) => out.push(d));
      res.on('end', () => {
        line({
          kind: 'response',
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(out).toString('utf8').slice(0, 4000),
        });
      });
    });

    return req;
  };
}

patch(http);
patch(https);