// One-tap answers for an agent that is waiting on you, read from its own question.
// Pure text in, plain strings out: the page shows them with textContent and sends them as a reply,
// so nothing the agent wrote is ever treated as HTML or run.
//
// Every button is a small icon and at most one word, like "Reply", so a row of them stays light and fits:
//   "Grams or cups for flour?"                                → ① Grams   ② Cups
//   "(a) convert to grams with a note, (b) keep the original" → ① Convert ② Keep   (sends "(a) convert …")
//   "1. Use Postgres\n2. Use SQLite"                          → ① Use     ② Use     (sends "1. Use Postgres")
//   "Should I open the PR now?"                               → ✓ Yes      ✕ No
//   anything else                                             → → Go
// The full message a button sends is its `reply`, shown on long-press.

const MAX = 4;
const NUMBERS = ['n1', 'n2', 'n3', 'n4']; // icon names: a circled number
const tidy = (s) => s.replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[\s,;:.]+$/, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// the first word of an option, as a button word
const firstWord = (s) => cap((tidy(s).match(/[\p{L}\p{N}][\p{L}\p{N}+#.-]*/u) || [''])[0].replace(/[.]+$/, '')).slice(0, 14);

// [{ icon, word, reply }]: icon is a name the page draws (see ICONS in app.js)
export function suggestions(summary = '', body = '') {
  const text = `${summary}\n${body}`.slice(0, 4000);
  const out = [];
  const add = (icon, word, reply) => {
    if (out.length < MAX && reply && !out.some((o) => o.reply === reply)) out.push({ icon, word, reply });
  };
  const choice = (word, reply) => add(NUMBERS[out.length], word, reply);

  // (a) … (b) …  or  a) … b) …
  const lettered = [...text.matchAll(/(?:^|[\s:;,])\(?([a-e])\)\s+([^\n]+?)(?=\s*(?:[,;]?\s*(?:or\s+)?\(?[a-e]\)\s)|[.?!]?\s*$|\n)/gim)];
  if (lettered.length >= 2) {
    for (const [, k, opt] of lettered) {
      const o = tidy(opt);
      if (o) choice(firstWord(o), `(${k.toLowerCase()}) ${o}`);
    }
  }

  // 1. … / 2) … on their own lines
  if (!out.length) {
    const numbered = [...text.matchAll(/^\s*([1-9])[.)]\s+(.+)$/gm)];
    if (numbered.length >= 2 && numbered.length <= 6) {
      for (const [, n, opt] of numbered) {
        const o = tidy(opt);
        if (o) choice(firstWord(o), `${n}. ${o}`);
      }
    }
  }

  // the last question: "X or Y?" and yes/no questions
  const question = (text.replace(/[*_`]/g, '').match(/[^.?!\n]*\?/g) || []).pop()?.trim() || ''; // Markdown marks would split words
  if (!out.length && question) {
    const or = question.match(/(?:^|\s)([\p{L}\p{N}][\p{L}\p{N}+#.-]*)\s+or\s+([\p{L}\p{N}][\p{L}\p{N}+#.-]*)/u);
    if (or) {
      choice(firstWord(or[1]), `${cap(or[1])}.`);
      choice(firstWord(or[2]), `${cap(or[2])}.`);
    } else if (/^(should|shall|can|could|may|do|does|did|is|are|want|ok|okay|proceed|continue|go)\b/i.test(question)) {
      add('yes', 'Yes', 'Yes, go ahead.');
      add('no', 'No', 'No, hold off.');
    }
  }

  // nothing to choose between: a plain go-ahead (a choice needs an answer, not a go-ahead)
  if (!out.length) add('go', 'Go', 'Go ahead.');
  return out;
}

// Things you often tell an agent, under every text box: a tap adds `text` to what you are typing.
export const QUICK_REPLIES = [
  { icon: 'go', word: 'Go', text: 'Go ahead' },
  { icon: 'test', word: 'Test', text: 'Run the tests' },
  { icon: 'pr', word: 'PR', text: 'Open a PR' },
  { icon: 'explain', word: 'More', text: 'Explain more' },
  { icon: 'stop', word: 'Stop', text: 'Stop' },
];
