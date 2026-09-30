import { Actor, log } from 'apify';
import { promises as dns } from 'node:dns';
import { backoffMs, buildRdapUrl, emptyRow, fallbackUrl, normalizeDomain, parseBootstrap, parseRdap, parseRetryAfter, spfFrom } from './lib.js';

const EVENT = 'domain';
const UA = 'bulk-rdap-whois-lookup/1.0 (Apify actor; AI-operated; +https://apify.com/mmaker-bot)';
const BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
const PER_HOST = 2;
const MAX_TRIES = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class HostLimiter {
    constructor(limit) { this.limit = limit; this.active = new Map(); this.waiters = new Map(); }
    async run(host, fn) {
        while ((this.active.get(host) ?? 0) >= this.limit) {
            await new Promise((res) => { const q = this.waiters.get(host) ?? []; q.push(res); this.waiters.set(host, q); });
        }
        this.active.set(host, (this.active.get(host) ?? 0) + 1);
        try { return await fn(); } finally {
            this.active.set(host, this.active.get(host) - 1);
            this.waiters.get(host)?.shift()?.();
        }
    }
}
const limiter = new HostLimiter(PER_HOST);

async function fetchJson(url, timeoutMs) {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await limiter.run(host, async () => {
                const r = await fetch(url, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
                const text = await r.text();
                return { status: r.status, retryAfter: r.headers.get('retry-after'), text };
            });
        } catch (err) {
            if (attempt < 1) { await sleep(1000); continue; }
            throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : (err.cause?.code || err.message));
        }
        if ((res.status === 429 || res.status === 503) && attempt < MAX_TRIES - 1) {
            await sleep(backoffMs(attempt, parseRetryAfter(res.retryAfter)));
            continue;
        }
        return res;
    }
}

let bootstrapMap = null;
async function getBootstrap(url, timeoutMs) {
    if (bootstrapMap) return bootstrapMap;
    try {
        const res = await fetchJson(url, timeoutMs);
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        bootstrapMap = parseBootstrap(JSON.parse(res.text));
        log.info(`RDAP bootstrap loaded: ${bootstrapMap.size} TLDs`);
    } catch (err) {
        log.warning(`Could not load RDAP bootstrap (${err.message}); using rdap.org for every domain.`);
        bootstrapMap = new Map();
    }
    return bootstrapMap;
}

async function resolveDns(domain, timeoutMs) {
    const resolver = new dns.Resolver({ timeout: Math.min(timeoutMs, 5000), tries: 2 });
    const q = async (fn) => { try { return await fn(); } catch { return []; } };
    const [a, aaaa, mx, ns, txt] = await Promise.all([
        q(() => resolver.resolve4(domain)),
        q(() => resolver.resolve6(domain)),
        q(() => resolver.resolveMx(domain)),
        q(() => resolver.resolveNs(domain)),
        q(() => resolver.resolveTxt(domain)),
    ]);
    return {
        a, aaaa,
        mx: mx.sort((x, y) => x.priority - y.priority).map((m) => ({ priority: m.priority, exchange: m.exchange.toLowerCase() })),
        ns: ns.map((n) => n.toLowerCase()).sort(),
        spf: spfFrom(txt),
    };
}

async function lookup(input, info, opts) {
    const row = emptyRow(input, info);
    const base = opts.bootstrap.get(info.tld);
    const urls = [base ? buildRdapUrl(base, info.domain) : fallbackUrl(info.domain)];
    if (base) urls.push(fallbackUrl(info.domain));
    let charged = false;
    let lastErr = null;
    for (const url of urls) {
        try {
            const res = await fetchJson(url, opts.timeoutMs);
            row.rdapUrl = url;
            row.rdapServer = new URL(url).origin + '/';
            if (res.status === 404) { row.registered = false; charged = true; lastErr = null; break; }
            if (res.status === 200) {
                const json = JSON.parse(res.text);
                Object.assign(row, parseRdap(json), { registered: true });
                charged = true; lastErr = null; break;
            }
            lastErr = res.status === 429 ? 'rate_limited' : `rdap_http_${res.status}`;
        } catch (err) {
            lastErr = err.message;
            row.rdapUrl = url;
        }
    }
    row.error = lastErr;
    if (opts.includeDns) row.dns = await resolveDns(info.domain, opts.timeoutMs).catch(() => null);
    return { row, charged };
}

await Actor.init();
const input = (await Actor.getInput()) || {};
const raw = [...(input.domains || []).map((d) => (typeof d === 'string' ? d : d?.url))];
if (typeof input.domainsText === 'string') raw.push(...input.domainsText.split(/[\s,]+/));
const seen = new Set();
const items = [];
let invalid = 0;
for (const r of raw) {
    if (!String(r ?? '').trim()) continue;
    const info = normalizeDomain(r);
    if (!info) { invalid++; log.warning(`Skipping invalid domain: ${r}`); continue; }
    if (!seen.has(info.domain)) { seen.add(info.domain); items.push({ input: String(r).trim(), info }); }
}
if (!items.length) throw new Error('Give at least one domain in "domains".');
const timeoutMs = Math.min(Math.max(Number(input.timeoutSecs) || 15, 3), 60) * 1000;
const concurrency = Math.min(Math.max(Number(input.concurrency) || 5, 1), 20);
const bootstrapUrl = input.bootstrapUrl || process.env.RDAP_BOOTSTRAP_URL || BOOTSTRAP;
const opts = { timeoutMs, includeDns: input.includeDns !== false, bootstrap: await getBootstrap(bootstrapUrl, timeoutMs) };
log.info(`${items.length} unique domains (${invalid} invalid skipped), concurrency ${concurrency}`);

let next = 0, done = 0, ok = 0, failed = 0, notRegistered = 0, limitReached = false;
async function worker() {
    while (next < items.length && !limitReached) {
        const it = items[next++];
        const { row, charged } = await lookup(it.input, it.info, opts);
        if (charged) {
            ok++;
            if (row.registered === false) notRegistered++;
            const c = await Actor.pushData(row, EVENT);
            if (c?.eventChargeLimitReached) limitReached = true;
        } else {
            failed++;
            if (input.includeFailed !== false) await Actor.pushData(row);
        }
        if (++done % 50 === 0) await Actor.setStatusMessage(`Looked up ${done}/${items.length}`);
    }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await Actor.setValue('SUMMARY', { looked_up: done, answered: ok, notRegistered, failedNoAnswer: failed, invalidSkipped: invalid, stoppedAtChargeLimit: limitReached });
if (limitReached) log.info('Stopped at the maximum charge set for this run.');
await Actor.setStatusMessage(`Finished: ${ok} answered (${notRegistered} not registered), ${failed} failed (not charged)`, { isStatusMessageTerminal: true });
await Actor.exit();
