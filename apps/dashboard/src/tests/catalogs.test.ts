import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogRows, languages, messages, resolveLocale, translate } from "../i18n/catalogs";

const tokens = (value: string) => [...value.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
test("every selectable locale has a complete core catalog and matching tokens", () => {
  assert.equal(new Set(languages.map(language => language.code)).size, languages.length);
  assert.equal(new Set(messages).size, messages.length);
  for (const language of languages) {
    if (language.code === "en") continue;
    const row = catalogRows[language.code];
    assert.equal(row.length, messages.length, language.code);
    messages.forEach((message, index) => {
      assert.ok(row[index]?.trim(), `${language.code}: ${message}`);
      assert.deepEqual(tokens(row[index]), tokens(message), `${language.code}: ${message}`);
      assert.equal(translate(language.code, message), row[index]);
    });
  }
});

test("no non-English locale ships an untranslated English string", () => {
  // UX-14: the 5 theme strings were English in all 19 locales and the
  // catalog test could not catch it (an English string passes the
  // length / non-empty / token checks). Every row entry must differ
  // from its English source, except the pairs below: those words are
  // spelled identically in the target language (verified borrowings,
  // not missing translations). A new identical pair must be added here
  // explicitly — it must never pass silently.
  const identicalOk = new Set([
    "fr:Compact", "fr:Notifications", "fr:Audit", "de:Audit", "id:Audit",
  ]);
  for (const language of languages) {
    if (language.code === "en") continue;
    const row = catalogRows[language.code];
    messages.forEach((message, index) => {
      if (identicalOk.has(`${language.code}:${message}`)) return;
      assert.notEqual(row[index], message, `${language.code}: ${message} is still English`);
    });
  }
});

test("regional tags resolve safely without silently mixing Chinese scripts", () => {
  for (const [input, expected] of Object.entries({
    "pt-BR": "pt", "ar-EG": "ar", "es-MX": "es", "zh-TW": "zh-Hant",
    "zh-HK": "zh-Hant", "zh-CN": "zh-Hans", "zh-SG": "zh-Hans", "zh-Hans-TW": "zh-Hans",
    "iw-IL": "he", "EN-us": "en", "": "en", invalid_locale: "en", "zz-ZZ": "en",
  })) assert.equal(resolveLocale(input), expected, input);
});

test("interpolation does not treat user data as markup or recursively translate it", () => {
  const key = "{count} results · Page {page} of {pages}";
  assert.equal(translate("es", key, { count: "1.000", page: 1, pages: 40 }), "1.000 resultados · Página 1 de 40");
  assert.equal(translate("en", "Devices"), "Devices");
  assert.equal(translate("en", key, { count: "<script>{page}</script>", page: 1, pages: 2 }),
    "<script>{page}</script> results · Page 1 of 2");
});
