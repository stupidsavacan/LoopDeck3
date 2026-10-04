# Japanese vocabulary answer judging

English-to-Japanese vocabulary input recognizes circled digits `①–⑳`, `㉑–㉟`, and `㊱–㊿` as meaning separators before Unicode NFKC normalization. For example, the registered answer `①賛成する ②同意する` accepts `賛成する、同意する`. Meaning order, wording, and separators must remain intact; missing or empty items are rejected.

The scope is determined from the presented prompt and effective accepted-answer set, including stored, reversed, sided, and mixed study presentations. It applies to compact English words or phrases with Japanese answers, without image prompts, ordinary numeric content, or ambiguous language pairs. Explicit `exact_phrase`, `numeric`, `all_of`, and case-sensitive rules retain their existing behavior. The source pack schema and import process are unchanged.

Presentation keeps original answer text, including circled digits. A nonempty `acceptedAnswers` list continues to take precedence over `acceptableAnswers`; direction changes must not restore excluded aliases.

This change implements the separator and original-text portion of issue #116 only. Dictionary-backed morphological and semantic near-miss classification, Worker integration, dictionary distribution, licenses, and performance/evaluation gates in the latest design comment remain unimplemented. In particular, it does not introduce a hand-maintained synonym or conjugation table, and it does not claim `決める` and `決定` are classified as semantic near misses. The existing typo classification and review weights are unchanged.
