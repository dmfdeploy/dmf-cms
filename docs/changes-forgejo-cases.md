# Changes panel cases

The commits and pull request panels on the Activity History lane read Forgejo through `/api/changes/commits` and `/api/changes/pulls`. This page lists every case the tests cover. The tests name each case by its row id, for example `S3` or `M8`. Search the test names for an id to find its tests.

## Rules the cases follow

- The page says source control is unreachable only when the repository search got no HTTP reply. After the search replied, nothing later in the same read can make the page say so. A repository call with no answer is then a failed read.
- A call has one of three outcomes. **OK**: a response arrived with a valid body. **No answer**: no HTTP response arrived (connection refused, timeout, DNS or TLS failure before any reply). **Reply failed**: a response arrived but has no usable body (an HTTP error status, a body cut short, empty, not JSON, or the wrong shape).
- Every reply shape is validated before any row or count is added. One malformed item fails that repository's whole read and leaves no rows from it. Rows of repositories read earlier stay.
- An absent optional field takes its default. A present field of the wrong type fails the repository. A pull request `number` must be an integer, not a boolean.
- `X-Total-Count` is valid when it appears once, is a plain non-negative integer, and is not below the number of repositories returned. Otherwise it counts as absent. `repos_maybe_incomplete` is true when a valid total is greater than the number returned. Without a valid total, it is true when the number returned is at least the page size of 50.
- Only the first five repositories are asked. Pull request repositories with pull requests turned off are not asked and do not use up the five. `skipped_repos` counts eligible repositories beyond the five.
- Reasons, pull requests: search no answer gives `forgejo-unreachable`. Search reply failed gives `forgejo-read-failed`. If nothing was asked, the reason is `forgejo-pulls-disabled` when repositories were listed and all are off, otherwise empty. If none of the asked repositories failed, the reason is empty. If some failed and some were read, or some are turned off, the reason is `forgejo-partial`. If all asked repositories failed and none are turned off, the reason is `forgejo-read-failed`.
- Reasons, commits: the same, except that all of the first five repositories are asked, including repositories with pull requests turned off, and there is no `forgejo-pulls-disabled`.
- Every reply carries `skipped_repos` (number) and `repos_maybe_incomplete` (boolean), and the pull request reply also carries `disabled_repos`. Defaults are 0, 0 and false. The 401 response for an unauthenticated request keeps its `error` body. An older server omits the fields, and the console reads an absent field as 0 or false.

## What the lane shows

Notices appear above the rows, in this order: the read-state notice, then the pull-requests-turned-off notice (pull requests only), then the skipped notice, then the incomplete notice, then the rows. The read-state notice appears whenever the read did not fully succeed, with or without rows. The other three appear whenever their field says so. After a failed refetch, the query keeps its last good data, so the retained rows and counts show under the load error.

| Name | Text (`kind` is "pull requests" or "commits") |
|---|---|
| EMPTY | No recent `kind` |
| UNREACH | Source control is unreachable — recent `kind` cannot be read right now. Retrying automatically. |
| READFAIL | Recent `kind` could not be read from source control. Retrying automatically. |
| PARTIAL | Some repositories could not be read — recent `kind` may be incomplete. Retrying automatically. |
| ALLOFF | Pull requests are turned off for these repositories |
| SOMEOFF | Pull requests are turned off for some repositories, so this list leaves them out. |
| SKIPPED(n) | n more repositories were not read, so this list may be incomplete. (n = 1: "1 more repository was not read, so this list may be incomplete.") |
| INCOMPLETE | The repository list may be incomplete, so some repositories were not read. |
| LOADERR | Recent `kind` could not be loaded. Retrying automatically. |
| UNCONF | Source control is not configured in this environment — an administrator can connect it to show recent commits and pull requests here. |

EMPTY shows only when the reason is empty, there are no rows, and `disabled_repos`, `skipped_repos` and `repos_maybe_incomplete` are all zero or false.

## Test layers

- **B**: the route, with only `urllib.request.urlopen` stubbed. The Forgejo client, the header read and the route run for real.
- **C**: the console lane, rendered from the same JSON as B, in `frontend/src/__tests__/fixtures/changes-contract-1025.json`.
- **U**: `forgejo.py` alone.

The fixture holds the setup, the route response and the lane for each B and C row. A drift in either layer fails its own test.

Repositories a, b and c have pull requests turned on unless a case says "off". In the pull request cases, `d`, `s` and `i` stand for `disabled_repos`, `skipped_repos` and `repos_maybe_incomplete`, shown only when non-zero or true.

