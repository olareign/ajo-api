## What and why

<!-- What does this change, which phase and feature IDs (e.g. P0.8, E1.3) does it deliver? -->

## How it was tested

<!-- Tests written first (TDD), what they cover, manual checks on a phone-sized screen -->

## Security checklist

- [ ] No secrets, keys, tokens or personal data in code, tests, logs or screenshots
- [ ] All input validated; nothing user-controlled reaches HTML, SQL or shell unescaped
- [ ] Money or auth logic changed? Covered by tests, and a second reviewer requested
- [ ] Database change? A reviewed migration with a working `down`, safe to run before the new code deploys
- [ ] New endpoint? DTO validation, authorisation guard, rate limit and a test that other users' data is not reachable
- [ ] New dependencies checked (maintained, licence, no high or critical advisories)
- [ ] Docs updated where behaviour, API or configuration changed
