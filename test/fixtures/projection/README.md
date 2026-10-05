# Projection fixtures (LFCP-061)

`cases.json` holds portable Markdown → Shared Object cases, reused by later
projection tasks (LFCP-063). Each case:

- `shared`: the Shared Task before the edit (`title`, and optionally
  `status`, `due`, `scheduled`, `priority`, `completion_date`);
- `markdown`: the file after the edit, with LF line endings, where `{{ref}}`
  stands for the object reference (`lfcp1:<resource>#task:<object>`) of
  that Task. Runners also check the same text with CRLF line endings;
- `intents`: the expected intents, in order. Each object lists the intent
  name and the fields that must match;
- `diagnostics`: the expected diagnostic codes, in any order (none other
  may appear).
