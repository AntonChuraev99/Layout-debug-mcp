---
title: "Web targets that forbid framing: header probe and an opt-in framing proxy"
date: 2026-10-20
type: decision
keywords: [x-frame-options, frame-ancestors, csp, iframe, proxy, loopback, cookies]
---

# Web targets that forbid framing

## Context

A page sending `X-Frame-Options` or a CSP `frame-ancestors` without the window never renders in the window's `iframe`; the window only said "the inspector didn't respond" and, the frame being cross-origin, can't read why.

## Decision

- **Detection.** For every frame address the window calls `GET /api/framing?url=…`; the server fetches it (redirects followed by hand) and returns `X-Frame-Options` and the enforced CSP. `src/shared/framing.ts` decides with the window's origin as the parent. The banner names the header and the next step, including "a redirect left the proxied origin". A failed probe leaves the generic timeout path.
- **Fix: opt-in framing proxy** (`LD_FRAMING_PROXY=1`, port `LD_FRAMING_PROXY_PORT`, default 5176) on `127.0.0.1`, forwarding to the configured target's origin only. It drops `X-Frame-Options` and the `frame-ancestors` directive (the rest of the CSP stays), adds `frame-ancestors <window origins>`, rewrites redirects to the target, pipes WebSocket upgrades.
- **Cookies are namespaced.** `Set-Cookie` names get the prefix `ldp<port>_` and lose `Domain`; requests carry only cookies with that prefix, unprefixed. Others are dropped.
- **One TLS rule** (`tlsOptionsFor`) for probe and proxy: no certificate check on loopback (self-signed dev certs), full checks elsewhere.

## Why

- Not an open proxy: the upstream origin is fixed; `checkProxyRequest` refuses CONNECT, absolute-form request lines and any Host other than the proxy on loopback (DNS rebinding); `proxyUpstreamUrl` refuses paths leaving the origin.
- The probe reaches only loopback and the configured target, and only the window can call it.
- A window-only `frame-ancestors` keeps other sites from framing the proxied page.
- Browsers don't scope cookies by port: without the prefix, cookies of any other server on 127.0.0.1 would reach a (possibly remote) target, and the target's cookies would collide with theirs. Server-side sessions keep working.
- **CDP mode** (attach to a real tab via the Chrome DevTools Protocol) avoids framing but needs a debug-port browser and a second rendering path; it stays the alternative.

## Consequences

- Off by default. Other local processes can reach the proxy port, as they can the dev server.
- Non-HttpOnly cookies of the proxied page are still readable by scripts of any other page on 127.0.0.1, and page code reading cookies by name sees the prefixed names.
- `Authorization` is forwarded as is (the page's own login calls).
- OAuth redirect URIs and absolute URLs from the page's config still point at the original origin. One target per server start.