A case in sections A and B applies to both panels. For sections A and B, the commits panel uses the same inputs. The cases with 50 returned repositories also show a SKIPPED notice, because only five are asked.

## A. Search call outcome (both routes)

| Row | Search outcome | Lane shows | Route response |
|---|---|---|---|
| S1 | good list, A good (2 rows) | 2 rows | `""` |
| S2 | empty list (`data: []`), no header | EMPTY | `""` |
| S3 | HTTP 404 | READFAIL | `forgejo-read-failed` |
| S4a | HTTP 500 | READFAIL | `forgejo-read-failed` |
| S4b | HTTP 401 or 403 | READFAIL | `forgejo-read-failed` |
| S5a | no answer: connection refused | UNREACH | `forgejo-unreachable` |
| S5b | no answer: connect timeout | UNREACH | `forgejo-unreachable` |
| S5c | no answer: DNS failure | UNREACH | `forgejo-unreachable` |
| S5d | no answer: TLS handshake failure (no reply began) | UNREACH | `forgejo-unreachable` |
| S6a | bad JSON | READFAIL | `forgejo-read-failed` |
| S6b | empty body (zero bytes, status 200) | READFAIL | `forgejo-read-failed` |
| S6c | wrong shape: `ok` not `true`; `data` missing or not a list; top level a list | READFAIL | `forgejo-read-failed` |
| S6d | malformed element, one case each: `null`, string, number, nested list, object without `full_name`, `full_name` not a string or empty, `name` missing or not a string, `has_pull_requests` a string | READFAIL, no rows (atomic) | `forgejo-read-failed` |
| S6e | malformed element at position 40 of 50 (beyond the cap) | READFAIL, no rows | `forgejo-read-failed` |
| S7a | reply received, then the body read times out or resets | READFAIL | `forgejo-read-failed` |
| S7b | TLS error after the reply began | READFAIL | `forgejo-read-failed` |
| S7c | HTTP 500 whose error body cannot be read | READFAIL | `forgejo-read-failed` |
| S7d | HTTP 500 with an undecodable (non-UTF-8) body | READFAIL | `forgejo-read-failed` |
| S8 | untyped exception in the route while handling the search (for example a conversion bug) | READFAIL | `forgejo-read-failed` |

## B. Search header and the incomplete flag (both routes)

| Row | Returned, header | Flag | Pulls lane shows | Commits panel shows |
|---|---|---|---|---|
| H1 | 50, `X-Total-Count: 80` | `i` | plus INCOMPLETE | plus INCOMPLETE |
| H2 | 50, `X-Total-Count: 50` (full page, total equal) | false | no INCOMPLETE | no INCOMPLETE |
| H3 | 50, header absent | `i` (fallback) | plus INCOMPLETE | plus INCOMPLETE |
| H4 | 20, header absent | false | no INCOMPLETE | no INCOMPLETE |
| H5a | 50, header invalid (`abc`) | `i` (fallback) | plus INCOMPLETE | plus INCOMPLETE |
| H5b | 50, header `-3` | `i` | plus INCOMPLETE | plus INCOMPLETE |
| H5c | 50, header `10.5`, `1e2` or empty | `i` | plus INCOMPLETE | plus INCOMPLETE |
| H5d | 50, two `X-Total-Count` values | `i` | plus INCOMPLETE | plus INCOMPLETE |
| H6 | 20, header invalid (`abc`, `-3`) | false (fallback) | no INCOMPLETE | no INCOMPLETE |
| H7a | 20, header 10 (total below returned, inconsistent, treated as invalid) | false (fallback) | no INCOMPLETE | no INCOMPLETE |
| H7b | 50, header 10 (inconsistent) | `i` (fallback) | plus INCOMPLETE | plus INCOMPLETE |
| H8 | 0, header 10 | `i` | INCOMPLETE only. No EMPTY, no ALLOFF, reason `""` | INCOMPLETE only. No EMPTY |
| H9a | 0, header 0 | false | EMPTY | EMPTY |
| H9b | 0, header absent | false | EMPTY | EMPTY |
| H10 | 3 enabled repos, all empty, header 40 | `i` | INCOMPLETE; no EMPTY | A–C names, INCOMPLETE above them; no EMPTY |
| H11 | 3 enabled repos, all empty, header 3 | false | EMPTY | A–C names |

## C. One repository, search good (pulls lane; commits are in section I)

