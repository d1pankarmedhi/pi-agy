# Security Policy

## Reporting a Vulnerability

Do not open a public issue for security problems. Report privately by opening a
GitHub security advisory on this repository, or by emailing the maintainer at
dipankarmedhi11@gmail.com.

You should receive a response within 72 hours. Please include steps to
reproduce, affected versions, and (if possible) a fix suggestion.

## Security notes for users

- **Elevated privileges**: with `allowCommands` enabled (default), the
  delegated agy agent runs shell commands with
  `--dangerously-skip-permissions` — full write and command access on your
  machine. Only delegate prompts you trust.
- **Credentials**: headless agy uses your cached Antigravity credentials.
  The extension does not read, store, or transmit them; it only forwards the
  prompt you provide.
- **Zero footprint**: this extension writes nothing to disk. Uninstalling the
  package (`pi remove`) leaves no residue.
- **Review before install**: pi packages run with full system access. Only
  install packages from sources you trust.