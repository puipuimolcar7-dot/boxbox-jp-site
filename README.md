# BoxBox JP site

Support / privacy pages for the BoxBox JP app, and the Japanese translations of F1 team radio that the app reads.

- `radio/<session_key>.json` — transcripts and Japanese translations, generated hourly by `.github/workflows/radio.yml` (`scripts/translate-radio.mjs`, Gemini API, needs the `GEMINI_API_KEY` secret).
- Race data and radio listings come from [OpenF1](https://openf1.org) (CC BY-NC-SA 4.0). Radio audio belongs to its rights holders. The translations here are provided for non-commercial fan use under the same license.
- GitHub disables scheduled workflows in public repos after 60 days without commits (e.g. over the winter break). Re-enable "Translate team radio" in the Actions tab before the new season.

Unofficial fan project, not affiliated with Formula 1, the FIA, any team or driver.
