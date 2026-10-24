# Review semantics

LoopDeck has two review-related data systems, but only one of them schedules future reviews.

## Ownership

### SRS (`ReviewCard` / `ReviewLog`)

SRS owns automatic scheduling. It decides `dueAt`, interval, ease, and the state shown in the "今日の復習" queue.

Normal runtime states are:

| State        | Meaning                                               | Normal entry                    | Normal exit                                                        |
| ------------ | ----------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| `new`        | no scheduled review yet                               | card creation                   | first rated answer -> `review` or `relearning`                     |
| `review`     | scheduled normal review                               | correct answer                  | correct stays `review`; repeated recent failures can enter `leech` |
| `relearning` | retry after a failed answer                           | `again`                         | correct -> `review`; repeated recent failures can enter `leech`    |
| `leech`      | recent failure pressure is high; needs focused review | recent repeated `again` ratings | a correct answer -> `review`                                       |
| `mastered`   | long correct streak with a long interval              | stable correct answers          | failure -> `relearning`                                            |

`leechLevel` is a bounded recent-failure pressure signal. Historical `totalWrong` and `lapseCount` remain analytics counters; they do not permanently force `leech` or permanently prevent `mastered`.

### Compatibility-only states

- `learning` is retained in `ReviewState` so old persisted data/backups remain readable. Normal scheduling no longer writes it. A legacy `learning` card is handled as `relearning` in due buckets and UI.
- state value `suspended` and the `suspended` flag are retained for persisted-data compatibility. Suspended cards are excluded from automatic due queues. There is currently no normal user-facing transition that creates a suspended card.

## History weak queue (`Attempt`)

The history-based weak queue is analytics/advisory. It ranks candidates for a user-started weak-point review session; it does **not** write SRS `dueAt` or decide the automatic review date.

The default Review Center scope uses the recent-study window and recency weighting introduced for issue #24. All-history mode remains available for old material.

## Module mistake filter

The module's "間違いだけ" filter contains objective mistakes (wrong or answer revealed) until two consecutive objective correct answers follow the latest mistake. A new mistake/reveal resets the streak. Flashcard self-ratings neither add nor clear these mistakes; directions share the same question history. Attempts are ordered by answer time, with input order breaking ties. Existing histories are evaluated immediately, so already-cleared questions disappear from this filter after an app update.

This filter does not delete attempts or change the Review Center's history analytics or SRS schedule. The module and Today's Loop already offer a retry of the current round's mistakes; the Review Center now offers the same completion action, preserving the concrete directions of missed questions. Each retry starts a fresh round, so a clean round offers only a way back.

## Reset semantics

The two data sets are intentionally independent:

- **SRS予定だけリセット** deletes `ReviewCard` / `ReviewLog`. It does not delete answer history, so a question may still appear as a history-based weak candidate.
- **ミス履歴だけ消す** deletes wrong/revealed attempt history. It does not delete SRS state or due dates, so a question may still appear in "今日の復習".

UI confirmation text must state these independent effects explicitly.
