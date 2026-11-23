---
"@searxng-js/sex-egress": minor
"@searxng-js/sex-scrape": minor
"@searxng-js/sex-browser": minor
---

`allowPrivateNetwork` also takes an allowlist (`{ allow: [...], loopback? }`): networks (IPv4 / IPv6 CIDR) and host names, each with an optional port, plus loopback behind its own switch. Allowed addresses are still checked on every redirect hop and pinned; link-local and cloud metadata addresses are refused whatever the list says. `PRIVATE_NETWORK_BLOCKED` errors now carry `details: { host, address?, reason }`. `168.63.129.16`, `100.100.100.200` and `fd00:ec2::254` are refused by the default policy too.
