# Security policy

## Supported versions

The latest official stable release is the supported security baseline. This tree
records published 1.4.8, verified against Google delivery on October 18, 2026. Check the Store listing
and release notes; older versions may require updating rather than a backport.

## Report privately

Email **support@zmetrics.net** with the subject `ZMetrics security report`.
Include the affected version/source revision, platform, reproduction steps,
impact and a minimal proof of concept using synthetic data. Do not post exploitable
vulnerabilities or credentials in a public issue. Do not send wallet seeds, access
tokens or private user data. If GitHub private vulnerability reporting is enabled
for the official source repository, that is also an appropriate channel.

We will assess reports and coordinate a fix and disclosure when possible. This
project does not promise a fixed response deadline or a bug bounty. Reporter credit
is optional and subject to the reporter's consent.

## Scope and boundaries

The public extension source, build scripts and produced package are in scope.
CoinGecko, Chrome/Google, the website and hosting systems have their own security
contacts. Test only systems and accounts you are authorized to test. Do not probe
production backends to demonstrate an extension issue.

The release validation checks a narrow package inventory, permission/CSP boundary,
local dependencies and recognizable credential patterns. It is not a security
certification and does not replace review. The official Store account controls
updates; source availability alone cannot guarantee every later update is safe.
