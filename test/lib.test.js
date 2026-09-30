import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, buildRdapUrl, normalizeDomain, parseBootstrap, parseRdap, parseRetryAfter, spfFrom } from '../src/lib.js';

const NOW = Date.parse('2026-01-01T00:00:00Z');

const VERISIGN = {
    objectClassName: 'domain', ldhName: 'EXAMPLE.COM',
    status: ['client delete prohibited', 'client transfer prohibited', 'client update prohibited'],
    nameservers: [{ objectClassName: 'nameserver', ldhName: 'B.IANA-SERVERS.NET' }, { objectClassName: 'nameserver', ldhName: 'A.IANA-SERVERS.NET' }],
    secureDNS: { delegationSigned: true },
    events: [
        { eventAction: 'registration', eventDate: '1995-08-14T04:00:00Z' },
        { eventAction: 'expiration', eventDate: '2026-08-13T04:00:00Z' },
        { eventAction: 'last changed', eventDate: '2025-08-14T07:01:34Z' },
        { eventAction: 'last update of RDAP database', eventDate: '2026-01-01T00:00:00Z' },
    ],
    entities: [{
        objectClassName: 'entity', roles: ['registrar'],
        publicIds: [{ type: 'IANA Registrar ID', identifier: '376' }],
        vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'RESERVED-Internet Assigned Numbers Authority']]],
        entities: [{ objectClassName: 'entity', roles: ['abuse'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', ''], ['tel', { type: 'voice' }, 'uri', 'tel:+1.5555'], ['email', {}, 'text', 'abuse@iana.example']]] }],
    }],
};

const CCTLD = {
    objectClassName: 'domain', ldhName: 'bbc.co.uk', status: ['active'],
    events: [{ eventAction: 'registration', eventDate: '1996-08-01T00:00:00+00:00' }, { eventAction: 'expiration', eventDate: '2025-12-25T00:00:00Z' }],
    nameservers: [{ ldhName: 'ns1.bbc.co.uk' }],
    entities: [
        { roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['org', {}, 'text', 'Nominet Reg'], ['url', {}, 'uri', 'https://reg.example']]] },
        { roles: ['registrant'], vcardArray: ['vcard', [['org', {}, 'text', 'British Broadcasting Corporation'], ['adr', { cc: 'GB' }, 'text', ['', '', '', '', '', '', 'GB']]]] },
    ],
};

const REDACTED = { ldhName: 'x.org', entities: [{ roles: ['registrant'], vcardArray: ['vcard', [['fn', {}, 'text', 'REDACTED FOR PRIVACY'], ['org', {}, 'text', 'Data Redacted']]] }] };

test('normalizeDomain: plain, url, email', () => {
    assert.deepEqual(normalizeDomain('Apify.com'), { domain: 'apify.com', tld: 'com' });
    assert.equal(normalizeDomain('https://www.apify.com/store?x=1#a').domain, 'apify.com');
    assert.equal(normalizeDomain('http://user:pw@blog.example.org:8080/p').domain, 'example.org');
    assert.equal(normalizeDomain('John <j@mail.example.io>'.replace(/.*<|>/g, '')).domain, 'example.io');
    assert.equal(normalizeDomain('*.example.com.').domain, 'example.com');
});

test('normalizeDomain: multi-part suffixes', () => {
    assert.equal(normalizeDomain('www.bbc.co.uk').domain, 'bbc.co.uk');
    assert.equal(normalizeDomain('bbc.co.uk').domain, 'bbc.co.uk');
    assert.equal(normalizeDomain('shop.example.com.au').domain, 'example.com.au');
    assert.equal(normalizeDomain('co.uk')?.domain, 'co.uk');
});

test('normalizeDomain: idn and invalid', () => {
    assert.deepEqual(normalizeDomain('münchen.de'), { domain: 'xn--mnchen-3ya.de', tld: 'de' });
    assert.equal(normalizeDomain('localhost'), null);
    assert.equal(normalizeDomain(''), null);
    assert.equal(normalizeDomain('not a domain'), null);
    assert.equal(normalizeDomain('example.123'), null);
    assert.equal(normalizeDomain(null), null);
});

test('parseBootstrap and buildRdapUrl', () => {
    const m = parseBootstrap({ services: [[['com', 'net'], ['https://rdap.verisign.com/com/v1/']], [['uk'], ['http://a.example/', 'https://b.example/rdap']], [[], []]] });
    assert.equal(m.get('com'), 'https://rdap.verisign.com/com/v1/');
    assert.equal(m.get('net'), 'https://rdap.verisign.com/com/v1/');
    assert.equal(m.get('uk'), 'https://b.example/rdap/');
    assert.equal(m.get('zzz'), undefined);
    assert.equal(buildRdapUrl(m.get('com'), 'a.com'), 'https://rdap.verisign.com/com/v1/domain/a.com');
    assert.equal(parseBootstrap(null).size, 0);
});

test('parseRdap: Verisign shape', () => {
    const r = parseRdap(VERISIGN, NOW);
    assert.equal(r.registrar, 'RESERVED-Internet Assigned Numbers Authority');
    assert.equal(r.registrarIanaId, '376');
    assert.equal(r.abuseEmail, 'abuse@iana.example');
    assert.equal(r.creationDate, '1995-08-14T04:00:00Z');
    assert.equal(r.expirationDate, '2026-08-13T04:00:00Z');
    assert.equal(r.lastChangedDate, '2025-08-14T07:01:34Z');
    assert.equal(r.daysUntilExpiry, 224);
    assert.equal(r.domainAgeDays, 11097);
    assert.deepEqual(r.nameservers, ['a.iana-servers.net', 'b.iana-servers.net']);
    assert.equal(r.statuses.length, 3);
    assert.equal(r.dnssec, true);
    assert.equal(r.registrantOrg, null);
});

test('parseRdap: ccTLD shape, expired, registrant present', () => {
    const r = parseRdap(CCTLD, NOW);
    assert.equal(r.registrar, 'Nominet Reg');
    assert.equal(r.registrarUrl, 'https://reg.example');
    assert.equal(r.daysUntilExpiry, -7);
    assert.equal(r.registrantOrg, 'British Broadcasting Corporation');
    assert.equal(r.registrantCountry, 'GB');
    assert.equal(r.dnssec, null);
    assert.equal(r.abuseEmail, null);
});

test('parseRdap: redacted and empty input', () => {
    const r = parseRdap(REDACTED, NOW);
    assert.equal(r.registrantOrg, null);
    assert.equal(r.registrar, null);
    assert.deepEqual(r.statuses, []);
    assert.equal(parseRdap({}, NOW).daysUntilExpiry, null);
    assert.equal(parseRdap(null, NOW).creationDate, null);
});

test('retry helpers', () => {
    assert.equal(parseRetryAfter('5'), 5000);
    assert.equal(parseRetryAfter('Thu, 01 Jan 2026 00:00:10 GMT', NOW), 10000);
    assert.equal(parseRetryAfter('junk'), null);
    assert.equal(parseRetryAfter(null), null);
    assert.equal(backoffMs(0, null), 1000);
    assert.equal(backoffMs(1, 7000), 7000);
    assert.equal(backoffMs(9, null), 30000);
    assert.equal(backoffMs(0, 999999), 60000);
});

test('spfFrom', () => {
    assert.equal(spfFrom([['v=spf1 include:_spf.google.com ', '~all'], ['google-site-verification=abc']]), 'v=spf1 include:_spf.google.com ~all');
    assert.equal(spfFrom([['hello']]), null);
    assert.equal(spfFrom(null), null);
});