| Row | Per-repo outcome | Lane shows | Route response |
|---|---|---|---|
| R1 | A good list (rows) | rows | `""` |
| R2 | A empty list | EMPTY | `""` |
| R3 | A off | ALLOFF; no rows, no EMPTY | `forgejo-pulls-disabled`, d1 |
| R4a | A HTTP 404 | READFAIL | `forgejo-read-failed` |
| R4b | A HTTP 500 | READFAIL | `forgejo-read-failed` |
| R4c | A HTTP 401 or 403 | READFAIL | `forgejo-read-failed` |
| R5a | A no answer: refused | READFAIL | `forgejo-read-failed` |
| R5b | A no answer: connect timeout | READFAIL | `forgejo-read-failed` |
| R7 | A has no `has_pull_requests` field, or it is `null` | treated as on: follows R1 or R2 | as R1 or R2 |

## D. Mixed cases across repositories (search good, pulls lane)

| Row | Per-repo outcomes | Lane shows | Route response |
|---|---|---|---|
| M1 | A off, B empty | SOMEOFF; no EMPTY | `""`, d1 |
| M2 | A off, B rows | SOMEOFF, B's rows | `""`, d1 |
| M3 | A off, B HTTP 404 | PARTIAL, SOMEOFF | `forgejo-partial`, d1 |
| M3b | A off, B no answer | PARTIAL, SOMEOFF | `forgejo-partial`, d1 |
| M4 | A rows, B HTTP 404 | PARTIAL, A's rows | `forgejo-partial` |
| M5 | A empty, B HTTP 404 | PARTIAL; no rows, no EMPTY | `forgejo-partial` |
| M5b | A empty, B no answer | PARTIAL; no rows, no EMPTY | `forgejo-partial` |
| M6 | A HTTP 404, B no answer | READFAIL | `forgejo-read-failed` |
| M7 | A off, B off | ALLOFF | `forgejo-pulls-disabled`, d2 |
| M8 | A HTTP 404, B HTTP 404 (every enabled repo) | READFAIL | `forgejo-read-failed` |
| M9 | A no answer, B no answer | READFAIL | `forgejo-read-failed` |
| M10 | A rows, B no answer | PARTIAL, A's rows | `forgejo-partial` |
| M11 | A HTTP 500, B HTTP 404 | READFAIL | `forgejo-read-failed` |
| M12 | A off, B off, C HTTP 404 | PARTIAL, SOMEOFF | `forgejo-partial`, d2 |
| M13 | A rows, B empty | A's rows; no notice | `""` |
| M14 | A off, B no answer, C HTTP 404 | PARTIAL, SOMEOFF | `forgejo-partial`, d1 |

## E. The cap of 5 and the listed repos (search good)

| Row | Setup | Lane shows | Route response |
|---|---|---|---|
| K1 | 7 enabled, A–E empty, F and G never asked | SKIPPED(2); no EMPTY | `""`, s2 |
| K2 | 7: A off, B–F enabled and empty, G enabled and never asked | SOMEOFF, SKIPPED(1); no EMPTY | `""`, d1, s1 |
| K3 | 6: A off, B–F enabled, all empty | SOMEOFF; no SKIPPED, no EMPTY | `""`, d1 |
| K4 | 7 enabled, A–E rows | SKIPPED(2), A–E rows | `""`, s2 |
| K5 | 7 enabled, A HTTP 404, B–E empty | PARTIAL, SKIPPED(2); no EMPTY | `forgejo-partial`, s2 |
| K6 | 7 enabled, A–E all HTTP 404 | READFAIL, SKIPPED(2) | `forgejo-read-failed`, s2 |
| K7 | exactly 5 enabled, A–E empty | EMPTY | `""` |
| M16 | 7: A, B, C off; D–G enabled (all asked, rows) | SOMEOFF, rows from D–G; no SKIPPED (off repos leave before the cap) | `""`, d3 |
| M17 | 8: A, B off; C–H enabled; C–G asked (rows), H beyond | SOMEOFF, SKIPPED(1), C–G rows | `""`, d2, s1 |
| T1a | 49 returned, header absent; 5 enabled, all empty; 44 off | SOMEOFF; no INCOMPLETE, no EMPTY | `""`, d44 |
| T1b | 49 returned, header 49, same | SOMEOFF; no INCOMPLETE | `""`, d44 |
| T1c | 49 returned, header 60, same | SOMEOFF, INCOMPLETE | `""`, d44, i |
| T2a | 50 returned, header absent; 5 enabled, all empty; 45 off | SOMEOFF, INCOMPLETE; no EMPTY | `""`, d45, i |
| T2b | 50 returned, header 50, same | SOMEOFF only | `""`, d45 |
| T3a | 50 returned, header absent, all off | ALLOFF, INCOMPLETE | `forgejo-pulls-disabled`, d50, i |
| T3b | 50 returned, header 50, all off | ALLOFF only | `forgejo-pulls-disabled`, d50 |
| T4a | 50 returned, header absent; 5 enabled with rows; 45 off | SOMEOFF, INCOMPLETE, rows | `""`, d45, i |
| T4b | 50 returned, header 80, same | SOMEOFF, INCOMPLETE, rows | `""`, d45, i |
| T5 | 50 returned, header absent; 45 enabled, 5 off; the first 5 enabled empty, 40 never asked | SOMEOFF, SKIPPED(40), INCOMPLETE; no EMPTY | `""`, d5, s40, i |
| T6 | 0 returned | see H8 to H9b |  |

