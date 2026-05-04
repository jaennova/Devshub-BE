-- Data migration: normalize socialLinks to store only usernames instead of full URLs.
--
-- Previously, socialLinks could store full URLs such as:
--   { "github": "https://github.com/Lyscri", "x": "https://x.com/SammyBytes" }
--
-- After this migration, only the username (last path segment) is kept:
--   { "github": "Lyscri", "x": "SammyBytes" }
--
-- The frontend is responsible for reconstructing the full URL from the username.
--
-- Logic applied to each key-value pair inside the socialLinks JSON object:
--   1. If the value is a string that starts with "http://" or "https://":
--      a. Strip any trailing slashes from the URL.
--      b. Extract the last non-empty path segment (e.g. "Lyscri" from "/in/Lyscri").
--   2. Otherwise, leave the value untouched (already a plain username or null).
--
-- Examples:
--   "https://github.com/Lyscri"        → "Lyscri"
--   "https://x.com/SammyBytes"         → "SammyBytes"
--   "https://linkedin.com/in/SammyBytes"→ "SammyBytes"
--   "SammyBytes"                        → "SammyBytes"  (no change)

UPDATE "User"
SET "socialLinks" = (
  SELECT jsonb_object_agg(
    key,
    CASE
      -- Value is a full URL: extract the last path segment as the username.
      WHEN jsonb_typeof(value) = 'string'
        AND (value #>> '{}') ~ '^https?://'
      THEN to_jsonb(
        regexp_replace(
          -- Step 1: strip trailing slashes.
          regexp_replace(value #>> '{}', '/+$', ''),
          -- Step 2: capture the last path segment after the final slash.
          '^https?://[^/]+(?:/[^/]+)*/([^/?#]+)$',
          '\1'
        )
      )
      -- Value is already a plain username or an unexpected type: keep as-is.
      ELSE value
    END
  )
  FROM jsonb_each("socialLinks")
)
-- Only process rows that have a non-empty socialLinks object.
WHERE "socialLinks" IS NOT NULL
  AND jsonb_typeof("socialLinks") = 'object'
  AND "socialLinks" <> '{}'::jsonb;