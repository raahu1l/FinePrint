
# Data Sources

FinePrint was developed and tested against the following public repositories:

- `raahu1l/FinePrint` (this repository) — used as a controlled test case
- `FasterXML/jackson-databind` — real-world validation
- `facebook/react` — real-world validation at scale

All repository data is fetched from GitHub's public REST API. FinePrint supports public repositories only. In Netlify production, a server-side function may attach a read-only GitHub credential to increase the API rate limit; the credential is never sent to browser code. No private repository data is requested or returned.