## F. Reply shapes of one repository's call (search good)

| Row | A's call | Lane shows | Route response |
|---|---|---|---|
| W1 | bad JSON | READFAIL | `forgejo-read-failed` |
| W2 | JSON object, non-empty | READFAIL | `forgejo-read-failed` |
| W3 | JSON string, non-empty | READFAIL | `forgejo-read-failed` |
| W4 | JSON number | READFAIL | `forgejo-read-failed` |
| W5 | JSON `null` | READFAIL | `forgejo-read-failed` |
| W6 | JSON empty object `{}` | READFAIL | `forgejo-read-failed` |
| W7 | JSON empty string `""` | READFAIL | `forgejo-read-failed` |
| W8 | zero-byte body, status 200 | READFAIL | `forgejo-read-failed` |
| W9 | list: one good item, then a non-object (`null`, string, number, list) | READFAIL; the good item is dropped | `forgejo-read-failed` |
| W10 | list whose first item has `user: null` | READFAIL | `forgejo-read-failed` |
| W11 | item with `user` a string or list | READFAIL | `forgejo-read-failed` |
| W12 | item with `number` not an integer, or `title`, `state`, `created_at`, `html_url` not a string, or `user.login` not a string | READFAIL | `forgejo-read-failed` |
| W13 | with B: A good rows, B list with a malformed item | PARTIAL, A's rows; none of B's items | `forgejo-partial` |
| W14 | with B: A malformed item, B good rows | PARTIAL, B's rows only | `forgejo-partial` |
| W15 | with B: A malformed, B malformed | READFAIL | `forgejo-read-failed` |
| W16 | body read fails after the headers (timeout, reset, short read) | READFAIL | `forgejo-read-failed` |
| W17 | HTTP 500 whose error body cannot be read or decoded | READFAIL | `forgejo-read-failed` |
| W18 | unexpected non-Forgejo exception in conversion (injected) | READFAIL (the repo failed) | `forgejo-read-failed` |
| W19 | HTTP 404 with a valid JSON error body | READFAIL | `forgejo-read-failed` |

## G. Console API, classifier, retained rows, older servers (frontend)

| Row | Payload or query state | Lane shows |
|---|---|---|
| X1 | console API call fails on first load | LOADERR; no EMPTY |
| X2 | refetch fails after a good read with rows | LOADERR, rows (retained) |
| X2b | refetch fails after a good read whose data had d2, s1, i true | LOADERR, SOMEOFF, SKIPPED(1), INCOMPLETE, rows. The retained counts stay because they describe the retained rows |
| X2c | refetch fails after a READFAIL read (no rows) | LOADERR only |
| X3 | not configured | UNCONF |
| X3b | `forgejo-unconfigured` with rows | UNCONF, rows |
| X4a | unknown `reason` token, no rows | LOADERR; no EMPTY |
| X4b | unknown `reason` token with rows | LOADERR, rows |
| X4c | `reason` absent, without rows and with rows | LOADERR, (rows) |
| X5a | `forgejo-read-failed`, no rows | READFAIL |
| X5b | `forgejo-read-failed` with rows | READFAIL, rows |
| X5c | `forgejo-unreachable` with rows | UNREACH, rows |
| X5d | `forgejo-pulls-disabled` with rows | ALLOFF, rows |
| X5e | `forgejo-partial` with rows | PARTIAL, rows |
| X6 | `forgejo-read-failed`, d2, s1, i true | READFAIL, SOMEOFF, SKIPPED(1), INCOMPLETE. The read-state notice survives the other notices |
| X7 | `forgejo-pulls-disabled`, d3, i true | ALLOFF, INCOMPLETE (no SOMEOFF) |
| X8 | the new token reaches an older frontend | LOADERR (the default branch fails closed) |
| O1 | pulls payload without `skipped_repos` and `repos_maybe_incomplete`; `reason ""`, no rows, `disabled_repos` 0 | EMPTY (absent fields read as 0 and false) |
| O2 | pulls payload without `disabled_repos`, with rows | rows; no SOMEOFF |
| O3 | pulls payload without all three fields, `forgejo-partial` | PARTIAL; none of SOMEOFF, SKIPPED, INCOMPLETE |
| O4 | commits payload without `skipped_repos` and `repos_maybe_incomplete`; `reason ""`, no repos | EMPTY |
| O5 | commits payload without the fields, with repos | repos; no SKIPPED, no INCOMPLETE |
| O6 | an older server's `forgejo-unreachable` for what the new route calls read failed | UNREACH (what that server saw) |

