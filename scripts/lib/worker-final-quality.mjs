// Require several independent signals before changing the result of a completed turn.
const statusStart = /^(?:DONE|PASS(?:ED)?|FAIL(?:ED)?|BLOCKED|QUESTION|SUMMARY|RESULTS?|COMPLETED|IMPLEMENTED|FIXED|VERIFIED|UPDATED|ADDED|CHANGED|COMMITTED|TEST(?:S|ING)?|VALIDATION|WORKER-RESULT|REVIEW-RESULT)\b/i;
const chineseStatusStart = /^(?:已完成|完成|结论|结果|总结)(?=$|[\s:：。，！])/u;
const englishWords = new Set(('a an and are as at be been both by can did does each for from had has have in is it its '
  + 'more no of on one only or other our out so some than that the their them then there these they this those '
  + 'to two up use used using was we were what when where which will with would you your').split(' '));
const scripts = [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u];
const cjkRun = new RegExp(`${scripts[2].source}{2,}`, 'u');

export function isIncoherentFinal(text) {
  if (typeof text !== 'string' || text.length < 400) return false;
  const prose = text
    .replace(/^```[^\n]*\n[\s\S]*?^```[ \t]*$/gm, ' ')
    .replace(/`[^`\n]+`|\]\([^\n)]+\)|(?:https?:\/\/|\.{0,2}\/|~\/)\S+/g, ' ');
  let mixed = 0, switches = 0, recognisable = 0, total = 0;
  for (const rawLine of prose.split('\n')) {
    const line = rawLine.replace(/^\s*(?:(?:[#>*+-]+|\d+\.)\s+)*/, '');
    if (statusStart.test(line) || chineseStatusStart.test(line)) return false;
    let good = 0, english = 0, cjk = 0, words = 0;
    for (const word of line.match(/\p{L}+/gu) ?? []) {
      const parts = [...word].map(ch => scripts.findIndex(script => script.test(ch))).filter(i => i >= 0);
      if (!parts.length) continue;
      words++;
      const changes = parts.slice(1).filter((script, i) => script !== parts[i]).length;
      // Chinese writing does not require spaces around English technical terms.
      // Count a substantial CJK span as prose unless the word also contains Cyrillic.
      if (changes && (parts.includes(1) || !cjkRun.test(word))) { mixed++; switches += changes; continue; }
      if (changes) { cjk += parts.filter(part => part === 2).length; good++; continue; }
      if (parts[0] === 2 && parts.length >= 2) { cjk += parts.length; good++; }
      if (parts[0] === 0 && englishWords.has(word.toLowerCase())) { english++; good++; }
    }
    if (english >= 3 && words >= 6 && english / words >= 0.25) return false;
    if (cjk >= 8 && /[。！；，：]/.test(line)) return false;
    total += words;
    recognisable += good;
  }
  return total >= 30 && mixed >= 12 && mixed / total >= 0.3 && switches >= 20 && recognisable / total <= 0.2;
}
