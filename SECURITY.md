# Security

Do not post API keys, access tokens, databases, private character packages,
recordings, conversations or unredacted screenshots in issues or pull requests.

For a vulnerability, use GitHub private vulnerability reporting if enabled.
Otherwise contact the maintainer through https://github.com/qian-ramiel to
arrange a private channel before sending sensitive details. No response-time
or security-audit guarantee is made for this development preview.

Include the version, operating system and a minimal reproduction using dummy
data. Credentials that have been exposed should be revoked or rotated first.
Removing them from the latest source does not remove them from Git history.

The local API must not be exposed to the internet. API keys may fall back to
an unencrypted local secrets.json if the system keyring is unavailable. See
docs/PRIVACY.md for current limitations.
