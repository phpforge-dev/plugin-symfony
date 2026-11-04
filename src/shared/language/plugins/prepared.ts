import { analyze, decode, segments, type FileContext, type Literal, type Segment } from '../php-source';

// Análise por texto reaproveitada entre os vários pontos de um mesmo arquivo (diagnósticos
// percorrem todas as strings; sem isto cada uma reanalisaria o arquivo inteiro).
export type Prepared = { segments: Segment[]; code: string; plain: string; context: FileContext };
let memo: { text: string; value: Prepared }[] = [];
export function prepared(text: string): Prepared {
 const hit = memo.find(m => m.text === text); if (hit) return hit.value;
 const list = segments(text); const code = text.split(''); const plain = text.split('');
 for (const s of list) if (s.kind !== 'code') for (let i = s.start; i < s.end; i++) if (code[i] !== '\n') { code[i] = ' '; if (s.kind === 'comment') plain[i] = ' '; }
 const value = { segments: list, code: code.join(''), plain: plain.join(''), context: analyze(text) };
 memo = [{ text, value }, ...memo].slice(0, 3);
 return value;
}
/** Mesmo contrato de `literalAt`, sobre a análise memorizada. */
export function literalIn(text: string, offset: number): Literal | null {
 const list = prepared(text).segments;
 let lo = 0, hi = list.length - 1;
 while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (list[mid].start < offset) lo = mid; else hi = mid - 1; }
 for (let k = Math.max(0, lo - 1); k <= Math.min(list.length - 1, lo + 1); k++) {
  const s = list[k];
  if (s.kind !== 'string' || offset <= s.start || offset > s.end) continue;
  if (s.quote !== "'" && s.quote !== '"') return null;
  const closed = s.end - s.start >= 2 && text[s.end - 1] === s.quote;
  if (offset === s.end && closed) continue;
  const raw = text.slice(s.start + 1, closed ? s.end - 1 : s.end);
  if (s.quote === '"' && /\$[A-Za-z_{]|\{\$/.test(raw)) return null;
  return { value: decode(raw, s.quote), start: s.start, end: s.end, quote: s.quote, closed };
 }
 return null;
}
