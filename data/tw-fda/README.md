# Taiwan FDA food-composition snapshot

This directory contains the one current official food-composition snapshot used by
the first release. The source is the Taiwan Food and Drug Administration’s
Nutrition Information Database, published under the Government Open Data License,
version 1.0. Attribution and the exact download URL are in `manifest.json`.

`food-composition.json.zip` is stored unmodified. The importer verifies its
SHA-256 before it parses any content or mutates PostgreSQL. `manifest.json`
records the archive’s integrity, source time, parser version and verified import
counts. The snapshot SHA-256 is the database source revision; the Git commit that
changes this directory is the immutable history reference.

The normal Compose stack runs the `nutrition-import` one-shot service before the
application starts. It validates this archive's SHA-256 and only skips parsing
when the current database revision has the manifest's exact record, food, and
nutrient counts. Thus an empty or partial database cannot silently serve meals.

## Refresh procedure

1. Download only the URL in `manifest.json`; do not modify the archive contents.
2. Validate the archive and calculate its SHA-256.
3. Replace this one archive and update its manifest in the same commit.
4. Run the importer against that committed archive, then run the full test suite.

Do not retain multiple raw snapshots in this repository. Git history is the sole
archive of prior source versions. Do not place meal photos, user data, OAuth
tokens, or API keys in this directory.