## I. Commits panel (`/api/changes/commits`)

The commits panel uses the reason ladder, shape rules and header rule above. It asks the first five repositories, including repositories with pull requests turned off. A repository that answers with an empty list still adds an entry, which shows its name alone. Rows S1 to S7d and H1 to H11 apply to it as written.

| Row | Per-repo outcomes | Panel shows | Route response |
|---|---|---|---|
| F-R1 | A empty list | A's name | `""` |
| F-R2 | A HTTP 404 | READFAIL | `forgejo-read-failed` |
| F-R3 | A HTTP 500, 401 or 403 | READFAIL | `forgejo-read-failed` |
| F-R4 | A no answer | READFAIL | `forgejo-read-failed` |
| F-M1 | A commits, B HTTP 404 | PARTIAL, A's commits | `forgejo-partial` |
| F-M2 | A empty, B HTTP 404 | PARTIAL, A's name | `forgejo-partial` |
| F-M3 | A commits, B no answer | PARTIAL, A's commits | `forgejo-partial` |
| F-M4 | A HTTP 404, B no answer | READFAIL | `forgejo-read-failed` |
| F-M5 | A HTTP 404, B HTTP 404 | READFAIL | `forgejo-read-failed` |
| F-M6 | A no answer, B no answer | READFAIL | `forgejo-read-failed` |
| F-M7 | A commits, B empty | both entries; no notice | `""` |
| F-M8 | A off for pull requests, B commits | both entries as normal; no SOMEOFF | `""` |
| F-K1 | 7 repos, A–E commits | SKIPPED(2), A–E commits | `""`, s2 |
| F-K2 | 7 repos, A–E empty | SKIPPED(2), A–E names | `""`, s2 |
| F-K3 | 7 repos, A HTTP 404, B–E commits | PARTIAL, SKIPPED(2), B–E commits | `forgejo-partial`, s2 |
| F-K4 | exactly 5 repos, A–E empty, header absent | A–E names, no notice | `""` |
| F-T1a | 50 returned, header absent, A–E commits | SKIPPED(45), INCOMPLETE, A–E commits | `""`, s45, i |
| F-T1b | 50 returned, header 50, A–E commits | SKIPPED(45), A–E commits | `""`, s45 |
| F-W1 | A bad JSON | READFAIL | `forgejo-read-failed` |
| F-W2 | A JSON object non-empty, string non-empty, number, or `null` | READFAIL | `forgejo-read-failed` |
| F-W3 | A JSON `{}`, `""`, or zero-byte body | READFAIL | `forgejo-read-failed` |
| F-W4 | A list with a non-object item | READFAIL | `forgejo-read-failed` |
| F-W5 | A item with `commit: null`, `commit.author: null`, or `sha` not a string | READFAIL | `forgejo-read-failed` |
| F-W6 | A item with `message`, `author.name`, `author.date` or `html_url` not a string | READFAIL | `forgejo-read-failed` |
| F-W7 | with B: A commits, B malformed item | PARTIAL, A's commits; none of B's | `forgejo-partial` |
| F-W8 | with B: A malformed, B commits | PARTIAL, B's commits | `forgejo-partial` |
| F-W9 | with B: A malformed, B malformed | READFAIL | `forgejo-read-failed` |
| F-W10 | body read fails after headers; HTTP error whose body cannot be read | READFAIL | `forgejo-read-failed` |

## Evidence rules

| Row | Rule |
|---|---|
| E2 | No single test spans Forgejo to the console. A backend test (search 200, repository 404) and a component test share the fixture: the backend asserts the response, the component asserts the lane. Rows S3 and M8 use this pair. |
| E3 | Only the rows S5a to S5d expect `forgejo-unreachable`. Rows M8 and M9 expect `forgejo-read-failed`. |
| E4 | Row M1 (one repository off, one empty) shows SOMEOFF and no EMPTY, in both layers. |
| E7 | One component test per panel renders every notice at once and asserts the order above the rows. |

Row T6 (no repositories returned) is covered by rows H8 to H9b.
