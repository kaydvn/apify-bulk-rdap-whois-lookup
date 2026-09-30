import { domainToASCII } from 'node:url';

// Multi-part public suffixes (small bundled list; not the full PSL).
export const MULTI_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'sch.uk',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
    'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
    'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
    'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'gov.in',
    'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
    'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
    'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.hk', 'org.hk', 'edu.hk', 'gov.hk',
    'com.tw', 'org.tw', 'net.tw', 'gov.tw',
    'com.sg', 'org.sg', 'edu.sg', 'gov.sg',
    'com.my', 'org.my', 'net.my', 'gov.my',
    'com.ph', 'org.ph', 'net.ph', 'com.vn', 'net.vn', 'org.vn', 'com.pk', 'com.bd', 'com.np', 'com.lk',
    'co.id', 'or.id', 'web.id', 'go.id', 'co.th', 'in.th', 'or.th', 'ac.th', 'go.th',
    'com.tr', 'org.tr', 'net.tr', 'gov.tr', 'com.ua', 'org.ua', 'co.il', 'org.il', 'ac.il',
    'com.sa', 'com.eg', 'com.ng', 'co.ke', 'or.ke', 'co.tz', 'co.ug', 'co.zw', 'co.ma',
    'com.pl', 'net.pl', 'org.pl', 'com.pt', 'com.es', 'org.es', 'com.gr', 'com.ro', 'com.ru', 'com.de',
    'co.at', 'or.at', 'co.hu', 'com.cy', 'com.mt',
]);

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Reduce a domain, URL or email to its registrable domain. Returns { domain, tld } or null. */
export function normalizeDomain(raw) {
    let s = String(raw ?? '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.replace(/^[^/@?#]*@/, ''); // user@ or email local part
    s = s.split(/[/?#]/)[0];
    s = s.replace(/:\d+$/, '').replace(/^\*\./, '').replace(/\.+$/, '');
    if (!s) return null;
    const ascii = domainToASCII(s);
    if (!ascii || !HOST_RE.test(ascii)) return null;
    const labels = ascii.split('.');
    if (labels.length < 2) return null;
    let take = 2;
    if (labels.length >= 3 && MULTI_SUFFIXES.has(labels.slice(-2).join('.'))) take = 3;
    if (labels.length < take) return null;
    const tld = labels[labels.length - 1];
    if (!/^([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return null;
    return { domain: labels.slice(-take).join('.'), tld };
}

/** Parse the IANA dns.json bootstrap into Map<tld, baseUrl (with trailing slash)>. */
export function parseBootstrap(json) {
    const map = new Map();
    for (const svc of json?.services ?? []) {
        const [tlds, urls] = svc ?? [];
        if (!Array.isArray(tlds) || !Array.isArray(urls) || !urls.length) continue;
        const base = urls.find((u) => /^https:/i.test(u)) ?? urls[0];
        const norm = base.endsWith('/') ? base : `${base}/`;
        for (const t of tlds) map.set(String(t).toLowerCase(), norm);
    }
    return map;
}

export function buildRdapUrl(base, domain) {
    return `${base.endsWith('/') ? base : `${base}/`}domain/${domain}`;
}

export function fallbackUrl(domain) {
    return `https://rdap.org/domain/${domain}`;
}

/** Retry-After header (seconds or HTTP date) to milliseconds; null when unusable. */
export function parseRetryAfter(value, now = Date.now()) {
    if (value == null || value === '') return null;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return Math.round(n * 1000);
    const d = Date.parse(value);
    return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

export function backoffMs(attempt, retryAfterMs) {
    const exp = Math.min(30000, 1000 * 2 ** attempt);
    return Math.min(60000, Math.max(exp, retryAfterMs ?? 0));
}

function vcardValue(vcard, key) {
    const arr = Array.isArray(vcard) ? vcard[1] : null;
    if (!Array.isArray(arr)) return null;
    const row = arr.find((r) => Array.isArray(r) && r[0] === key);
    return row ? row[3] : null;
}

export function vcardInfo(entity) {
    const v = entity?.vcardArray;
    const fn = vcardValue(v, 'fn');
    const org = vcardValue(v, 'org');
    const email = vcardValue(v, 'email');
    const adr = vcardValue(v, 'adr');
    const url = vcardValue(v, 'url');
    const str = (x) => (typeof x === 'string' && x.trim() ? x.trim() : Array.isArray(x) ? x.filter((p) => typeof p === 'string' && p.trim()).join(' ').trim() || null : null);
    const country = Array.isArray(adr) ? adr[6] : null;
    const label = entity?.vcardArray?.[1]?.find?.((r) => r[0] === 'adr')?.[1]?.cc;
    return {
        fn: str(fn),
        org: str(org),
        email: str(email),
        url: str(url),
        country: (typeof country === 'string' && country.trim()) || (typeof label === 'string' && label.trim()) || null,
    };
}

function walkEntities(list, out = []) {
    for (const e of list ?? []) {
        out.push(e);
        if (e?.entities) walkEntities(e.entities, out);
    }
    return out;
}

const hasRole = (e, role) => (e?.roles ?? []).map((r) => String(r).toLowerCase()).includes(role);
const REDACTED = /redacted|not disclosed|withheld|privacy|data protected|gdpr/i;
const clean = (s) => (s && !REDACTED.test(s) ? s : null);

export function daysBetween(fromIso, toMs) {
    const t = Date.parse(fromIso);
    if (!Number.isFinite(t)) return null;
    return Math.floor((t - toMs) / 86400000);
}

/** Extract normalised fields from an RDAP domain object (RFC 9083). */
export function parseRdap(json, now = Date.now()) {
    const events = {};
    for (const ev of json?.events ?? []) {
        const a = String(ev?.eventAction ?? '').toLowerCase();
        if (ev?.eventDate && !(a in events)) events[a] = ev.eventDate;
    }
    const creationDate = events.registration ?? null;
    const expirationDate = events.expiration ?? null;
    const lastChangedDate = events['last changed'] ?? null;
    const all = walkEntities(json?.entities);
    const registrar = all.find((e) => hasRole(e, 'registrar'));
    const rInfo = vcardInfo(registrar);
    const ianaId = (registrar?.publicIds ?? []).find((p) => /iana/i.test(p?.type ?? ''))?.identifier ?? null;
    const abuseEnt = all.find((e) => hasRole(e, 'abuse'));
    const abuseEmail = vcardInfo(abuseEnt).email;
    const registrant = all.find((e) => hasRole(e, 'registrant'));
    const regInfo = vcardInfo(registrant);
    const registrarUrl = rInfo.url ?? (registrar?.links ?? []).find((l) => l?.rel === 'about' || l?.rel === 'self')?.href ?? null;
    const nameservers = [...new Set((json?.nameservers ?? []).map((n) => String(n?.ldhName ?? '').toLowerCase()).filter(Boolean))].sort();
    const statuses = [...new Set((json?.status ?? []).map(String))];
    const ds = json?.secureDNS?.delegationSigned;
    return {
        registrar: rInfo.fn ?? rInfo.org ?? null,
        registrarIanaId: ianaId != null ? String(ianaId) : null,
        registrarUrl,
        abuseEmail,
        creationDate,
        expirationDate,
        lastChangedDate,
        daysUntilExpiry: expirationDate ? daysBetween(expirationDate, now) : null,
        domainAgeDays: creationDate && Number.isFinite(Date.parse(creationDate)) ? Math.floor((now - Date.parse(creationDate)) / 86400000) : null,
        statuses,
        nameservers,
        dnssec: typeof ds === 'boolean' ? ds : null,
        registrantOrg: clean(regInfo.org ?? regInfo.fn),
        registrantCountry: clean(regInfo.country),
    };
}

export function emptyRow(input, info) {
    return {
        domain: info.domain, input, tld: info.tld, rdapServer: null, registered: null,
        registrar: null, registrarIanaId: null, registrarUrl: null, abuseEmail: null,
        creationDate: null, expirationDate: null, lastChangedDate: null,
        daysUntilExpiry: null, domainAgeDays: null, statuses: [], nameservers: [],
        dnssec: null, registrantOrg: null, registrantCountry: null,
        dns: null, error: null, rdapUrl: null,
    };
}

export function spfFrom(txtRecords) {
    const flat = (txtRecords ?? []).map((r) => (Array.isArray(r) ? r.join('') : String(r)));
    return flat.find((t) => /^v=spf1(\s|$)/i.test(t.trim())) ?? null;
}
