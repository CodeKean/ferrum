# Security

## Reporting a vulnerability

Email **adnan@theascension.company** with the details. Please do not open a public issue for a
security problem — a public issue tells everyone running Ferrum about the hole at the same moment it
tells us.

Useful to include: what an attacker can do, the version or commit you tested, and the smallest set
of steps that reproduces it.

**What to expect:** an acknowledgement within 3 working days, and an assessment of whether it is
reproducible and how serious it looks within 10. If it is a real issue, we will tell you when a fix
lands and credit you in the release notes unless you would rather we did not.

## Supported versions

Ferrum is a v1 alpha. Only the latest release gets fixes; there are no backports to earlier alphas.
Upgrade before reporting if you are behind.

## What is worth looking at

Ferrum runs on your own machine and holds real credentials, and two of the things it does are
inherently sharp:

- **It executes AI-written rules.** Rules run in a sandbox and only after a human approves the exact
  text, with approval bound to a hash of that text. A way to run code without an approval, or to
  change approved code without invalidating the approval, or to reach outside the sandbox, is a
  vulnerability.
- **It spawns local processes for connected apps (MCP).** Stored commands are launched as child
  processes, and row data is written to their stdin rather than interpolated into a command line. A
  way to get a cell value parsed as a shell command is a vulnerability.

Also in scope: reading or exfiltrating stored provider keys, reaching the API from a web page in the
browser (the Host and Origin guards), reaching an internal address through the web-call or research
columns, and any way to act as another account on a shared instance.

## Not vulnerabilities

- **A shared instance that nobody has claimed is open.** Sign-in exists once the first account is
  created, so an unclaimed instance on a public address has no sign-in to enforce. This is documented
  in the README and printed in red on boot.
- **A shared instance served over plain HTTP leaks its session cookie.** Ferrum does not terminate
  TLS; put it behind HTTPS.
- **`FERRUM_DEV_SCRIPTS=1` allows unreviewed code to run.** That is the whole purpose of the
  variable. It is off unless you set it.
- Anything that needs an attacker to already have your user account on your own machine — at that
  point they can read the database file directly.
