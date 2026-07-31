'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const HOST = '127.0.0.1';
const PORT = Math.max(1, Math.min(65535,
    Number(process.env.EMBY_MULTIWINDOW_DIAGNOSTICS_PORT) || 47831));
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 25 * 1024 * 1024;
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
const LOG_FILE = process.env.EMBY_MULTIWINDOW_DIAGNOSTICS_LOG ||
    path.join(LOG_DIR, 'emby-multiwindow-diagnostics.jsonl');
const PREVIOUS_LOG_FILE = LOG_FILE.replace(/(\.jsonl)?$/i, '.previous.jsonl');

fs.mkdirSync(path.dirname(LOG_FILE), {recursive: true});

function logSize() {
    try {
        return fs.statSync(LOG_FILE).size;
    } catch (error) {
        return 0;
    }
}

function rotateLog(incomingBytes) {
    if (logSize() + incomingBytes <= MAX_LOG_BYTES) {
        return;
    }
    try {
        fs.rmSync(PREVIOUS_LOG_FILE, {force: true});
        fs.renameSync(LOG_FILE, PREVIOUS_LOG_FILE);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw error;
        }
    }
}

function redactString(value) {
    return value
        .replace(
            /((?:api_key|x-emby-token|access_token|token|authorization|auth)=)[^&\s]+/ig,
            '$1[redacted]'
        )
        .replace(
            /("(?:api_key|x-emby-token|access_token|token|authorization|cookie)"\s*:\s*")[^"]*/ig,
            '$1[redacted]'
        );
}

function sanitize(value, key, depth) {
    if (depth > 12) {
        return '[depth-limit]';
    }
    if (/^(?:api_key|x-emby-token|access_token|token|authorization|cookie)$/i
        .test(String(key || ''))) {
        return '[redacted]';
    }
    if (typeof value === 'string') {
        return redactString(value).slice(0, 12000);
    }
    if (Array.isArray(value)) {
        return value.slice(0, 250).map((item) =>
            sanitize(item, '', depth + 1));
    }
    if (value && typeof value === 'object') {
        const clean = {};
        Object.keys(value).slice(0, 250).forEach((name) => {
            clean[name] = sanitize(value[name], name, depth + 1);
        });
        return clean;
    }
    return value;
}

function appendEvents(events) {
    const receivedAt = new Date().toISOString();
    const lines = events.slice(0, 200).map((event) => JSON.stringify({
        collectorReceivedAt: receivedAt,
        ...sanitize(event, '', 0)
    })).join('\n') + '\n';
    const bytes = Buffer.byteLength(lines);
    rotateLog(bytes);
    fs.appendFileSync(LOG_FILE, lines, 'utf8');
}

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8'
    });
    response.end(JSON.stringify(payload));
}

const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
    }
    if (request.method === 'GET' && request.url === '/health') {
        sendJson(response, 200, {
            ok: true,
            host: HOST,
            port: PORT,
            logFile: LOG_FILE,
            bytes: logSize()
        });
        return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/logs') {
        sendJson(response, 404, {ok: false, error: 'Not found'});
        return;
    }

    const chunks = [];
    let receivedBytes = 0;
    request.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > MAX_BODY_BYTES) {
            request.destroy();
            return;
        }
        chunks.push(chunk);
    });
    request.on('end', () => {
        if (receivedBytes > MAX_BODY_BYTES) {
            sendJson(response, 413, {ok: false, error: 'Payload too large'});
            return;
        }
        try {
            const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const events = Array.isArray(payload) ? payload : [payload];
            appendEvents(events);
            sendJson(response, 200, {ok: true, accepted: Math.min(200, events.length)});
        } catch (error) {
            sendJson(response, 400, {ok: false, error: error.message});
        }
    });
});

server.listen(PORT, HOST, () => {
    appendEvents([{
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'collector-start',
        data: {
            pid: process.pid,
            host: HOST,
            port: PORT,
            logFile: LOG_FILE
        }
    }]);
    console.log('Emby Multi Window diagnostics collector is running.');
    console.log(`HEALTH=http://${HOST}:${PORT}/health`);
    console.log(`LOG_FILE=${LOG_FILE}`);
});

function shutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
