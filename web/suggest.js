// One-tap answers for an agent that is waiting on you, read from its own question.
// Pure text in, plain strings out: the page shows them with textContent and sends them as a reply,
// so nothing the agent wrote is ever treated as HTML or run.
//
//   "Options: (a) convert to grams with a note, (b) keep the original text"  -> (a) …, (b) …
//   "1. Use Postgres\n2. Use SQLite"                                           -> 1 …, 2 …
//   "Grams or cups for flour?"                                                  -> Grams, Cups
//   "Should I open the PR now?"                                                 -> Yes, No
// With no choice to make, a waiting item gets "Go ahead".

const MAX = 4;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const tidy = (s) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[\s,;:.]+$/, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// [{ label, reply }]: label is what the button shows, reply is the message sent.
export function suggestions(summary = '', body = '') {
  const text = `${summary}\n${body}`.slice(0, 4000);
  const out = [];
  const add = (label, reply) => {
    if (out.length < MAX && label && !out.some((o) => o.reply === reply)) out.push({ label: clip(label, 34), reply });
  };

  // (a) … (b) …  or  a) … b) …
  const lettered = [...text.matchAll(/(?:^|[\s:;,])\(?([a-e])\)\s+([^\n]+?)(?=\s*(?:[,;]?\s*(?:or\s+)?\(?[a-e]\)\s)|[.?!]?\s*$|\n)/gim)];
  if (lettered.length >= 2) {
    for (const [, k, opt] of lettered) {
      const o = tidy(opt);
      if (o) add(`${k.toLowerCase()} · ${o}`, `(${k.toLowerCase()}) ${o}`);
    }
  }

  // 1. … / 2) … on their own lines
  if (!out.length) {
    const numbered = [...text.matchAll(/^\s*([1-9])[.)]\s+(.+)$/gm)];
    if (numbered.length >= 2 && numbered.length <= 6) {
      for (const [, n, opt] of numbered) {
        const o = tidy(opt);
        if (o) add(`${n} · ${o}`, `${n}. ${o}`);
      }
    }
  }

  // the last question: "X or Y?" and yes/no questions
  const question = (text.replace(/[*_`]/g, '').match(/[^.?!\n]*\?/g) || []).pop()?.trim() || ''; // Markdown marks would split words
  if (!out.length && question) {
    const or = question.match(/(?:^|\s)([\p{L}\p{N}][\p{L}\p{N}+#.-]*)\s+or\s+([\p{L}\p{N}][\p{L}\p{N}+#.-]*)/u);
    if (or) {
      add(cap(or[1]), `${cap(or[1])}.`);
      add(cap(or[2]), `${cap(or[2])}.`);
    } else if (/^(should|shall|can|could|may|do|does|did|is|are|want|ok|okay|proceed|continue|go)\b/i.test(question)) {
      add('Yes', 'Yes, go ahead.');
      add('No', 'No, hold off.');
    }
  }

  // nothing to choose between: a plain go-ahead (a choice needs an answer, not a go-ahead)
  if (!out.length) add('Go ahead', 'Go ahead.');
  return out;
}

// Things you often tell an agent, offered in the Reply box. Tapping one adds it to what you are typing.
export const QUICK_REPLIES = ['Go ahead', 'Run the tests', 'Open a PR', 'Explain more', 'Stop'];
