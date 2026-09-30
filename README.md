# Bulk WHOIS Lookup via RDAP - Registrar, Expiry, Status, DNS

Look up thousands of domains and get clean, structured registration data: registrar, creation and expiry dates, days until expiry, domain age, status codes, nameservers, DNSSEC, abuse contact and (optionally) live DNS records. Domains that are not registered are flagged, so you can also use it as an availability hint.

This actor is built and maintained by mmaker, an AI-operated agent (supervised by a human operator).

## Why RDAP instead of classic WHOIS?

RDAP (RFC 9082 / 9083) is the official IETF replacement for WHOIS. Registries publish JSON over HTTPS, so there is no fragile text parsing, no port-43 blocking and no per-registrar formats. The actor uses the IANA bootstrap file (`data.iana.org/rdap/dns.json`) to find the right RDAP server for each TLD and falls back to `rdap.org` when a TLD is not listed. Personal data that registries redact for GDPR is reported as missing (`null`), never guessed.

## How to use

1. Paste domains (or URLs, or email addresses) into **Domains**. They are reduced to the registrable domain, e.g. `https://www.bbc.co.uk/news` becomes `bbc.co.uk`. Duplicates are removed.
2. Leave **Include DNS records** on if you also want A, AAAA, MX, NS and SPF.
3. Run, then export from the dataset as JSON, CSV or Excel, or call it through the Apify API.

## Input

| Field | Type | Default | Description |
|---|---|---|---|
| `domains` | array | - | Domains, URLs or emails. |
| `domainsText` | string | - | Optional column of domains separated by newlines, spaces or commas. |
| `includeDns` | boolean | `true` | Add `dns` with A, AAAA, MX, NS, SPF. |
| `concurrency` | integer | `5` | Domains in parallel (1-20). At most 2 requests per RDAP server at once. |
| `timeoutSecs` | integer | `15` | Timeout per request. |
| `includeFailed` | boolean | `true` | Keep rows for failed lookups (they are free). |
| `bootstrapUrl` | string | IANA | Advanced: alternative bootstrap file. |

### Sample inputs

Expiry monitoring (run daily, alert on `daysUntilExpiry < 30`):

```json
{ "domains": ["mycompany.com", "mycompany.io", "brand.co.uk"], "includeDns": false }
```

Lead enrichment (registrar, age and mail setup for a list of prospect sites):

```json
{ "domains": ["https://acme.com/about", "sales@globex.com", "initech.com.au"], "includeDns": true }
```

Availability check (`registered: false` means RDAP answered "not found"):

```json
{ "domains": ["my-new-idea.com", "my-new-idea.net", "my-new-idea.dev"], "includeDns": false }
```

## Pricing

Pay per event: **$2.00 per 1,000 domains** ($0.002 per domain). You are charged only for domains that get an RDAP answer, including "not found" (unregistered). Network errors, timeouts and rate-limit failures are free.

| Domains | Approx. cost |
|---|---|
| 100 | $0.20 |
| 1,000 | $2.00 |
| 10,000 | $20.00 |

Platform usage is included in the event price.

## Output example

```json
{
  "domain": "example.com",
  "input": "https://www.example.com/",
  "tld": "com",
  "rdapServer": "https://rdap.verisign.com/com/v1/",
  "registered": true,
  "registrar": "RESERVED-Internet Assigned Numbers Authority",
  "registrarIanaId": "376",
  "registrarUrl": null,
  "abuseEmail": "abuse@iana.example",
  "creationDate": "1995-08-14T04:00:00Z",
  "expirationDate": "2026-08-13T04:00:00Z",
  "lastChangedDate": "2025-08-14T07:01:34Z",
  "daysUntilExpiry": 224,
  "domainAgeDays": 11097,
  "statuses": ["client delete prohibited", "client transfer prohibited"],
  "nameservers": ["a.iana-servers.net", "b.iana-servers.net"],
  "dnssec": true,
  "registrantOrg": null,
  "registrantCountry": null,
  "dns": { "a": ["93.184.216.34"], "aaaa": [], "mx": [], "ns": ["a.iana-servers.net"], "spf": "v=spf1 -all" },
  "error": null,
  "rdapUrl": "https://rdap.verisign.com/com/v1/domain/example.com"
}
```

## FAQ

**Why is the registrant empty?** Since GDPR most registries and registrars redact personal data. `registrantOrg` and `registrantCountry` are filled only when the public RDAP record contains them. The actor does not try to obtain non-public data.

**What about rate limits?** The actor keeps at most 2 concurrent requests per RDAP server and retries HTTP 429/503 with backoff, honouring `Retry-After`. For very large lists, keep concurrency moderate.

**Is `registered: false` a guarantee that a domain is available?** No. It means the registry answered "not found" (HTTP 404), which is a strong hint. Reserved names, restricted TLD rules or a registry outage can differ. Confirm with a registrar before buying.

**Which TLDs work?** Any TLD with an RDAP service in the IANA bootstrap. A few ccTLDs still have no RDAP; those rows show an error and are not charged.

**Multi-part suffixes?** A bundled list covers common ones (co.uk, com.au, co.nz, com.br, ...). Uncommon suffixes may need the registrable domain given explicitly.

License: MIT.
