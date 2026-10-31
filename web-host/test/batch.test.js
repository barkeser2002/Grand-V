// Slice 5: /data/batch wire protocol (as implemented by server.rs), and the bounded /log sink.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { startApp, rawRequest } from './helpers.js';

const post = (origin, p, body, headers = {}) =>
  rawRequest(origin, {
    method: 'POST',
    path: p,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
    body,
  });

describe('data batch: exact server.rs wire format', () => {
  let h;
  const logs = [];
  before(async () => {
    h = await startApp({ log: (l) => logs.push(String(l)) });
  });
  after(() => h.close());

  test('gz=1: concatenated runs are gzip-compressed; X-Run-Lengths lists raw lengths', async () => {
    const res = await post(h.origin, '/data/batch?gz=1', JSON.stringify([['test.bin', 1, 2], ['test.bin', 7, 20]]));
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(res.headers['x-run-lengths'], '2,3');
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(res.headers['content-length'], String(res.body.length));
    assert.equal(gunzipSync(res.body).toString(), '12789');
  });

  test('without gz: the raw concatenation with no Content-Encoding', async () => {
    const res = await post(h.origin, '/data/batch', JSON.stringify([['test.bin', 1, 2], ['test.bin', 7, 20]]));
    assert.equal(res.status, 200);
    assert.equal(res.body.toString(), '12789');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['content-length'], '5');
    assert.equal(res.headers['x-run-lengths'], '2,3');
  });

  test('a run starting past EOF contributes length 0; an empty list gives an empty body', async () => {
    const past = await post(h.origin, '/data/batch', JSON.stringify([['test.bin', 20, 30]]));
    assert.equal(past.status, 200);
    assert.equal(past.headers['x-run-lengths'], '0');
    assert.equal(past.body.length, 0);
    const none = await post(h.origin, '/data/batch', '[]');
    assert.equal(none.status, 200);
    assert.equal(none.body.length, 0);
  });

  test('random ranges over a real binary file reproduce the exact bytes on disk', async () => {
    const { readFileSync } = await import('node:fs');
    const data = Buffer.alloc(300_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
    writeFileSync(path.join(h.fixture.root, 'data', 'blob.bin'), data);
    const runs = [
      ['blob.bin', 0, 99],
      ['blob.bin', 123_456, 130_000],
      ['blob.bin', 299_990, 400_000],
      ['test.bin', 0, 0],
    ];
    const expected = Buffer.concat([
      data.subarray(0, 100),
      data.subarray(123_456, 130_001),
      data.subarray(299_990, 300_000),
      readFileSync(path.join(h.fixture.root, 'data', 'test.bin')).subarray(0, 1),
    ]);
    const plain = await post(h.origin, '/data/batch', JSON.stringify(runs));
    assert.equal(Buffer.compare(plain.body, expected), 0, 'raw batch matches');
    assert.equal(plain.headers['x-run-lengths'], '100,6545,10,1');
    const zipped = await post(h.origin, '/data/batch?gz=1', JSON.stringify(runs));
    assert.equal(Buffer.compare(gunzipSync(zipped.body), expected), 0, 'gzip batch matches');
  });

  test('names that escape the data root or hit symlinks outside it are 400', async () => {
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(h.fixture.parent, 'secret.txt'), path.join(h.fixture.root, 'data', 'escape-link.bin'));
    for (const name of ['../secret.txt', '..\\secret.txt', '/etc/passwd', 'escape-link.bin', 'sub/../../secret.txt']) {
      const res = await post(h.origin, '/data/batch', JSON.stringify([[name, 0, 10]]));
      assert.equal(res.status, 400, name);
      assert.ok(!res.body.toString().includes('OUTSIDE-SECRET'));
    }
  });

  test('dotfiles and missing files are 400', async () => {
    assert.equal((await post(h.origin, '/data/batch', JSON.stringify([['.hidden', 0, 1]]))).status, 400);
    assert.equal((await post(h.origin, '/data/batch', JSON.stringify([['missing.bin', 0, 1]]))).status, 400);
  });

  test('a symlink that stays inside the data root is allowed', async () => {
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(h.fixture.root, 'data', 'test.bin'), path.join(h.fixture.root, 'data', 'inside-link.bin'));
    const res = await post(h.origin, '/data/batch', JSON.stringify([['inside-link.bin', 0, 1]]));
    assert.equal(res.status, 200, res.body.toString());
    assert.equal(res.body.toString(), '01');
  });


  test('malformed batch bodies are 400: non-array, bad tuples, end before start, too many runs, bad JSON', async () => {
    const bodies = [
      '{"a":1}',
      '[["test.bin",1]]',
      '[["test.bin","1",2]]',
      '[["test.bin",5,2]]',
      '[[1,0,1]]',
      '[',
      JSON.stringify(Array.from({ length: 1001 }, () => ['test.bin', 0, 1])),
    ];
    for (const body of bodies) {
      const res = await post(h.origin, '/data/batch', body);
      assert.equal(res.status, 400, body.slice(0, 40));
    }
  });

  test('a body over 1 MiB is refused with 413', async () => {
    const big = JSON.stringify([['test.bin', 0, 1]]).replace(']', `,"${'x'.repeat(1_100_000)}"]`);
    const res = await post(h.origin, '/data/batch', big);
    assert.equal(res.status, 413);
  });

  test('a batch totalling more than 64 MiB is refused before any bytes are read', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 1);
    writeFileSync(path.join(h.fixture.root, 'data', 'eight.bin'), big);
    const runs = Array.from({ length: 9 }, () => ['eight.bin', 0, 8 * 1024 * 1024 - 1]);
    const res = await post(h.origin, '/data/batch', JSON.stringify(runs));
    assert.equal(res.status, 400);
    assert.match(res.body.toString(), /64 MiB/);
  });

  test('GET /data/batch is not a batch request (404)', async () => {
    assert.equal((await rawRequest(h.origin, { method: 'GET', path: '/data/batch' })).status, 404);
  });
});

describe('/log sink: bounded and redacted', () => {
  let h;
  const logs = [];
  before(async () => {
    h = await startApp({ log: (l) => logs.push(String(l)) });
  });
  after(() => h.close());

  test('POST /log accepts text, answers 204 and records it', async () => {
    const res = await rawRequest(h.origin, {
      method: 'POST',
      path: '/log',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength('hello game') },
      body: 'hello game',
    });
    assert.equal(res.status, 204);
    assert.ok(logs.some((l) => l.includes('hello game')));
  });

  test('credential-looking values in client logs are redacted before they reach the log', async () => {
    const line = 'join failed key=SuperSecretValue123 credential: abcdef-VERYSECRET';
    await rawRequest(h.origin, {
      method: 'POST',
      path: '/log',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(line) },
      body: line,
    });
    const all = logs.join('\n');
    assert.ok(!all.includes('SuperSecretValue123'));
    assert.ok(!all.includes('VERYSECRET'));
    assert.ok(all.includes('[redacted]'));
  });

  test('bodies over 16 KiB are refused with 413', async () => {
    const body = 'x'.repeat(20_000);
    const res = await rawRequest(h.origin, {
      method: 'POST',
      path: '/log',
      headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    assert.equal(res.status, 413);
  });

  test('GET /log is not an accepted route', async () => {
    assert.equal((await rawRequest(h.origin, { method: 'GET', path: '/log' })).status, 404);
  });
});
