import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A lost closing brace once swallowed every rule after it into a phone-only
// @media block, so the casino art and the lobby avatar lost their styles on
// desktop. Check the stylesheets are balanced and every section starts at the top level.
for (const file of ['src/ui/styles.css', 'src/admin/admin.css']) {
  test(`${file} has balanced braces and no section opens inside a block`, () => {
    const css = readFileSync(join(process.cwd(), file), 'utf8');
    let depth = 0;
    let at = 0;
    for (let i = 0; i < css.length; i++) {
      if (css.startsWith('/*', i)) {
        const end = css.indexOf('*/', i + 2);
        assert.ok(end > 0, `${file}: comment at offset ${i} never closes`);
        const line = css.slice(0, i).split('\n').length;
        if (css.startsWith('/* ----', i)) assert.equal(depth, 0, `${file}:${line}: section header inside a block opened on line ${at}`);
        i = end + 1;
        continue;
      }
      if (css[i] === '{') { if (depth === 0) at = css.slice(0, i).split('\n').length; depth++; }
      if (css[i] === '}') { depth--; assert.ok(depth >= 0, `${file}:${css.slice(0, i).split('\n').length}: extra }`); }
    }
    assert.equal(depth, 0, `${file}: block opened on line ${at} never closes`);
  });
}
