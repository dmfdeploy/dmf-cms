# dmf-cms docs

Notes for people who build, release, and change the operator console. The
console is a FastAPI backend (`src/dmf_cms/`) and a React frontend
(`frontend/`).

| Read | For |
|---|---|
| [DEVELOPMENT-AND-BUILD-RULES.md](DEVELOPMENT-AND-BUILD-RULES.md) | The only supported way to version, build, publish, and release the console. Read it before a release. |
| [IMPLEMENTATION-STRATEGY.md](IMPLEMENTATION-STRATEGY.md) | A historical snapshot dated 2026-05-01: why the project chose React and a backend-for-frontend design. Its build steps are out of date. |
| [mxl-flows-page.md](mxl-flows-page.md) | The live view for media-exchange flows. It began as its own page and is now a detail panel in Media Workloads. |
| [changes-forgejo-cases.md](changes-forgejo-cases.md) | Every case that the tests cover for the commits and pull request panels on the Activity History lane, which read from source control. |
| `images/` | Screenshots that the repository README uses. |

The app contract fixture is `config/app-contracts.yaml`. The decisions behind
the console are in the
[dmfdeploy umbrella repo](https://github.com/dmfdeploy/dmfdeploy/tree/main/docs).
